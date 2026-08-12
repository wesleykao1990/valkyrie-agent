import { readPrivateSecretFile, isLoopbackHost } from "./auth.ts";
import type { AtomicFixtureModelPilotConfig } from "./config.ts";
import {
  HttpOpenAiInferenceUpstream,
  type InferenceUpstream,
  type ScopedInferencePolicy,
} from "./scoped-inference-gateway.ts";

export function buildScopedInferencePolicy(config: AtomicFixtureModelPilotConfig): ScopedInferencePolicy {
  if (!config.enabled || !config.provider || !config.model || !config.upstreamBaseUrl) {
    throw new Error("Atomic model pilot configuration is not enabled and complete");
  }
  return {
    provider: config.provider,
    model: config.model,
    api: "openai-completions",
    roleModels: {
      implementer: "fixture-implementer",
      verifier_initial: "fixture-verifier-initial",
      repair: "fixture-repair",
      verifier_final: "fixture-verifier-final",
    },
    roles: ["implementer", "verifier_initial", "repair", "verifier_final"],
    maxRequests: 4,
    maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    maxCostMicros: Math.round(config.maxCostUsd * 1_000_000),
    maxElapsedMs: 240_000,
    ttlMs: 10 * 60_000,
    inputCostMicrosPerMillion: config.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: config.outputCostMicrosPerMillion,
  };
}

/**
 * The only provider-credential loading point. Call this only after all startup
 * policy/digest checks pass. The returned upstream stays outside the writer.
 */
export function createConfiguredInferenceUpstream(config: AtomicFixtureModelPilotConfig): InferenceUpstream {
  if (!config.enabled || !config.upstreamBaseUrl) throw new Error("Atomic model upstream is disabled");
  const upstream = new URL(config.upstreamBaseUrl);
  const credentialFreeLoopback = isLoopbackHost(upstream.hostname) && config.allowCredentialFreeLoopback;
  const credential = config.credentialFile
    ? readPrivateSecretFile(config.credentialFile, "ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE", 16)
    : undefined;
  return new HttpOpenAiInferenceUpstream({
    baseUrl: config.upstreamBaseUrl,
    ...(credential ? { credential } : {}),
    authorization: config.credentialHeader,
    allowCredentialFreeLoopback: credentialFreeLoopback,
  });
}
