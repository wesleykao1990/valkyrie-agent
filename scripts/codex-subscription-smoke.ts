import { resolve } from "node:path";
import { CodexSubscriptionInferenceUpstream } from "../apps/control-plane/src/codex-subscription-inference.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const version = required("ATOMIC_FIXTURE_MODEL_CODEX_EXPECTED_VERSION");
const upstream = new CodexSubscriptionInferenceUpstream({
  command: required("ATOMIC_FIXTURE_MODEL_CODEX_COMMAND"),
  expectedVersion: new RegExp(`^codex-cli ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  codexHome: required("ATOMIC_FIXTURE_MODEL_CODEX_HOME"),
  scratchRoot: required("ATOMIC_FIXTURE_MODEL_CODEX_SCRATCH_ROOT"),
  model: required("ATOMIC_FIXTURE_MODEL_ID"),
  reasoningEffort: (process.env.ATOMIC_FIXTURE_MODEL_CODEX_REASONING_EFFORT?.trim() || "low") as "low" | "medium" | "high" | "xhigh",
  outputSchemaPath: process.env.ATOMIC_FIXTURE_MODEL_CODEX_OUTPUT_SCHEMA?.trim()
    || resolve("apps/control-plane/schemas/codex-subscription-broker-output.schema.json"),
});
const preflight = upstream.preflight();
const model = required("ATOMIC_FIXTURE_MODEL_ID");
const firstMessages = [
  { role: "user", content: "Respond with exactly VALKYRIE_SUBSCRIPTION_BROKER_OK and no other text." },
];
const first = await upstream.complete({
  capabilityId: "icap_subscription_smoke",
  requestId: "ireq_subscription_smoke_1",
  provider: "openai-codex-subscription",
  model,
  role: "implementer",
  body: {
    model,
    messages: firstMessages,
  },
  timeoutMs: 120_000,
  signal: new AbortController().signal,
});
const firstBody = JSON.parse(first.body.toString("utf8"));
if (firstBody.choices?.[0]?.message?.content !== "VALKYRIE_SUBSCRIPTION_BROKER_OK"
    || !first.providerSessionId || first.providerSessionReused !== false) {
  throw new Error("Subscription broker returned invalid first-turn session evidence");
}
const second = await upstream.complete({
  capabilityId: "icap_subscription_smoke",
  requestId: "ireq_subscription_smoke_2",
  provider: "openai-codex-subscription",
  model,
  role: "implementer",
  priorProviderSessionId: first.providerSessionId,
  body: {
    model,
    messages: [
      ...firstMessages,
      { role: "assistant", content: "VALKYRIE_SUBSCRIPTION_BROKER_OK" },
      { role: "user", content: "Respond with exactly VALKYRIE_SUBSCRIPTION_RESUME_OK and no other text." },
    ],
  },
  timeoutMs: 120_000,
  signal: new AbortController().signal,
});
const secondBody = JSON.parse(second.body.toString("utf8"));
if (secondBody.choices?.[0]?.message?.content !== "VALKYRIE_SUBSCRIPTION_RESUME_OK"
    || second.providerSessionId !== first.providerSessionId || second.providerSessionReused !== true) {
  throw new Error("Subscription broker did not resume the exact first-turn provider session");
}
console.log(JSON.stringify({
  status: "pass", version: preflight.version, authMode: preflight.authMode,
  providerSessionId: first.providerSessionId,
  turns: [
    { providerRequestId: first.providerRequestId, providerSessionReused: first.providerSessionReused,
      inputTokens: first.inputTokens, outputTokens: first.outputTokens },
    { providerRequestId: second.providerRequestId, providerSessionReused: second.providerSessionReused,
      inputTokens: second.inputTokens, outputTokens: second.outputTokens },
  ],
  apiKeyUsed: false,
}, null, 2));
