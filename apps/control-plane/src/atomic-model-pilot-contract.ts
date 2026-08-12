import { canonicalJson, type InferenceCapability, type InferenceRole } from "./store.ts";
import type { ScopedInferencePolicy } from "./scoped-inference-gateway.ts";

const ROLE_PROVIDER: Record<InferenceRole, string> = {
  implementer: "valkyrie-implementer",
  verifier_initial: "valkyrie-verifier-initial",
  repair: "valkyrie-repair",
  verifier_final: "valkyrie-verifier-final",
};

export const ATOMIC_MODEL_CAPABILITY_PATH = "/run-context/inference-capability";
export const ATOMIC_MODEL_AGENT_SOURCE = "atomic-agent";

export function validateInternalInferenceGatewayBaseUrl(value: string): string {
  if (!value || value !== value.trim()) throw new Error("Inference gateway URL must be a trimmed internal URL");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Inference gateway URL must be valid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "valkyrie-inference" || !parsed.port
      || parsed.username || parsed.password || parsed.pathname !== "/v1" || parsed.search || parsed.hash) {
    throw new Error("Inference gateway URL must be exactly http://valkyrie-inference:<port>/v1");
  }
  return parsed.href.replace(/\/$/, "");
}

export function buildAtomicModelAgentFiles(input: {
  gatewayBaseUrl: string;
  policy: ScopedInferencePolicy;
}): { modelsJson: string; settingsJson: string } {
  const baseUrl = validateInternalInferenceGatewayBaseUrl(input.gatewayBaseUrl);
  const providers = Object.fromEntries(input.policy.roles.map((role) => {
    const provider = ROLE_PROVIDER[role];
    const model = input.policy.roleModels[role];
    return [provider, {
      baseUrl,
      api: "openai-completions",
      apiKey: `!cat ${ATOMIC_MODEL_CAPABILITY_PATH}`,
      authHeader: true,
      headers: { "x-valkyrie-role": role },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{
        id: model, name: `Valkyrie bounded ${role}`, reasoning: false, input: ["text"],
        contextWindow: input.policy.maxInputTokens, maxTokens: input.policy.maxOutputTokens,
        cost: {
          input: input.policy.inputCostMicrosPerMillion / 1_000_000,
          output: input.policy.outputCostMicrosPerMillion / 1_000_000,
          cacheRead: 0, cacheWrite: 0,
        },
      }],
    }];
  }));
  return {
    modelsJson: canonicalJson({ providers }),
    settingsJson: canonicalJson({
      defaultProvider: ROLE_PROVIDER.implementer,
      defaultModel: input.policy.roleModels.implementer,
      defaultProjectTrust: "always",
      workflowNotifications: { enabled: true, notifyOn: ["completed", "failed", "blocked", "awaiting_input"] },
    }),
  };
}

export function buildAtomicModelLaunchManifest(input: {
  runId: string;
  projectId: string;
  taskId: string;
  request: string;
  workflowVersion: string;
  workflowSha256: string;
  coreSha256: string;
  packageSha256: string;
  contextPackRef: string;
  contractRef: string;
  workspaceId: string;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt: string;
  imageDigest: string;
  sandboxPolicySha256: string;
  capability: InferenceCapability;
  roleModels: ScopedInferencePolicy["roleModels"];
  maxCostUsd: number;
  approvalEffect: string;
  liveProviderExpected: boolean;
}): Record<string, unknown> {
  return {
    schema_version: "1.1.0-model",
    run_id: input.runId,
    project_id: input.projectId,
    task_id: input.taskId,
    request: input.request,
    root_runtime: "atomic",
    workflow: {
      name: "atomic-fixture-model-pilot", version: input.workflowVersion,
      workflow_sha256: input.workflowSha256, core_sha256: input.coreSha256,
    },
    package_sha256: input.packageSha256,
    context_pack_ref: input.contextPackRef,
    contract_ref: input.contractRef,
    workspace: {
      workspace_id: input.workspaceId, owner_id: input.ownerId,
      fencing_token: input.fencingToken, lease_expires_at: input.leaseExpiresAt,
    },
    sandbox: {
      image_digest: input.imageDigest, policy_sha256: input.sandboxPolicySha256,
      network_policy: "run_internal_gateway_only",
    },
    inference: {
      capability_id: input.capability.id,
      capability_token_sha256: input.capability.tokenHash,
      provider: input.capability.provider,
      model: input.capability.model,
      api: input.capability.api,
      role_models: input.roleModels,
      max_requests: input.capability.maxRequests,
      max_input_tokens: input.capability.maxInputTokens,
      max_output_tokens: input.capability.maxOutputTokens,
      max_cost_micros: input.capability.maxCostMicros,
      max_elapsed_ms: input.capability.maxElapsedMs,
      expires_at: input.capability.expiresAt,
      credential_in_writer: false,
      live_provider_expected: input.liveProviderExpected,
      live_provider_verified: false,
    },
    inference_policy_sha256: input.capability.policyHash,
    budget: { currency: "USD", max_cost_usd: input.maxCostUsd },
    bounds: { max_duration_seconds: 240, max_turns: 4, max_repairs: 1, max_concurrency: 1, max_child_depth: 0 },
    crossProcessResume: false,
    final_action: "stop_before_external_action",
    approval: { action: "accept_atomic_fixture_model_result", exact_effect: input.approvalEffect, required: true },
  };
}
