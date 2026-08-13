import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { PostgresStore } from "../apps/control-plane/src/postgres-store.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import { ControlPlaneService } from "../apps/control-plane/src/service.ts";
import {
  ATOMIC_MODEL_PILOT_APPROVAL_ACTION,
  ATOMIC_MODEL_PILOT_ARTIFACTS,
  ATOMIC_MODEL_PILOT_WORKFLOW,
  type AtomicModelPilotCoordinator,
} from "../apps/control-plane/src/atomic-model-pilot-coordinator.ts";
import {
  ATOMIC_MODEL_PILOT_TASK_ID,
  AtomicModelPilotLifecycleCoordinator,
} from "../apps/control-plane/src/atomic-model-pilot-lifecycle.ts";
import { ATOMIC_FIXTURE_PROJECT_ID } from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";
import { exportGovernedArtifacts } from "../apps/control-plane/src/governed-artifact-export.ts";
import { WriterSandboxBoundary } from "../apps/control-plane/src/writer-sandbox-boundary.ts";
import { WriterWorkspaceManager } from "../apps/control-plane/src/writer-workspace.ts";
import type { Artifact, Project, Run } from "../apps/control-plane/src/types.ts";
import type { ControlPlaneStore, WorkspaceLease } from "../apps/control-plane/src/store.ts";

const IMAGE = `fixture.invalid/model@sha256:${"a".repeat(64)}`;
const POLICY = "b".repeat(64);

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

class MutableClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = () => new Date(this.value);
  advance(ms: number) { this.value += ms; }
}

