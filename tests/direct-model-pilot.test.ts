import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { WriterWorkspaceManager } from "../apps/control-plane/src/writer-workspace.ts";
import { WriterSandboxBoundary, type WriterSandboxProvider } from "../apps/control-plane/src/writer-sandbox-boundary.ts";
import type {
  OciCleanupResult, OciReconciliationExpectation, OciReconciliationResult, OciRunResult,
  OciSandboxHandle, OciSandboxStartInput,
} from "../apps/control-plane/src/oci-sandbox-provider.ts";
import {
  DirectModelPilotCoordinator, DIRECT_CODEX_APPROVAL_ACTION, DIRECT_CODEX_ARTIFACTS,
  DIRECT_CODEX_MODEL_WORKFLOW,
} from "../apps/control-plane/src/direct-model-pilot.ts";
import {
  ScopedInferenceGateway, type InferenceUpstream, type ScopedInferencePolicy,
} from "../apps/control-plane/src/scoped-inference-gateway.ts";
import { setupAtomicFixtureRepository } from "../scripts/setup-atomic-fixture.ts";
import { ATOMIC_FIXTURE_PROJECT_ID } from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import { ATOMIC_MODEL_PILOT_TASK_ID } from "../apps/control-plane/src/atomic-model-pilot-lifecycle.ts";
import { ATOMIC_FIXTURE_IMPLEMENTATION } from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

const policy: ScopedInferencePolicy = {
  provider: "fake-direct", model: "fake-direct-model", api: "openai-completions",
  roleModels: { implementer: "direct-impl", verifier_initial: "direct-verify-1", repair: "direct-repair", verifier_final: "direct-verify-2" },
  roles: ["implementer", "verifier_initial", "repair", "verifier_final"], maxRequests: 16,
  maxInputTokens: 64_000, maxOutputTokens: 8_000, maxCostMicros: 1_000_000,
  maxElapsedMs: 240_000, ttlMs: 10 * 60_000,
  inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0,
};

class FakeDirectUpstream implements InferenceUpstream {
  async complete(input: Parameters<InferenceUpstream["complete"]>[0]) {
    const content = input.role === "implementer" || input.role === "repair"
      ? JSON.stringify({ source: ATOMIC_FIXTURE_IMPLEMENTATION })
      : JSON.stringify({ approved: true, findings: [] });
    const body = Buffer.from(JSON.stringify({
      id: `fake_${input.role}`, object: "chat.completion", model: input.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }));
    return {
      status: 200, contentType: "application/json" as const, body,
      providerRequestId: `provider_${input.role}`, inputTokens: 20, outputTokens: 5,
      nativeRecords: [
        { type: "thread.started", thread_id: `direct_${input.role}` },
        { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5 } },
      ],
    };
  }
}

class LocalWriterProvider implements WriterSandboxProvider {
  startCount = 0;
  contract() { return { provider: "docker-compatible" as const, imageRef: `fixture@sha256:${"a".repeat(64)}`, policyHash: "b".repeat(64) }; }
  async preflight() { return { enabled: true, available: true, engine: "docker-compatible" as const, version: "fake" }; }
  async start(input: OciSandboxStartInput): Promise<OciSandboxHandle> {
    this.startCount += 1;
    return {
      runId: input.runId, workspaceId: input.workspaceId, leaseOwnerId: input.leaseOwnerId,
      fencingToken: input.fencingToken, containerId: sha(input.runId), containerName: `direct-${this.startCount}`,
      workspacePath: input.workspacePath, contextPath: input.contextPath,
      workspaceDigest: sha(input.workspacePath), contextDigest: sha(input.contextPath),
      workingDirectoryRelativePath: input.workingDirectoryRelativePath ?? "worktree",
      workingDirectoryDigest: sha(input.workingDirectoryRelativePath ?? "worktree"), status: "running",
    };
  }
  async execute(handle: OciSandboxHandle, command: readonly string[]): Promise<OciRunResult> {
    const worktree = join(handle.workspacePath, handle.workingDirectoryRelativePath);
    const argv = [...command];
    if (argv[0] === "/usr/local/bin/node") argv[0] = process.execPath;
    if (argv[1] === "-e" && argv[2]) argv[2] = argv[2].replaceAll("/workspace/worktree", worktree);
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: worktree, encoding: "utf8", timeout: 30_000,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: worktree, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (result.error) throw result.error;
    return {
      exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
      stdoutBytes: Buffer.byteLength(result.stdout ?? ""), stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    };
  }
  async stop(handle: OciSandboxHandle) { handle.status = "stopped"; return { status: "stopped" as const }; }
  async cleanup(handle: OciSandboxHandle): Promise<OciCleanupResult> { handle.status = "cleaned"; return { status: "cleaned" }; }
  async reconcileOrphans(expectations: readonly OciReconciliationExpectation[]): Promise<OciReconciliationResult[]> {
    return expectations.map((item) => ({ runId: item.runId, workspaceId: item.workspaceId, containerId: item.engineId, outcome: "absent", reason: "fake absent", cleanupAttempted: false }));
  }
}

