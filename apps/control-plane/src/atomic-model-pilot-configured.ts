import { readPrivateSecretFile, isLoopbackHost } from "./auth.ts";
import type { AtomicFixtureModelPilotConfig } from "./config.ts";
import {
  HttpOpenAiInferenceUpstream,
  type InferenceUpstream,
  type ScopedInferencePolicy,
} from "./scoped-inference-gateway.ts";
import { CodexSubscriptionInferenceUpstream } from "./codex-subscription-inference.ts";

function exactVersionPattern(value: string): RegExp {
  return new RegExp(`^codex-cli ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

export function buildScopedInferencePolicy(config: AtomicFixtureModelPilotConfig): ScopedInferencePolicy {
  if (!config.enabled || !config.provider || !config.model
      || (config.upstreamMode === "openai-compatible" && !config.upstreamBaseUrl)) {
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
    maxRequests: 16,
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
  if (!config.enabled) throw new Error("Atomic model upstream is disabled");
  if (config.upstreamMode === "codex-subscription") {
    if (!config.codexCommand || !config.codexExpectedVersion || !config.codexHome
        || !config.codexScratchRoot || !config.codexOutputSchemaPath || !config.model) {
      throw new Error("Codex subscription upstream is incomplete");
    }
    const value = new CodexSubscriptionInferenceUpstream({
      command: config.codexCommand,
      expectedVersion: exactVersionPattern(config.codexExpectedVersion),
      codexHome: config.codexHome,
      scratchRoot: config.codexScratchRoot,
      model: config.model,
      reasoningEffort: config.codexReasoningEffort,
      outputSchemaPath: config.codexOutputSchemaPath,
    });
    value.preflight();
    return value;
  }
  if (!config.upstreamBaseUrl) throw new Error("OpenAI-compatible model upstream is incomplete");
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