function writeArtifactBodies(workspace: string): void {
  for (const item of ATOMIC_MODEL_PILOT_ARTIFACTS) {
    const path = join(workspace, ...item.relativePath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const body = item.mediaType === "text/x-diff"
      ? "diff --git a/src/normalize-project-slug.js b/src/normalize-project-slug.js\n"
      : `${JSON.stringify({ schema_version: "test", kind: item.kind })}\n`;
    writeFileSync(path, body, { mode: 0o600 });
  }
}

async function completeSandbox(store: ControlPlaneStore, run: Run, root: string, clock: MutableClock): Promise<{
  artifacts: Artifact[];
  capabilityId: string;
}> {
  const workspacePath = join(root, `workspace-${run.id}`);
  mkdirSync(workspacePath, { mode: 0o700 });
  const workspaceId = `ws_${hash(run.id).slice(0, 24)}`;
  const leaseResult = await store.createWorkspaceLease({
    id: workspaceId,
    runId: run.id,
    path: workspacePath,
    provider: "isolated-git-worktree",
    status: "leased",
    createdAt: clock.now().toISOString(),
  }, {
    workspaceId,
    runId: run.id,
    ownerId: "atomic_model_test",
    mode: "writer",
    heartbeatAt: clock.now().toISOString(),
    expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
  });
  const lease: WorkspaceLease = leaseResult.lease;
  const common = {
    runId: run.id,
    workspaceId,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  };
  await store.createSandboxInstance({
    runId: run.id,
    workspaceId,
    leaseOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    provider: "docker-compatible",
    imageRef: IMAGE,
    policyHash: POLICY,
    workspaceDigest: "c".repeat(64),
    contextDigest: "d".repeat(64),
    contextContentHash: "e".repeat(64),
    workdirDigest: "f".repeat(64),
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
  });
  await store.transitionSandboxInstance({ ...common, expectedState: "provisioning", state: "ready", engineId: "1".repeat(64), updatedAt: clock.now().toISOString() });
  await store.transitionSandboxInstance({ ...common, expectedState: "ready", state: "running", updatedAt: clock.now().toISOString() });

  const source = join(root, `artifact-source-${run.id}`);
  mkdirSync(source, { mode: 0o700 });
  writeArtifactBodies(source);
  const exports = exportGovernedArtifacts(ATOMIC_MODEL_PILOT_ARTIFACTS, {
    workspacePath: source,
    artifactRoot: join(root, "artifacts"),
    runId: run.id,
  });
  const artifacts: Artifact[] = exports.map((item) => ({
    id: `artifact_model_${hash(`${run.id}\0${item.sourceRelativePath}`).slice(0, 24)}`,
    runId: run.id,
    kind: item.kind,
    uri: `artifact://runs/${encodeURIComponent(run.id)}/${item.sourceRelativePath.split("/").map(encodeURIComponent).join("/")}`,
    checksum: item.checksum,
    mediaType: item.mediaType,
    createdAt: clock.now().toISOString(),
  }));
  await store.createArtifactBatch(artifacts);
  const capabilityId = `icap_${hash(run.id).slice(0, 24)}`;
  await store.createInferenceCapability({
    id: capabilityId,
    runId: run.id,
    projectId: run.projectId,
    workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
    tokenHash: hash(`token-${run.id}`),
    provider: "fake-prelive",
    model: "fake-model",
    api: "openai-completions",
    roles: ["implementer", "verifier_initial", "repair", "verifier_final"],
    maxRequests: 16,
    maxInputTokens: 32_000,
    maxOutputTokens: 8_000,
    maxCostMicros: 1_000_000,
    maxElapsedMs: 240_000,
    issuedAt: clock.now().toISOString(),
    expiresAt: new Date(clock.now().getTime() + 10 * 60_000).toISOString(),
    state: "active",
    policyHash: "2".repeat(64),
  });
  for (const [index, role] of (["implementer", "verifier_initial", "verifier_final"] as const).entries()) {
    const requestId = `ireq_${hash(`${run.id}\0${role}`).slice(0, 24)}`;
    await store.reserveInferenceRequest({
      id: requestId,
      tokenHash: hash(`token-${run.id}`),
      runId: run.id,
      role,
      requestHash: String(index + 3).repeat(64),
    });
    await store.completeInferenceRequest({
      id: requestId,
      state: "completed",
      providerRequestId: `provider_${role}`,
      responseHash: String(index + 6).repeat(64),
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 20,
    });
  }
  const secondImplementer = `ireq_${hash(`${run.id}\0implementer\0second`).slice(0, 24)}`;
  await store.reserveInferenceRequest({
    id: secondImplementer, tokenHash: hash(`token-${run.id}`), runId: run.id,
    role: "implementer", requestHash: "9".repeat(64),
  });
  await store.completeInferenceRequest({
    id: secondImplementer, state: "completed", providerRequestId: "provider_implementer_second",
    responseHash: "a".repeat(64), inputTokens: 10, outputTokens: 5, costMicros: 20,
  });
  await store.revokeInferenceCapability(capabilityId, clock.now().toISOString());
  const snapshot = exports.map((item) => ({
    relativePath: item.sourceRelativePath,
    kind: item.kind,
    mediaType: item.mediaType,
    checksum: item.checksum,
    sizeBytes: item.sizeBytes,
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const current = (await store.getRun(run.id))!;
  await store.updateRun(run.id, {
    status: "running",
    stage: "evidence_ready",
    startedAt: clock.now().toISOString(),
    metadata: {
      ...current.metadata,
      atomicModelFrozenExportsValidated: true,
      atomicModelValidatedWorkspaceArtifacts: snapshot,
      atomicModelFrozenExportArtifacts: snapshot,
      atomicModelCapabilityId: capabilityId,
      atomicModelPolicySha256: "2".repeat(64),
      repairCount: 0,
      nativeInputTokens: 40,
      nativeOutputTokens: 20,
      nativeCostMicros: 80,
      nativeSessionId: "native-session",
      nativeWorkflowRunId: "native-workflow",
      liveProviderVerified: false,
      externalActionPerformed: false,
    },
  });
  await store.transitionSandboxInstance({ ...common, expectedState: "running", state: "freezing", updatedAt: clock.now().toISOString() });
  await store.transitionSandboxInstance({ ...common, expectedState: "freezing", state: "exporting", updatedAt: clock.now().toISOString() });
  await store.updateWorkspaceStatus(workspaceId, "released");
  await store.releaseWorkspaceLease({
    workspaceId,
    runId: run.id,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  });
  await store.transitionSandboxInstance({ ...common, expectedState: "exporting", state: "cleaned", updatedAt: clock.now().toISOString() });
  rmSync(workspacePath, { recursive: true });
  rmSync(source, { recursive: true });
  return { artifacts, capabilityId };
}

async function fixture(backend: "sqlite" | "postgres" = "sqlite") {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-model-lifecycle-"));
  const clock = new MutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = backend === "postgres"
    ? await PostgresStore.connect({
      databaseUrl: process.env.TEST_DATABASE_URL!, autoMigrate: true, maxConnections: 4, now: clock.now,
    })
    : new SqliteStore(":memory:", { now: clock.now });
  if (backend === "postgres") await store.resetOperationalData();
  const project: Project = {
    id: ATOMIC_FIXTURE_PROJECT_ID,
    name: "Atomic Pilot",
    objective: "fixture",
    currentMilestone: "M5b",
    health: "exploring",
    linearTeam: "FIX",
    repository: "fixture",
    vaultPath: "Projects/Atomic Pilot",
    memoryNamespace: "projects/atomic-pilot",
    createdAt: clock.now().toISOString(),
  };
  await store.seedProjects([{ ...project }]);
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects/Atomic Pilot/Decisions"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects/Atomic Pilot/Decisions/accepted.md"), [
    "---", "id: accepted", "type: decision", "status: accepted", "authority: canonical", "project: atomic-pilot", "---",
    "# Accepted fixture", "", "Use the literal disposable test contract.", "",
  ].join("\n"));
  const brain = new LocalProjectBrain(brainRoot);
  const artifactRoot = join(root, "artifacts");
  mkdirSync(artifactRoot, { mode: 0o700 });
  const provider = {
    contract: () => ({ provider: "docker-compatible", imageRef: IMAGE, policyHash: POLICY }),
    preflight: async () => ({ enabled: true, available: true, engine: "fake" }),
    reconcileOrphans: async () => [],
  } as any;
  const boundary = new WriterSandboxBoundary({
    store,
    workspaces: new WriterWorkspaceManager({ store, root: join(root, "writer"), gitCommand: "/usr/bin/git", now: clock.now }),
    provider,
    artifactRoot,
    ownerId: "atomic_model_lifecycle_test",
    now: clock.now,
  });
  const executor = {
    preflight: async () => ({
      enabled: true,
      available: true,
      workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
      executionMode: "isolated-writer",
      modelExecutionAttempted: false,
      liveProviderExpected: false,
      runner: {
        enabled: true,
        available: true,
        atomicVersion: "0.9.12",
        imageRef: IMAGE,
        imageDigest: IMAGE.slice(IMAGE.indexOf("@") + 1),
        provenanceDigest: "3".repeat(64),
        provenanceLabels: { "io.valkyrie.atomic.version": "0.9.12" },
      },
    }),
    contextExists: () => false,
    cleanupContext: () => undefined,
    run: async ({ run }: { run: Run }) => {
      const completed = await completeSandbox(store, run, root, clock);
      return {
        boundary: {
          runId: run.id,
          workspaceId: (await store.getWorkspaceForRun(run.id))!.id,
          fencingToken: 1,
          baseCommit: "4".repeat(40),
          branchName: "agent/model",
          execution: { exitCode: 0, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 },
          exports: [],
          artifacts: completed.artifacts,
          completion: "evidence_ready",
        },
        native: {
          nativeSessionId: "native-session",
          nativeWorkflowRunId: "native-workflow",
          nativeCursor: "cursor",
          output: { repair_count: 0 },
        },
        capabilityId: completed.capabilityId,
        liveProviderVerified: false,
      };
    },
  } as unknown as AtomicModelPilotCoordinator;
  const lifecycle = new AtomicModelPilotLifecycleCoordinator({
    store,
    brain,
    boundary,
    executor,
    maxCostUsd: 1,
    approvalTtlMs: 60_000,
    now: clock.now,
  });
  await lifecycle.bootstrap();
  const service = new ControlPlaneService(
    store,
    brain,
    new WorkspaceManager(store, join(root, "legacy-workspaces")),
    new Map(),
    { now: clock.now, atomicModelPilot: lifecycle },
  );
  return { root, clock, store, lifecycle, service, brain, boundary, executor, project };
}

function startInput(key: string) {
  return {
    projectId: ATOMIC_FIXTURE_PROJECT_ID,
    taskId: ATOMIC_MODEL_PILOT_TASK_ID,
    objective: ATOMIC_FIXTURE_MODEL_REQUEST,
    runtime: "atomic" as const,
    workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
    maxCostUsd: 1,
    idempotencyKey: key,
    approvalPolicy: { preparePr: "human" as const },
  };
}

test("Atomic model lifecycle reaches evidence-bound review and records only a safe mock acceptance", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun(startInput("model-lifecycle-success"));
    const replay = await item.service.startRun(startInput("model-lifecycle-success"));
    assert.equal(replay.run.run.id, started.run.run.id);
    await item.lifecycle.wait(started.run.run.id);
    const detail = await item.service.getRun(started.run.run.id);
    assert.equal(detail.run.status, "awaiting_approval");
    assert.equal(detail.artifacts.length, ATOMIC_MODEL_PILOT_ARTIFACTS.length);
    assert.equal(detail.approvals.length, 1);
    assert.equal(detail.approvals[0].action, ATOMIC_MODEL_PILOT_APPROVAL_ACTION);
    const proposals = (await item.service.listMemoryProposals()).filter((proposal) => proposal.runId === detail.run.id);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].state, "proposed");
    const read = await item.service.readAtomicModelFixtureArtifact(detail.run.id, detail.artifacts[0].id);
    assert.equal(read.checksum, detail.artifacts[0].checksum);
    assert.equal(read.evidenceDigest, detail.approvals[0].evidenceDigest);
    await item.service.resolveAtomicModelFixtureApproval(detail.approvals[0].id, "approve", "wesley-local-operator");
    const accepted = await item.service.getRun(detail.run.id);
    assert.equal(accepted.run.status, "completed");
    assert.equal(accepted.run.stage, "accepted_mock_final_action");
    assert.equal(accepted.run.costUsd, 0.00008);
    assert.equal(accepted.run.metadata.safeMockAcceptanceReceipt, true);
    assert.equal(accepted.run.metadata.externalActionPerformed, false);
    assert.equal(accepted.run.metadata.liveProviderVerified, false);
    assert.equal(accepted.run.metadata.liveProviderExpected, false);
    assert.equal((await item.store.getMemoryProposal(proposals[0].id))?.state, "proposed");
    assert.equal((await item.store.getInferenceCapability(String(accepted.run.metadata.atomicModelCapabilityId)))?.state, "revoked");
  } finally {
    await item.lifecycle.shutdown();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic model approval expires during uptime and cancellation cannot resurrect it", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun(startInput("model-lifecycle-expiry"));
    await item.lifecycle.wait(started.run.run.id);
    const detail = await item.service.getRun(started.run.run.id);
    const orphanRun: Run = {
      ...detail.run,
      id: "run_model_expired_capability",
      status: "failed",
      stage: "prelive_fixture",
      workspaceId: null,
      completedAt: item.clock.now().toISOString(),
      metadata: {},
      createdAt: item.clock.now().toISOString(),
    };
    await item.store.createRun(orphanRun);
    await item.store.createInferenceCapability({
      id: "icap_model_expiry_maintenance",
      runId: orphanRun.id,
      projectId: orphanRun.projectId,
      workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
      tokenHash: hash("expiry-maintenance-token"),
      provider: "fake-prelive",
      model: "fake-model",
      api: "openai-completions",
      roles: ["implementer", "verifier_initial", "repair", "verifier_final"],
      maxRequests: 16,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxCostMicros: 100,
      maxElapsedMs: 1_000,
      issuedAt: item.clock.now().toISOString(),
      expiresAt: new Date(item.clock.now().getTime() + 60_000).toISOString(),
      state: "active",
      policyHash: "9".repeat(64),
    });
    item.clock.advance(60_001);
    await item.service.tick();
    const expired = await item.service.getRun(detail.run.id);
    assert.equal(expired.run.status, "failed");
    assert.equal(expired.run.stage, "approval_expired");
    assert.equal((await item.store.getApproval(detail.approvals[0].id))?.state, "denied");
    assert.equal((await item.store.getInferenceCapability("icap_model_expiry_maintenance"))?.state, "expired");
    await assert.rejects(
      item.service.resolveAtomicModelFixtureApproval(detail.approvals[0].id, "approve", "wesley-local-operator"),
      /conflicts|expired|already/i,
    );
    await item.service.cancelRun(detail.run.id, "wesley-local-operator");
    assert.equal((await item.store.getRun(detail.run.id))?.status, "failed");
  } finally {
    await item.lifecycle.shutdown();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic model startup recovers cleaned evidence and creates the exact approval once", async () => {
  const item = await fixture();
  try {
    const run: Run = {
      id: "run_model_restart_recovery",
      projectId: ATOMIC_FIXTURE_PROJECT_ID,
      taskId: ATOMIC_MODEL_PILOT_TASK_ID,
      rootRuntime: "atomic",
      workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
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
      metadata: { adapter: "atomic-model-pilot", crossProcessResume: false, externalActionPerformed: false },
      createdAt: item.clock.now().toISOString(),
    };
    await item.store.createRun(run);
    await completeSandbox(item.store, run, item.root, item.clock);
    assert.equal((await item.store.listApprovals("pending")).filter((approval) => approval.runId === run.id).length, 0);
    const result = await item.lifecycle.reconcileStartup();
    assert.equal(result.approvalsRecovered, 1);
    const recovered = await item.service.getRun(run.id);
    assert.equal(recovered.run.status, "awaiting_approval");
    assert.equal(recovered.approvals.length, 1);
    assert.equal(recovered.approvals[0].action, ATOMIC_MODEL_PILOT_APPROVAL_ACTION);
    await item.lifecycle.reconcileStartup();
    assert.equal((await item.store.listApprovals("pending")).filter((approval) => approval.runId === run.id).length, 1);
  } finally {
    await item.lifecycle.shutdown();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic model admission is durable and cancellation closes the bound gate", async () => {
  const item = await fixture();
  try {
    const first = await item.service.startRun(startInput("model-admission-first"));
    await item.lifecycle.wait(first.run.run.id);
    await assert.rejects(
      item.service.startRun(startInput("model-admission-second")),
      /admission|nonterminal|active/i,
    );
    const detail = await item.service.getRun(first.run.run.id);
    await item.service.cancelRun(detail.run.id, "wesley-local-operator");
    const cancelled = await item.service.getRun(detail.run.id);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal((await item.store.getApproval(detail.approvals[0].id))?.decision, "cancelled");
    await assert.rejects(
      item.service.resolveAtomicModelFixtureApproval(detail.approvals[0].id, "approve", "wesley-local-operator"),
      /conflict|different|already/i,
    );
    const second = await item.service.startRun(startInput("model-admission-after-cancel"));
    assert.notEqual(second.run.run.id, first.run.run.id);
    await item.lifecycle.wait(second.run.run.id);
  } finally {
    await item.lifecycle.shutdown();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic model approval fails closed when governed artifact bytes change after export", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun(startInput("model-artifact-tamper"));
    await item.lifecycle.wait(started.run.run.id);
    const detail = await item.service.getRun(started.run.run.id);
    const patch = ATOMIC_MODEL_PILOT_ARTIFACTS.find((candidate) => candidate.kind === "candidate-patch")!;
    writeFileSync(join(item.root, "artifacts", detail.run.id, ...patch.relativePath.split("/")), "tampered\n");
    const artifact = detail.artifacts.find((candidate) => candidate.kind === patch.kind)!;
    await assert.rejects(
      item.service.readAtomicModelFixtureArtifact(detail.run.id, artifact.id),
      /unavailable|no longer matches/i,
    );
    await assert.rejects(
      item.service.resolveAtomicModelFixtureApproval(detail.approvals[0].id, "approve", "wesley-local-operator"),
      /bytes|evidence|match/i,
    );
    assert.equal((await item.store.getApproval(detail.approvals[0].id))?.state, "pending");
    assert.equal((await item.store.getRun(detail.run.id))?.status, "awaiting_approval");
  } finally {
    await item.lifecycle.shutdown();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic model execution failure becomes terminal without approval or external action", async () => {
  const item = await fixture();
  try {
    (item.executor as any).run = async () => { throw new Error("synthetic provider boundary failure"); };
    const started = await item.service.startRun(startInput("model-execution-failure"));
    await assert.rejects(item.lifecycle.wait(started.run.run.id), /synthetic provider boundary failure/);
    const failed = await item.service.getRun(started.run.run.id);
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.run.stage, "atomic_model_failed");
    assert.equal(failed.approvals.length, 0);
    assert.equal(failed.run.metadata.externalActionPerformed, false);
  } finally {
    await item.lifecycle.shutdown();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("PostgreSQL runs the same Atomic model lifecycle through evidence-bound safe acceptance", {
  skip: process.env.RUN_POSTGRES_MODEL_LIFECYCLE_TESTS !== "1" ? "set RUN_POSTGRES_MODEL_LIFECYCLE_TESTS=1 with a disposable TEST_DATABASE_URL" : false,
}, async () => {
  const item = await fixture("postgres");
  try {
    const started = await item.service.startRun(startInput("postgres-model-lifecycle"));
    await item.lifecycle.wait(started.run.run.id);
    const detail = await item.service.getRun(started.run.run.id);
    assert.equal(detail.run.status, "awaiting_approval");
    assert.equal(detail.artifacts.length, ATOMIC_MODEL_PILOT_ARTIFACTS.length);
    assert.equal(detail.approvals.length, 1);
    await item.service.resolveAtomicModelFixtureApproval(detail.approvals[0].id, "approve", "postgres-test-operator");
    const accepted = await item.service.getRun(detail.run.id);
    assert.equal(accepted.run.status, "completed");
    assert.equal(accepted.run.metadata.safeMockAcceptanceReceipt, true);
    assert.equal(accepted.run.metadata.externalActionPerformed, false);
  } finally {
    await item.lifecycle.shutdown();
    await item.store.resetOperationalData();
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