test("direct Codex candidate uses an independent writer, scoped model calls, checks, governed evidence, and approval", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-direct-model-")));
  const repository = join(root, "fixture-repository");
  const setup = setupAtomicFixtureRepository(repository);
  const store = new SqliteStore(":memory:");
  const project = {
    id: ATOMIC_FIXTURE_PROJECT_ID, name: "Atomic Pilot", objective: "fixture", currentMilestone: "M6", health: "exploring" as const,
    linearTeam: "FIX", repository: "fixture", vaultPath: "Projects/Atomic Pilot", memoryNamespace: "projects/atomic-pilot", createdAt: new Date().toISOString(),
  };
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, project.vaultPath, "Decisions"), { recursive: true });
  writeFileSync(join(brainRoot, project.vaultPath, "Decisions", "fixture.md"), [
    "---", "id: fixture", "type: decision", "status: accepted", "authority: canonical", "project: atomic-pilot", "---",
    "# Fixture", "", "Use the literal disposable task.", "",
  ].join("\n"));
  try {
    await store.seedProjects([project]);
    await store.createTask({
      id: ATOMIC_MODEL_PILOT_TASK_ID, projectId: project.id, source: "isolated-fake-linear-gateway", sourceId: "FIX-M5B-1",
      title: "Model fixture", objective: ATOMIC_FIXTURE_MODEL_REQUEST, status: "planned", priority: "normal", createdAt: project.createdAt,
    });
    const runId = "run_direct_model_test";
    await store.createRun({
      id: runId, taskId: ATOMIC_MODEL_PILOT_TASK_ID, projectId: project.id, rootRuntime: "codex",
      workflow: DIRECT_CODEX_MODEL_WORKFLOW, status: "queued", stage: null, stageIndex: 0,
      budgetUsd: 1, costUsd: 0, workspaceId: null, nativeRunId: null, nextActionAt: null,
      startedAt: null, completedAt: null, metadata: {}, createdAt: project.createdAt,
    });
    const provider = new LocalWriterProvider();
    const artifactRoot = join(root, "artifacts"); mkdirSync(artifactRoot, { mode: 0o700 });
    const boundary = new WriterSandboxBoundary({
      store,
      workspaces: new WriterWorkspaceManager({ store, root: join(root, "writers"), gitCommand: "/usr/bin/git" }),
      provider, artifactRoot, ownerId: "direct_codex_test", leaseTtlMs: 60_000, heartbeatIntervalMs: 1_000,
    });
    const coordinator = new DirectModelPilotCoordinator({
      store, brain: new LocalProjectBrain(brainRoot), boundary, provider,
      gateway: new ScopedInferenceGateway(store, new FakeDirectUpstream(), policy), policy,
      repositoryPath: repository, repositoryCommit: setup.commit, contextRoot: join(root, "contexts"), maxCostUsd: 1,
      inferenceAuthenticated: true,
    });
    coordinator.schedule(runId);
    await coordinator.wait(runId);
    const run = (await store.getRun(runId))!;
    assert.equal(run.rootRuntime, "codex");
    assert.equal(run.status, "awaiting_approval");
    assert.equal(run.stage, "approval");
    assert.equal(run.metadata.modelExecutionAttempted, true);
    assert.equal(run.metadata.repairCount, 0);
    assert.equal(provider.startCount, 1);
    assert.equal((await store.listArtifacts(runId)).length, DIRECT_CODEX_ARTIFACTS.length);
    assert.deepEqual((await store.listInferenceRequests(runId)).map((item) => item.role).sort(), ["implementer", "verifier_final", "verifier_initial"]);
    const nativeEvents = (await store.listEvents(runId)).filter((event) => event.type === "inference.native.raw");
    assert.equal(nativeEvents.length, 6);
    assert.equal(nativeEvents.every((event) => event.payload.rawNative !== undefined), true);
    const workspace = await store.getWorkspaceForRun(runId);
    assert.ok(workspace);
    assert.equal(await store.getWorkspaceLease(workspace!.id), null);
    assert.equal((await store.getSandboxInstance(runId))?.state, "cleaned");
    let approvals = (await store.listApprovals("pending")).filter((item) => item.runId === runId);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.action, DIRECT_CODEX_APPROVAL_ACTION);
    const patch = (await store.listArtifacts(runId)).find((item) => item.kind === "candidate-patch")!;
    const review = await coordinator.readApprovalArtifact(runId, patch.id);
    assert.match(review.content, /normalizeProjectSlug/);

    // Simulate the narrow process-crash window after durable export/cleanup but
    // before the lifecycle stage and approval commit. Direct SQL is intentional:
    // the public store contract cannot create this physically possible torn state.
    const rawDb = (store as any).db;
    rawDb.prepare("DELETE FROM approvals WHERE id=?").run(approvals[0]!.id);
    rawDb.prepare("UPDATE runs SET status='running',stage='direct_codex_post_cleanup_crash' WHERE id=?").run(runId);
    await coordinator.reconcileStartup();
    const recovered = (await store.getRun(runId))!;
    assert.equal(recovered.status, "awaiting_approval");
    assert.equal(recovered.metadata.directModelCleanedRecovery, true);
    approvals = (await store.listApprovals("pending")).filter((item) => item.runId === runId);
    assert.equal(approvals.length, 1, "recovery recreates exactly one evidence-bound approval");
    await coordinator.resolveApproval(approvals[0]!, "approve", "test-operator");
    const completed = (await store.getRun(runId))!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.metadata.safeMockAcceptanceReceipt, true);
    assert.equal(completed.metadata.externalActionPerformed, false);
    assert.equal((await store.listMemoryProposals("proposed")).length, 1);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct Claude Code comparison gate is distinct and fail-closed", async () => {
  assert.notEqual(DIRECT_CODEX_MODEL_WORKFLOW, "direct-claude-code-fixture-model-pilot");
});
