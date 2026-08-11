import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import { createMockAdapters } from "../apps/control-plane/src/mock-runtimes.ts";
import { ControlPlaneService } from "../apps/control-plane/src/service.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "control-plane-test-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Ovalo", "Decisions"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects", "Ovalo", "Decisions", "ADR.md"), "---\nauthority: canonical\nstatus: accepted\n---\n# Decision\nUse bounded evidence.\n");
  const store = new SqliteStore(join(root, "test.sqlite"));
  await store.seedProjects([
    {
      id: "ovalo", name: "Ovalo", objective: "Language learning", currentMilestone: "Speaking MVP", health: "on_track",
      linearTeam: "OVA", repository: "ovalo/app", vaultPath: "Projects/Ovalo", memoryNamespace: "projects/ovalo"
    },
    {
      id: "other", name: "Other", objective: "Isolation fixture", currentMilestone: "Fixture", health: "on_track",
      linearTeam: "OTH", repository: "other/app", vaultPath: "Projects/Other", memoryNamespace: "projects/other"
    },
  ]);
  const brain = new LocalProjectBrain(brainRoot);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const adapters = createMockAdapters(store, workspaces, join(root, "artifacts"), 0);
  const service = new ControlPlaneService(store, brain, workspaces, adapters);
  return { root, brainRoot, store, service };
}

async function tickUntil(service: ControlPlaneService, predicate: () => Promise<boolean>, limit = 30) {
  for (let i = 0; i < limit; i++) {
    await service.tick();
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("Condition not reached");
}

test("Atomic lifecycle requires approval and creates governed memory proposal", async () => {
  const { root, brainRoot, store, service } = await setup();
  try {
    const started = await service.startRun({ projectId: "ovalo", objective: "Implement a verified pronunciation improvement", runtime: "atomic", maxCostUsd: 8 });
    const runId = started.run.run.id;
    await tickUntil(service, async () => (await store.getRun(runId))?.status === "awaiting_approval");
    const approval = (await store.listApprovals("pending"))[0];
    assert.ok(approval);
    assert.match(approval.exactEffect, /SIMULATED/);
    assert.ok(approval.evidence.some((item) => item.includes("SIMULATED")));
    assert.equal((await store.listLeases()).length, 1);
    await assert.rejects(
      () => service.resolveApproval(approval.id, "approve_eventually"),
      /decision must be approve, deny, or request_changes/,
    );
    assert.equal((await store.getApproval(approval.id))?.state, "pending");
    await Promise.all([
      service.resolveApproval(approval.id, "approve"),
      service.resolveApproval(approval.id, "approve"),
    ]);
    await assert.rejects(() => service.resolveApproval(approval.id, "deny"), /different decision/);
    await tickUntil(service, async () => (await store.getRun(runId))?.status === "completed");
    assert.equal((await store.getRun(runId))?.status, "completed");
    assert.equal((await store.listLeases()).length, 0);
    assert.ok((await store.listArtifacts(runId)).length >= 3);
    assert.ok((await store.listEvents(runId)).every((event) => event.type === "approval.decision_recorded" || event.payload.simulated === true));
    const proposals = await store.listMemoryProposals("proposed");
    assert.equal(proposals.length, 1);
    const result = await service.resolveMemoryProposal(proposals[0].id, "promote");
    assert.equal(result?.state, "promoted");
    assert.ok(result?.targetNote);
    const promotedPath = join(brainRoot, String(result?.targetNote));
    assert.ok(existsSync(promotedPath));
    assert.match(readFileSync(promotedPath, "utf8"), /simulated lifecycle and review lesson/i);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("run and memory inputs cannot cross project boundaries", async () => {
  const { root, store, service } = await setup();
  try {
    await store.createTask({
      id: "task_other",
      projectId: "other",
      source: "test",
      sourceId: null,
      title: "Other project task",
      objective: "Remain isolated",
      status: "planned",
      priority: "normal",
      createdAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => service.startRun({ projectId: "ovalo", taskId: "task_other", objective: "Cross project run", runtime: "codex" }),
      /does not belong/,
    );

    const started = await service.startRun({ projectId: "ovalo", objective: "Project-scoped run", runtime: "codex" });
    await assert.rejects(
      () => service.proposeMemory({ projectId: "other", runId: started.run.run.id, claim: "A cross-project claim must be rejected" }),
      /does not belong/,
    );
    await service.cancelRun(started.run.run.id);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation fails an unconfirmed queued run", async () => {
  const { root, store, service } = await setup();
  try {
    await store.createRun({
      id: "run_interrupted_start",
      projectId: "ovalo",
      rootRuntime: "atomic",
      workflow: "issue-to-pr-pilot",
      status: "queued",
      stage: null,
      stageIndex: 0,
      budgetUsd: 8,
      costUsd: 0,
      workspaceId: null,
      nativeRunId: null,
      nextActionAt: null,
      startedAt: null,
      completedAt: null,
      metadata: { requestedObjective: "Interrupted start" },
      createdAt: new Date().toISOString(),
    });
    const result = await service.reconcileStartup();
    assert.equal(result.queuedRunsFailed, 1);
    assert.equal((await store.getRun("run_interrupted_start"))?.status, "failed");
    assert.ok((await store.listEvents("run_interrupted_start")).some((event) => event.payload.reconciliation === true));
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation never replays approval after writer-lease quarantine", async () => {
  const { root, store, service } = await setup();
  try {
    const started = await service.startRun({
      projectId: "ovalo",
      objective: "Reach an approval before an interrupted restart",
      runtime: "atomic",
    });
    const runId = started.run.run.id;
    await tickUntil(service, async () => (await store.getRun(runId))?.status === "awaiting_approval");
    const approval = (await store.listApprovals("pending")).find((item) => item.runId === runId);
    assert.ok(approval);
    await store.resolveApprovalTransaction({
      approvalId: approval.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "restart-fixture",
    });
    const run = await store.getRun(runId);
    assert.ok(run?.workspaceId);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    assert.equal(await store.heartbeatLease(run.workspaceId, run.id, expiredAt, expiredAt), true);

    const result = await service.reconcileStartup();
    const reconciled = await store.getRun(runId);
    assert.equal(reconciled?.status, "failed");
    assert.equal(reconciled?.stage, "workspace_quarantined");
    assert.equal((await store.listLeases()).length, 0);
    assert.equal(result.strandedApprovalsRecovered, 0);
    assert.equal(result.strandedApprovalsNeedingAttention, 1);
    assert.ok((await store.listEvents(runId)).every((event) => !event.message.includes("execution resumed")));
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idea capture detects an exact duplicate", async () => {
  const { root, store, service } = await setup();
  try {
    const first = await service.captureIdea({ projectId: "ovalo", title: "Generate a listening lesson from a short-form video" });
    const second = await service.captureIdea({ projectId: "ovalo", title: "Generate a listening lesson from a short-form video" });
    assert.equal(first.status, "created");
    assert.equal(second.status, "duplicate");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
