import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { AtomicRpcClient } from "../apps/control-plane/src/atomic-rpc-client.ts";
import { AtomicModelPilotCoordinator } from "../apps/control-plane/src/atomic-model-pilot-coordinator.ts";
import { copyReviewedAtomicPackage } from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import type { ScopedInferencePolicy } from "../apps/control-plane/src/scoped-inference-gateway.ts";
import type { Project, Run } from "../apps/control-plane/src/types.ts";
import type { WriterSandboxWorkloadInput, WriterSandboxWorkloadResult } from "../apps/control-plane/src/writer-sandbox-boundary.ts";
import type { OciSandboxHandle } from "../apps/control-plane/src/oci-sandbox-provider.ts";
import {
  ATOMIC_FIXTURE_IMPLEMENTATION,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";
import {
  emitAtomicFixtureModelEvidence,
  runAtomicFixtureModelChecks,
  writeAtomicFixtureModelReview,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

const now = "2026-08-12T00:00:00.000Z";
const packageDir = resolve("packages/atomic-workflow-architect");
const fakeAtomic = resolve("scripts/fake-atomic-rpc.ts");
const policy: ScopedInferencePolicy = {
  provider: "fake-prelive", model: "fake-prelive-model", api: "openai-completions",
  roleModels: { implementer: "impl", verifier_initial: "verify-1", repair: "repair", verifier_final: "verify-2" },
  roles: ["implementer", "verifier_initial", "repair", "verifier_final"], maxRequests: 4,
  maxInputTokens: 32_000, maxOutputTokens: 8_000, maxCostMicros: 1_000_000,
  maxElapsedMs: 240_000, ttlMs: 10 * 60_000, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0,
};

class FakeBoundary {
  private readonly binding: any;
  private readonly handle: OciSandboxHandle;
  capabilityToken?: string;
  private readonly afterPrepare?: (input: WriterSandboxWorkloadInput, token: string) => Promise<void>;
  constructor(binding: any, handle: OciSandboxHandle, afterPrepare?: (input: WriterSandboxWorkloadInput, token: string) => Promise<void>) {
    this.binding = binding; this.handle = handle; this.afterPrepare = afterPrepare;
  }
  async runWorkload(input: WriterSandboxWorkloadInput): Promise<WriterSandboxWorkloadResult> {
    await input.prepareContext(this.binding);
    this.capabilityToken = readFileSync(join(input.contextPath, "inference-capability"), "utf8").trim();
    await this.afterPrepare?.(input, this.capabilityToken);
    const execution = await input.execute(this.handle, this.binding);
    if (input.validateExports) {
      const outputRoot = join(this.handle.workspacePath, this.handle.workingDirectoryRelativePath);
      const exports = input.artifacts.map((item) => {
        const body = readFileSync(join(outputRoot, item.relativePath));
        return { ...item, checksum: createHash("sha256").update(body).digest("hex"), sizeBytes: body.byteLength };
      });
      await input.validateExports(exports);
    }
    return {
      runId: input.run.id, workspaceId: this.binding.workspaceId, fencingToken: this.binding.fencingToken,
      baseCommit: this.binding.baseCommit, branchName: this.binding.branchName, execution,
      exports: [], artifacts: [], completion: "evidence_ready",
    };
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test("pre-live coordinator composes accepted package, read-only capability, native workflow, cleanup, and revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-m5b-coordinator-"));
  const contextRoot = join(root, "contexts");
  const staging = join(root, "package-probe");
  mkdirSync(contextRoot, { mode: 0o700 });
  const packageDigest = copyReviewedAtomicPackage(packageDir, staging).digest;
  rmSync(staging, { recursive: true });
  const store = new SqliteStore(":memory:", { now: () => new Date(now) });
  const project: Project = {
    id: "atomic-pilot", name: "Atomic Pilot", objective: "fixture", currentMilestone: "M5b", health: "exploring",
    linearTeam: "FIX", repository: "fixture", vaultPath: "Projects/Atomic Pilot", memoryNamespace: "projects/atomic-pilot", createdAt: now,
  };
  const run: Run = {
    id: "run_model_coordinator", projectId: project.id, taskId: "task_model", rootRuntime: "atomic",
    workflow: "atomic-fixture-model-pilot", status: "queued", stage: "queued", stageIndex: 0,
    budgetUsd: 1, costUsd: 0, workspaceId: null, nativeRunId: null, nextActionAt: null,
    startedAt: null, completedAt: null, metadata: {}, createdAt: now,
  };
  try {
    await store.seedProjects([{ ...project }]);
    await store.createTask({
      id: "task_model", projectId: project.id, source: "fixture", sourceId: "M5B-1", title: "Model fixture",
      objective: "fixed", status: "planned", priority: "normal", createdAt: now,
    });
    await store.createRun(run);
    await store.createWorkspaceLease({
      id: "ws_model_coordinator", runId: run.id, path: join(root, "workspace"), provider: "test", status: "leased", createdAt: now,
    }, {
      workspaceId: "ws_model_coordinator", runId: run.id, ownerId: "atomic_model_writer", mode: "writer",
      heartbeatAt: now, expiresAt: "2026-08-12T00:10:00.000Z",
    });
    const binding = {
      runId: run.id, projectId: project.id, workflow: run.workflow, workspaceId: "ws_model_coordinator",
      leaseOwnerId: "atomic_model_writer", fencingToken: 1, baseCommit: "a".repeat(40), branchName: "agent/model",
      workspaceProvider: "git-worktree",
      sandboxContract: { provider: "docker-compatible", imageRef: `fixture@sha256:${"b".repeat(64)}`, policyHash: "c".repeat(64) },
    };
    const handle = { runId: run.id, workspaceId: binding.workspaceId, leaseOwnerId: binding.leaseOwnerId,
      fencingToken: 1, containerId: "d".repeat(64), containerName: "fixture", workspacePath: root, contextPath: contextRoot,
      workspaceDigest: "e".repeat(64), contextDigest: "f".repeat(64), workingDirectoryRelativePath: "worktree",
      workingDirectoryDigest: "1".repeat(64), status: "running" } as OciSandboxHandle;
    const worktree = join(root, "worktree");
    cpSync(resolve("fixtures/atomic-pilot-template"), worktree, { recursive: true });
    git(worktree, ["init", "--quiet"]);
    git(worktree, ["add", "."]);
    git(worktree, ["-c", "user.name=Valkyrie Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
    const prepareEvidence = async (workload: WriterSandboxWorkloadInput, token: string) => {
      const capability = await store.getInferenceCapabilityByTokenHash(createHash("sha256").update(token).digest("hex"));
      assert.ok(capability);
      for (const [index, role] of (["implementer", "verifier_initial", "verifier_final"] as const).entries()) {
        const requestId = `ireq_test_${role}`;
        await store.reserveInferenceRequest({
          id: requestId, tokenHash: capability.tokenHash, runId: run.id, role, requestHash: String(index + 1).repeat(64),
        });
        await store.completeInferenceRequest({
          id: requestId, state: "completed", providerRequestId: `provider_${role}`,
          responseHash: String(index + 4).repeat(64), inputTokens: 10, outputTokens: 5, costMicros: 10,
        });
      }
      writeFileSync(join(worktree, "src/normalize-project-slug.js"), ATOMIC_FIXTURE_IMPLEMENTATION);
      await runAtomicFixtureModelChecks({ workspacePath: worktree, round: "initial", nodePath: process.execPath });
      await writeAtomicFixtureModelReview({ workspacePath: worktree, round: "initial", review: { approved: true, findings: [] } });
      const checks = await runAtomicFixtureModelChecks({ workspacePath: worktree, round: "final", nodePath: process.execPath });
      const verifier = await writeAtomicFixtureModelReview({ workspacePath: worktree, round: "final", review: { approved: true, findings: [] } });
      for (const name of ["checks-initial.json", "checks-final.json"]) {
        const path = join(worktree, ".valkyrie-model-output", name);
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.commands[0].argv[0] = "/usr/local/bin/node";
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      }
      const finalChecksBody = readFileSync(join(worktree, ".valkyrie-model-output/checks-final.json"));
      checks.artifact.sha256 = createHash("sha256").update(finalChecksBody).digest("hex");
      checks.artifact.size_bytes = finalChecksBody.byteLength;
      const contract = readFileSync(join(workload.contextPath, "run-contract.json"));
      const contractValue = JSON.parse(contract.toString("utf8"));
      await emitAtomicFixtureModelEvidence({
        workspacePath: worktree, contextRoot: workload.contextPath,
        inputs: {
          control_plane_run_id: run.id,
          contract_sha256: createHash("sha256").update(contract).digest("hex"),
          expected_before_sha256: "8db91027a68c9d7bd68bb2c3d04e592ca29039f15b8df506cfce0de6e27f69d2",
          capability_policy_sha256: contractValue.inference.policySha256,
          package_sha256: contractValue.atomicPackage.packageSha256,
          live_provider_expected: false,
        },
        nativeRunId: "11111111-2222-4333-8444-555555555555", checks, verifier, repairCount: 0,
      });
    };
    const provider = {
      openAtomicRpc: async () => {
        const client = new AtomicRpcClient({ command: process.execPath, commandArgs: ["--experimental-strip-types", fakeAtomic] });
        client.start({ cwd: process.cwd(), env: { FAKE_ATOMIC_WORKFLOW_RUNNING_POLLS: "0" } });
        return client;
      },
    } as any;
    const boundary = new FakeBoundary(binding, handle, prepareEvidence);
    const coordinator = new AtomicModelPilotCoordinator({
      store, boundary: boundary as any, provider,
      packageDir, repositoryPath: root, repositoryCommit: "a".repeat(40), contextRoot,
      policy, gatewayBaseUrl: "http://valkyrie-inference:8790/v1",
      acceptedPackageSha256: packageDigest, acceptedImageDigest: `sha256:${"b".repeat(64)}`, maxCostUsd: 1,
      bridge: {
        start: async (runId) => ({ runId, id: "9".repeat(64), name: "fake-bridge", socketPath: join(root, "fake.sock") }),
        stop: async () => undefined,
      },
      now: () => new Date(now),
    });
    const result = await coordinator.run({ run, project, taskId: "task_model", contextPack: { objective: "fixed" }, signal: new AbortController().signal });
    assert.equal(result.liveProviderVerified, false);
    assert.equal(result.native.output.live_provider_verified, false);
    assert.equal((await store.getInferenceCapability(result.capabilityId))?.state, "revoked");
    assert.equal((await store.getRun(run.id))?.metadata.atomicModelPilotMode, "credential_free_fixture");
    assert.equal((await store.getRun(run.id))?.metadata.modelExecutionAttempted, true);
    assert.deepEqual((await store.listInferenceRequests(run.id)).map((item) => item.role).sort(),
      ["implementer", "verifier_final", "verifier_initial"], "pre-live contract binds the expected simulated provider stages");
    const events = await store.listEvents(run.id);
    assert.ok(events.some((event) => event.type === "atomic.native.raw"));
    assert.equal(JSON.stringify(events).includes("liveProviderVerified\":true"), false);
    assert.ok(boundary.capabilityToken?.startsWith("vki_"));
    assert.equal(JSON.stringify(events).includes(boundary.capabilityToken!), false, "plaintext capability never enters events");
    assert.equal(JSON.stringify(await store.getRun(run.id)).includes(boundary.capabilityToken!), false, "plaintext capability never enters run metadata");
    assert.equal(existsSync(join(contextRoot, createHashForRun(run.id))), false);

    const failedRun: Run = { ...run, id: "run_model_cleanup_failure", workspaceId: null, metadata: {} };
    await store.createRun(failedRun);
    await store.createWorkspaceLease({
      id: "ws_model_cleanup_failure", runId: failedRun.id, path: join(root, "workspace-failure"), provider: "test", status: "leased", createdAt: now,
    }, {
      workspaceId: "ws_model_cleanup_failure", runId: failedRun.id, ownerId: "atomic_model_writer_failure", mode: "writer",
      heartbeatAt: now, expiresAt: "2026-08-12T00:10:00.000Z",
    });
    const failedBinding = {
      ...binding, runId: failedRun.id, workspaceId: "ws_model_cleanup_failure", leaseOwnerId: "atomic_model_writer_failure",
    };
    const failedHandle = {
      ...handle, runId: failedRun.id, workspaceId: failedBinding.workspaceId, leaseOwnerId: failedBinding.leaseOwnerId,
    } as OciSandboxHandle;
    const failedBoundary = new FakeBoundary(failedBinding, failedHandle);
    let bridgeStops = 0;
    const failedCoordinator = new AtomicModelPilotCoordinator({
      store, boundary: failedBoundary as any,
      provider: { openAtomicRpc: async () => { throw new Error("simulated RPC startup failure"); } } as any,
      packageDir, repositoryPath: root, repositoryCommit: "a".repeat(40), contextRoot,
      policy, gatewayBaseUrl: "http://valkyrie-inference:8790/v1",
      acceptedPackageSha256: packageDigest, acceptedImageDigest: `sha256:${"b".repeat(64)}`, maxCostUsd: 1,
      bridge: {
        start: async (runId) => ({ runId, id: "8".repeat(64), name: "fake-bridge", socketPath: join(root, "fake.sock") }),
        stop: async () => { bridgeStops += 1; },
      },
      now: () => new Date(now),
    });
    await assert.rejects(
      failedCoordinator.run({ run: failedRun, project, taskId: "task_model", contextPack: { objective: "fixed" }, signal: new AbortController().signal }),
      /simulated RPC startup failure/,
    );
    assert.equal(bridgeStops, 1, "bridge cleanup runs after native startup failure");
    assert.ok(failedBoundary.capabilityToken?.startsWith("vki_"));
    const failedCapability = await store.getInferenceCapabilityByTokenHash(createHash("sha256").update(failedBoundary.capabilityToken!).digest("hex"));
    assert.equal(failedCapability?.state, "revoked", "capability is revoked after native startup failure");
    assert.equal(existsSync(join(contextRoot, createHashForRun(failedRun.id))), false, "private context is removed after failure");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createHashForRun(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
