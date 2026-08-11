import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { WriterLeaseSupervisor } from "../apps/control-plane/src/writer-lease-supervisor.ts";
import type { Run } from "../apps/control-plane/src/types.ts";

function runRecord(id: string): Run {
  return {
    id,
    projectId: "fixture",
    rootRuntime: "codex",
    workflow: "sandbox-fixture",
    status: "queued",
    stage: null,
    stageIndex: 0,
    budgetUsd: 1,
    costUsd: 0,
    workspaceId: null,
    nativeRunId: null,
    nextActionAt: null,
    startedAt: null,
    completedAt: null,
    metadata: {},
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

async function fixture(runId: string) {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-lease-supervisor-"));
  const store = new SqliteStore(join(root, "store.sqlite"), {
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });
  await store.seedProjects([{
    id: "fixture",
    name: "Fixture",
    objective: "Exercise lease supervision",
    currentMilestone: "M4",
    health: "on_track",
    linearTeam: "FIX",
    repository: "fixture/repo",
    vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture",
  }]);
  await store.createRun(runRecord(runId));
  const heartbeatAt = "2026-08-11T00:00:00.000Z";
  const created = await store.createWorkspaceLease({
    id: `ws_${runId}`,
    runId,
    path: join(root, "workspace"),
    provider: "fixture",
    status: "leased",
    createdAt: heartbeatAt,
  }, {
    workspaceId: `ws_${runId}`,
    runId,
    ownerId: `worker_${runId}`,
    mode: "writer",
    heartbeatAt,
    expiresAt: "2026-08-11T00:01:00.000Z",
  });
  return { root, store, lease: created.lease };
}

test("lease supervisor renews monotonically with the original fence", async () => {
  const item = await fixture("renew");
  try {
    let lost = false;
    const supervisor = new WriterLeaseSupervisor({
      store: item.store,
      lease: item.lease,
      heartbeatIntervalMs: 1_000,
      leaseTtlMs: 30_000,
      now: () => new Date("2026-08-11T00:00:10.000Z"),
      onLeaseLost: async () => { lost = true; },
    });
    await supervisor.pulse();
    const current = await item.store.getWorkspaceLease(item.lease.workspaceId);
    assert.equal(current?.heartbeatAt, "2026-08-11T00:00:10.000Z");
    assert.equal(current?.expiresAt, "2026-08-11T00:01:00.000Z");
    assert.equal(current?.fencingToken, item.lease.fencingToken);
    assert.equal(lost, false);
    supervisor.assertHealthy();
    await supervisor.stop();
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("a stale supervisor cannot renew a rotated lease and invokes loss handling once", async () => {
  const item = await fixture("stale");
  try {
    assert.equal(await item.store.releaseWorkspaceLease(item.lease), true);
    const successor = await item.store.rotateWorkspaceLease({
      workspaceId: item.lease.workspaceId,
      runId: item.lease.runId,
      ownerId: "worker_successor",
      mode: "writer",
      heartbeatAt: "2026-08-11T00:00:20.000Z",
      expiresAt: "2026-08-11T00:01:20.000Z",
    });
    let lossCalls = 0;
    let lossReason = "";
    const supervisor = new WriterLeaseSupervisor({
      store: item.store,
      lease: item.lease,
      now: () => new Date("2026-08-11T00:00:30.000Z"),
      onLeaseLost: async (reason) => { lossCalls += 1; lossReason = reason; },
    });
    await supervisor.pulse();
    await supervisor.pulse();
    assert.throws(() => supervisor.assertHealthy(), /fence_rejected/);
    assert.equal(lossCalls, 1);
    assert.equal(lossReason, "fence_rejected_or_lease_expired");
    const current = await item.store.getWorkspaceLease(item.lease.workspaceId);
    assert.equal(current?.ownerId, successor.ownerId);
    assert.equal(current?.fencingToken, successor.fencingToken);
    assert.equal(current?.heartbeatAt, successor.heartbeatAt);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("timer-driven loss callback failures are captured, retried, and never become unhandled rejections", async () => {
  const item = await fixture("timer_failure");
  try {
    item.store.renewWorkspaceLease = async () => null;
    let lossAttempts = 0;
    const supervisor = new WriterLeaseSupervisor({
      store: item.store,
      lease: item.lease,
      heartbeatIntervalMs: 25,
      leaseTtlMs: 5_000,
      onLeaseLost: async () => {
        lossAttempts += 1;
        throw new Error("injected stop/quarantine failure");
      },
    });
    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await assert.rejects(supervisor.stop(), /injected stop\/quarantine failure/);
    assert.ok(lossAttempts >= 2, "stop retries a failed timer-driven loss handler");
    assert.throws(() => supervisor.assertHealthy(), /injected stop\/quarantine failure/);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
