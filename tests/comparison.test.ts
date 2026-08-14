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
import { ATOMIC_MODEL_PILOT_WORKFLOW } from "../apps/control-plane/src/atomic-model-pilot-coordinator.ts";
import { ATOMIC_MODEL_PILOT_TASK_ID } from "../apps/control-plane/src/atomic-model-pilot-lifecycle.ts";
import { DIRECT_CODEX_MODEL_WORKFLOW } from "../apps/control-plane/src/direct-model-pilot.ts";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

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

test("M6 comparison attaches exact Atomic/direct candidates and persists evidence-derived metrics", async () => {
  const root = mkdtempSync(join(tmpdir(), "control-plane-m6-compare-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Atomic Pilot"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects", "Atomic Pilot", "Project.md"), "# Atomic Pilot\n", "utf8");
  const store = new SqliteStore(":memory:");
  try {
    const createdAt = new Date().toISOString();
    await store.seedProjects([{
      id: "atomic-pilot", name: "Atomic Pilot", objective: "fixture", currentMilestone: "M6", health: "exploring",
      linearTeam: "FIX", repository: "fixture", vaultPath: "Projects/Atomic Pilot", memoryNamespace: "projects/atomic-pilot", createdAt,
    }]);
    await store.createTask({
      id: ATOMIC_MODEL_PILOT_TASK_ID, projectId: "atomic-pilot", source: "fixture", sourceId: "FIX-M5B-1",
      title: "Fixed comparison", objective: ATOMIC_FIXTURE_MODEL_REQUEST, status: "planned", priority: "normal", createdAt,
    });
    const candidates = [
      { id: "run_atomic_comparison", rootRuntime: "atomic" as const, workflow: ATOMIC_MODEL_PILOT_WORKFLOW, repairCount: 0 },
      { id: "run_codex_comparison", rootRuntime: "codex" as const, workflow: DIRECT_CODEX_MODEL_WORKFLOW, repairCount: 1 },
    ];
    for (const candidate of candidates) {
      await store.createRun({
        id: candidate.id, taskId: ATOMIC_MODEL_PILOT_TASK_ID, projectId: "atomic-pilot", rootRuntime: candidate.rootRuntime,
        workflow: candidate.workflow, status: "awaiting_approval", stage: "approval", stageIndex: 0,
        budgetUsd: 1, costUsd: 0, workspaceId: null, nativeRunId: null, nextActionAt: null,
        startedAt: createdAt, completedAt: null,
        metadata: { requestedObjective: ATOMIC_FIXTURE_MODEL_REQUEST, repairCount: candidate.repairCount }, createdAt,
      });
      await store.createArtifact({
        id: `artifact_${candidate.id}`, runId: candidate.id, kind: "candidate-patch",
        uri: `artifact://runs/${candidate.id}/candidate.patch`, checksum: "a".repeat(64), mediaType: "text/x-diff", createdAt,
      });
      await store.appendEvent({
        id: `event_${candidate.id}`, runId: candidate.id, type: "evidence.ready", message: "Evidence ready", payload: {}, createdAt,
      });
    }
    const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
    const stub = { isPilotRun: () => true } as any;
    const service = new ControlPlaneService(
      store, new LocalProjectBrain(brainRoot), workspaces,
      createMockAdapters(store, workspaces, join(root, "artifacts"), 0),
      { atomicModelPilot: stub, directModelPilot: stub },
    );
    const result = await service.compareRuns({
      projectId: "atomic-pilot", taskId: ATOMIC_MODEL_PILOT_TASK_ID, objective: ATOMIC_FIXTURE_MODEL_REQUEST,
      runtimes: ["atomic", "codex"], candidateRunIds: candidates.map((item) => item.id), idempotencyKey: "m6-fixed-comparison",
    });
    assert.ok("comparison" in result && "candidates" in result);
    assert.equal(result.comparison.status, "complete");
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map((item) => item.runtime), ["atomic", "codex"]);
    assert.deepEqual(result.candidates.map((item) => item.metrics?.correctness), ["passed", "passed"]);
    assert.deepEqual(result.candidates.map((item) => item.metrics?.defectsCaught), [0, 1]);
    assert.ok(result.candidates.every((item) => item.evidenceDigest?.length === 64));
    const replay = await service.compareRuns({
      projectId: "atomic-pilot", taskId: ATOMIC_MODEL_PILOT_TASK_ID, objective: ATOMIC_FIXTURE_MODEL_REQUEST,
      runtimes: ["atomic", "codex"], candidateRunIds: candidates.map((item) => item.id), idempotencyKey: "m6-fixed-comparison",
    });
    assert.equal(replay.comparisonId, result.comparisonId);
    assert.equal((await store.listComparisonCandidates(result.comparisonId)).length, 2);
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
