import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { prepareAtomicModelPilotContext, revokeAtomicModelPilotCapability } from "../apps/control-plane/src/atomic-model-pilot-prelive.ts";
import type { ScopedInferencePolicy } from "../apps/control-plane/src/scoped-inference-gateway.ts";
import type { Run } from "../apps/control-plane/src/types.ts";

const now = "2026-08-12T00:00:00.000Z";
const policy: ScopedInferencePolicy = {
  provider: "future-provider", model: "future-model", api: "openai-completions",
  roleModels: {
    implementer: "fixture-implementer", verifier_initial: "fixture-verifier-initial",
    repair: "fixture-repair", verifier_final: "fixture-verifier-final",
  },
  roles: ["implementer", "verifier_initial", "repair", "verifier_final"], maxRequests: 16,
  maxInputTokens: 32_000, maxOutputTokens: 8_000, maxCostMicros: 1_000_000,
  maxElapsedMs: 240_000, ttlMs: 10 * 60_000,
  inputCostMicrosPerMillion: 1000, outputCostMicrosPerMillion: 2000,
};

test("pre-live context binds an accepted image/package and exposes only a hashed run capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-m5b-context-"));
  const context = join(root, "context");
  const store = new SqliteStore(":memory:", { now: () => new Date(now) });
  try {
    await store.seedProjects([{
      id: "atomic-pilot", name: "Atomic Pilot", objective: "fixture", currentMilestone: "M5b",
      health: "exploring", linearTeam: "FIX", repository: "fixture", vaultPath: "Projects/Atomic Pilot",
      memoryNamespace: "projects/atomic-pilot", createdAt: now,
    }]);
    const run: Run = {
      id: "run_model_context", projectId: "atomic-pilot", taskId: null, rootRuntime: "atomic",
      workflow: "atomic-fixture-model-pilot", status: "queued", stage: "queued", stageIndex: 0,
      budgetUsd: 1, costUsd: 0, workspaceId: null, nativeRunId: null, nextActionAt: null,
      startedAt: null, completedAt: null, metadata: {}, createdAt: now,
    };
    await store.createRun(run);
    const packageSha = "a".repeat(64);
    const image = `sha256:${"b".repeat(64)}`;
    const prepared = await prepareAtomicModelPilotContext({
      store, contextPath: context,
      binding: {
        runId: run.id, projectId: run.projectId, workflow: run.workflow!, workspaceId: "ws_model",
        leaseOwnerId: "model_writer", fencingToken: 7, baseCommit: "c".repeat(40), branchName: "agent/model",
        workspaceProvider: "git-worktree", sandboxContract: { provider: "docker-compatible", imageRef: `fixture@${image}`, policyHash: "d".repeat(64) },
      },
      taskId: "task_model", request: "fixed request", policy,
      gatewayBaseUrl: "http://valkyrie-inference:8790/v1", packageSha256: packageSha,
      workflowVersion: "0.2.0", workflowSha256: "e".repeat(64), coreSha256: "f".repeat(64),
      imageDigest: image, acceptedPackageSha256: packageSha, acceptedImageDigest: image,
      leaseExpiresAt: "2026-08-12T00:10:00.000Z", maxCostUsd: 1,
      approvalEffect: "Record an evidence-bound safe mock receipt only.", contextPack: { objective: "fixed" }, liveProviderExpected: false,
      now: () => new Date(now),
    });
    const token = readFileSync(join(context, "inference-capability"), "utf8").trim();
    assert.equal(createHash("sha256").update(token).digest("hex"), prepared.capability.tokenHash);
    assert.equal(prepared.capability.tokenHash, createHash("sha256").update(token).digest("hex"));
    assert.doesNotMatch(JSON.stringify(await store.getInferenceCapability(prepared.capability.id)), new RegExp(token));
    const allNonSecretContext = [
      "context-pack.json", "run-contract.json", "atomic-model-launch-manifest.json",
      "atomic-agent/models.json", "atomic-agent/settings.json",
    ].map((name) => readFileSync(join(context, name), "utf8")).join("\n");
    assert.equal(allNonSecretContext.includes(token), false);
    assert.doesNotMatch(allNonSecretContext, /OPENAI_API_KEY|ANTHROPIC_API_KEY|sk-/i);
    await revokeAtomicModelPilotCapability(store, prepared.capability.id, "2026-08-12T00:01:00.000Z");
    assert.equal((await store.getInferenceCapability(prepared.capability.id))?.state, "revoked");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-live context rejects a package or image outside the accepted deployment allowlist before issuance", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-m5b-reject-"));
  const store = new SqliteStore(":memory:", { now: () => new Date(now) });
  try {
    await assert.rejects(prepareAtomicModelPilotContext({
      store, contextPath: join(root, "context"),
      binding: {
        runId: "run_reject", projectId: "atomic-pilot", workflow: "atomic-fixture-model-pilot",
        workspaceId: "ws_reject", leaseOwnerId: "writer", fencingToken: 1, baseCommit: "a".repeat(40),
        branchName: "agent/reject", workspaceProvider: "git-worktree",
        sandboxContract: { provider: "docker-compatible", imageRef: `fixture@sha256:${"b".repeat(64)}`, policyHash: "c".repeat(64) },
      },
      taskId: "task_reject", request: "fixed", policy, gatewayBaseUrl: "http://valkyrie-inference:8790/v1",
      packageSha256: "d".repeat(64), acceptedPackageSha256: "e".repeat(64),
      workflowVersion: "0.2.0", workflowSha256: "f".repeat(64), coreSha256: "1".repeat(64),
      imageDigest: `sha256:${"2".repeat(64)}`, acceptedImageDigest: `sha256:${"3".repeat(64)}`,
      leaseExpiresAt: "2026-08-12T00:10:00.000Z", maxCostUsd: 1,
      approvalEffect: "safe mock", contextPack: {}, now: () => new Date(now), liveProviderExpected: false,
    }), /allowlist/i);
    assert.deepEqual(await store.listInferenceRequests("run_reject"), []);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
