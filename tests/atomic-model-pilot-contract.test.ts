import test from "node:test";
import assert from "node:assert/strict";
import { buildAtomicModelAgentFiles, buildAtomicModelLaunchManifest, validateInternalInferenceGatewayBaseUrl } from "../apps/control-plane/src/atomic-model-pilot-contract.ts";
import { validateAtomicModelLaunchManifest } from "../apps/control-plane/src/atomic-runtime-adapter.ts";
import type { InferenceCapability } from "../apps/control-plane/src/store.ts";
import type { ScopedInferencePolicy } from "../apps/control-plane/src/scoped-inference-gateway.ts";
import { resolve } from "node:path";

const policy: ScopedInferencePolicy = {
  provider: "future-provider", model: "future-model", api: "openai-completions",
  roleModels: { implementer: "fixture-implementer", verifier_initial: "fixture-verifier-initial", repair: "fixture-repair", verifier_final: "fixture-verifier-final" },
  roles: ["implementer", "verifier_initial", "repair", "verifier_final"], maxRequests: 16,
  maxInputTokens: 32_000, maxOutputTokens: 8_000, maxCostMicros: 1_000_000,
  maxElapsedMs: 240_000, ttlMs: 600_000, inputCostMicrosPerMillion: 1000, outputCostMicrosPerMillion: 2000,
};

test("Atomic model agent config routes four roles through one internal capability without provider credentials", () => {
  const files = buildAtomicModelAgentFiles({ gatewayBaseUrl: "http://valkyrie-inference:8790/v1", policy });
  const models = JSON.parse(files.modelsJson);
  assert.deepEqual(Object.keys(models.providers).sort(), ["valkyrie-implementer", "valkyrie-repair", "valkyrie-verifier-final", "valkyrie-verifier-initial"]);
  for (const provider of Object.values(models.providers) as any[]) {
    assert.equal(provider.baseUrl, "http://valkyrie-inference:8790/v1");
    assert.equal(provider.apiKey, "!cat /run-context/inference-capability");
    assert.equal(provider.authHeader, true);
    assert.match(provider.headers["x-valkyrie-role"], /^(implementer|verifier_initial|repair|verifier_final)$/);
  }
  assert.doesNotMatch(`${files.modelsJson}${files.settingsJson}`, /OPENAI_API_KEY|ANTHROPIC_API_KEY|sk-|oauth|\.atomic\/auth/i);
  assert.throws(() => validateInternalInferenceGatewayBaseUrl("https://example.com/v1"), /exactly/i);
  assert.throws(() => validateInternalInferenceGatewayBaseUrl("http://user:pass@valkyrie-inference:8790/v1"), /exactly/i);
});

test("Atomic model launch manifest binds the exact capability without plaintext bearer material", () => {
  const capability: InferenceCapability = {
    id: "icap_fixture", runId: "run_fixture", projectId: "atomic-pilot", workflow: "atomic-fixture-model-pilot",
    tokenHash: "a".repeat(64), provider: policy.provider, model: policy.model, api: "openai-completions",
    roles: [...policy.roles], maxRequests: 16, maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens,
    maxCostMicros: policy.maxCostMicros, maxElapsedMs: policy.maxElapsedMs, issuedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-12T00:10:00.000Z", state: "active", policyHash: "b".repeat(64),
  };
  const manifest = buildAtomicModelLaunchManifest({
    runId: capability.runId, projectId: capability.projectId, taskId: "task_fixture", request: "Fixed fixture request",
    workflowVersion: "0.2.0", workflowSha256: "c".repeat(64), coreSha256: "d".repeat(64),
    packageSha256: "e".repeat(64), contextPackRef: "context://fixture", contractRef: "artifact://fixture/contract",
    workspaceId: "workspace_fixture", ownerId: "atomic_model_writer", fencingToken: 1,
    leaseExpiresAt: capability.expiresAt, imageDigest: `sha256:${"f".repeat(64)}`, sandboxPolicySha256: "1".repeat(64),
    capability, roleModels: policy.roleModels, maxCostUsd: 1,
    approvalEffect: "Record a safe mock receipt only; no external action.", liveProviderExpected: false,
  });
  assert.deepEqual(validateAtomicModelLaunchManifest(manifest, resolve("packages/atomic-workflow-architect")), []);
  assert.equal(JSON.stringify(manifest).includes("vki_"), false);
  assert.equal((manifest.inference as any).credential_in_writer, false);
  assert.equal((manifest.inference as any).live_provider_expected, false);
  assert.equal((manifest.inference as any).capability_token_sha256, capability.tokenHash);
});
