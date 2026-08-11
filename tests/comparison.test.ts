import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import { createMockAdapters } from "../apps/control-plane/src/mock-runtimes.ts";
import { ControlPlaneService } from "../apps/control-plane/src/service.ts";
import { JsonlLfDecoder, selectRuntimeEnvironment } from "../apps/control-plane/src/atomic-rpc-client.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "control-plane-compare-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Ovalo"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects", "Ovalo", "Project.md"), "# Ovalo\n", "utf8");
  const store = new SqliteStore(join(root, "test.sqlite"));
  await store.seedProjects([{
    id: "ovalo", name: "Ovalo", objective: "Language learning", currentMilestone: "Speaking MVP", health: "on_track",
    linearTeam: "OVA", repository: "ovalo/app", vaultPath: "Projects/Ovalo", memoryNamespace: "projects/ovalo"
  }]);
  const brain = new LocalProjectBrain(brainRoot);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const service = new ControlPlaneService(store, brain, workspaces, createMockAdapters(store, workspaces, join(root, "artifacts"), 0));
  return { root, store, service };
}

test("comparison launches isolated candidates with one shared comparison ID", async () => {
  const { root, store, service } = await setup();
  try {
    const result = await service.compareRuns({
      projectId: "ovalo",
      objective: "Implement and verify pronunciation feedback",
      runtimes: ["atomic", "codex", "claude"],
      perRunMaxCostUsd: 5
    });
    assert.equal(result.runs.length, 3);
    assert.equal(new Set(result.runs.map((run) => run.workspaceId)).size, 3);
    assert.equal((await store.listLeases()).length, 3);
    const groups = await Promise.all(result.runs.map(async (run) => (await service.getRun(run.id)).run.metadata.comparisonId));
    assert.deepEqual(new Set(groups), new Set([result.comparisonId]));
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("steering is retained as a normalized event", async () => {
  const { root, store, service } = await setup();
  try {
    const started = await service.startRun({ projectId: "ovalo", objective: "Implement a small verified change", runtime: "codex" });
    const runId = started.run.run.id;
    await service.steerRun(runId, "Preserve the public API");
    assert.ok((await store.listEvents(runId)).some((event) => event.type === "agent.message" && event.message.includes("Preserve the public API") && event.payload.simulated === true));
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("run creation replays the same idempotency key without another writer lease", async () => {
  const { root, store, service } = await setup();
  try {
    const input = {
      projectId: "ovalo",
      objective: "Implement an idempotent bounded change",
      runtime: "codex" as const,
      idempotencyKey: "run-create-1",
    };
    const [first, replay] = await Promise.all([service.startRun(input), service.startRun(input)]);
    assert.equal(replay.run.run.id, first.run.run.id);
    assert.equal((await store.listRuns()).length, 1);
    assert.equal((await store.listLeases()).length, 1);
    assert.equal(readdirSync(join(root, "workspaces")).length, 1);
    await assert.rejects(
      () => service.startRun({ ...input, objective: "A conflicting request" }),
      /Idempotency key/,
    );
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atomic RPC decoder splits on LF only", () => {
  const decoder = new JsonlLfDecoder();
  const record = JSON.stringify({ type: "event", text: `before\u2028after\u2029still-one-record` });
  const first = decoder.push(record.slice(0, 10));
  assert.deepEqual(first, []);
  const second = decoder.push(`${record.slice(10)}\n{\"type\":\"next\"}\r\n`);
  assert.equal(second.length, 2);
  assert.equal(JSON.parse(second[0]).text, "before\u2028after\u2029still-one-record");
  assert.equal(JSON.parse(second[1]).type, "next");
});


test("Atomic RPC child environment is allow-listed", () => {
  const env = selectRuntimeEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    SECRET_THAT_MUST_NOT_LEAK: "no",
    ALLOWED_TOKEN: "yes",
    ATOMIC_RUNTIME_ENV_ALLOWLIST: "ALLOWED_TOKEN"
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ALLOWED_TOKEN, "yes");
  assert.equal(env.SECRET_THAT_MUST_NOT_LEAK, undefined);
});
