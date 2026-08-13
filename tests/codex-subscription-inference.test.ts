import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexSubscriptionInferenceUpstream } from "../apps/control-plane/src/codex-subscription-inference.ts";

const fake = resolve("scripts/fake-codex-subscription.ts");

function fixture(behavior = "content") {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-codex-subscription-"));
  chmodSync(root, 0o700);
  const home = join(root, "codex-home");
  const scratch = join(root, "scratch");
  mkdirSync(home, { mode: 0o700 });
  const schema = join(root, "schema.json");
  writeFileSync(schema, JSON.stringify({ type: "object" }), { mode: 0o600 });
  const upstream = new CodexSubscriptionInferenceUpstream({
    command: process.execPath,
    commandPrefixArgs: ["--experimental-strip-types", fake, behavior],
    expectedVersion: /^codex-cli 0\.147\.0$/,
    codexHome: home,
    scratchRoot: scratch,
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    outputSchemaPath: schema,
    stopTimeoutMs: 100,
  });
  let ordinal = 0;
  const complete = (
    body: Record<string, unknown>,
    timeoutMs = 2_000,
    options: { role?: "implementer" | "verifier_initial" | "repair" | "verifier_final"; priorProviderSessionId?: string } = {},
  ) => upstream.complete({
    capabilityId: "icap_codex_subscription_fixture",
    requestId: `ireq_codex_subscription_${++ordinal}`,
    provider: "openai-codex-subscription", model: "gpt-5.6-sol", role: options.role ?? "implementer",
    body, ...(options.priorProviderSessionId ? { priorProviderSessionId: options.priorProviderSessionId } : {}),
    timeoutMs, signal: new AbortController().signal,
  });
  const trace = () => {
    const path = join(scratch, "fake-codex-subscription-trace.jsonl");
    try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  return { root, home, scratch, upstream, complete, trace };
}

test("subscription broker preflights ChatGPT auth and returns bounded content with usage", async () => {
  const item = fixture("assert-isolation");
  const previous = process.env.VALKYRIE_PARENT_SECRET;
  process.env.VALKYRIE_PARENT_SECRET = "must-not-reach-codex";
  try {
    assert.deepEqual(item.upstream.preflight(), { version: "codex-cli 0.147.0", authMode: "chatgpt" });
    const result = await item.complete({
      model: "gpt-5.6-sol", messages: [{ role: "user", content: "SECRET_PROMPT_SENTINEL" }],
    });
    const body = JSON.parse(result.body.toString("utf8"));
    assert.equal(body.choices[0].message.content, "bounded subscription response");
    assert.deepEqual(body.usage, { prompt_tokens: 137, completion_tokens: 29, total_tokens: 166 });
    assert.equal(result.providerRequestId.startsWith("codex_"), true);
    assert.equal(result.providerSessionId, "codex-session-1");
    assert.equal(result.providerSessionReused, false);
    assert.deepEqual(result.nativeRecords?.map((record) => record.type), ["thread.started", "turn.started", "item.completed", "turn.completed"]);
  } finally {
    if (previous === undefined) delete process.env.VALKYRIE_PARENT_SECRET;
    else process.env.VALKYRIE_PARENT_SECRET = previous;
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("subscription broker converts only request-allowlisted tool calls", async () => {
  const item = fixture("tool");
  try {
    const result = await item.complete({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Write the fixed fixture." }],
      tools: [{ type: "function", function: { name: "write_fixture", parameters: { type: "object" } } }],
    });
    const call = JSON.parse(result.body.toString("utf8")).choices[0].message.tool_calls[0];
    assert.equal(call.type, "function");
    assert.equal(call.function.name, "write_fixture");
    assert.deepEqual(JSON.parse(call.function.arguments), { content: "fixed", path: "src/message.ts" });
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test("subscription broker translates a bounded result into complete OpenAI-compatible SSE", async () => {
  const item = fixture("content");
  try {
    const result = await item.complete({
      model: "gpt-5.6-sol", messages: [{ role: "user", content: "fixed" }], stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(result.contentType, "text/event-stream");
    const frames = result.body.toString("utf8").split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    assert.equal(frames[0].choices[0].delta.content, "bounded subscription response");
    assert.equal(frames[0].choices[0].finish_reason, null);
    assert.equal(frames[1].choices[0].finish_reason, "stop");
    assert.deepEqual(frames[2].usage, { prompt_tokens: 137, completion_tokens: 29, total_tokens: 166 });
    assert.match(result.body.toString("utf8"), /data: \[DONE\]\n\n$/);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test("subscription broker fails closed on internal Codex tools and missing usage", async () => {
  for (const behavior of ["internal-tool", "missing-usage"]) {
    const item = fixture(behavior);
    try {
      await assert.rejects(item.complete({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "fixed" }] }),
        /internal tool|terminal evidence/);
    } finally { rmSync(item.root, { recursive: true, force: true }); }
  }
});

test("subscription broker enforces an elapsed-time bound even when TERM is ignored", async () => {
  const item = fixture("slow");
  try {
    const started = Date.now();
    await assert.rejects(item.complete({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "fixed" }] }, 100),
      /cancelled or timed out/);
    assert.ok(Date.now() - started < 1_000);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test("subscription broker rejects a model outside the configured subscription scope", async () => {
  const item = fixture();
  try {
    await assert.rejects(item.upstream.complete({
      capabilityId: "icap_codex_subscription_fixture", requestId: "ireq_wrong_model",
      provider: "openai-codex-subscription", model: "other", role: "implementer",
      body: { messages: [{ role: "user", content: "fixed" }] }, timeoutMs: 1000,
      signal: new AbortController().signal,
    }), /reviewed model/);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test("subscription broker resumes one role thread with an appended conversation delta", async () => {
  const item = fixture("content");
  try {
    const firstMessages = [{ role: "user", content: "FIRST_CONVERSATION_SENTINEL" }];
    const first = await item.complete({ model: "gpt-5.6-sol", messages: firstMessages });
    const second = await item.complete({
      model: "gpt-5.6-sol",
      messages: [...firstMessages, { role: "assistant", content: "bounded subscription response" }, { role: "user", content: "SECOND_DELTA_SENTINEL" }],
    }, 2_000, { priorProviderSessionId: first.providerSessionId });
    assert.equal(second.providerSessionId, first.providerSessionId);
    assert.equal(second.providerSessionReused, true);
    const trace = item.trace();
    assert.equal(trace.length, 2);
    assert.equal(trace[0].args.includes("resume"), false);
    assert.equal(trace[0].args.includes("--ephemeral"), false);
    assert.equal(trace[1].args.includes("resume"), true);
    assert.equal(trace[1].args.includes(first.providerSessionId), true);
    assert.equal(trace[1].args.includes("--sandbox"), false, "resume has no dedicated sandbox flag");
    const resumeSandboxConfig = trace[1].args.findIndex((arg: string, index: number) =>
      arg === "-c" && trace[1].args[index + 1] === 'sandbox_mode="read-only"');
    assert.notEqual(resumeSandboxConfig, -1, "resume must reassert the documented read-only sandbox config");
    assert.match(trace[1].prompt, /SECOND_DELTA_SENTINEL/);
    assert.doesNotMatch(trace[1].prompt, /FIRST_CONVERSATION_SENTINEL/, "the full prior conversation is not replayed");
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test("subscription broker isolates roles and rejects non-monotonic or process-lost continuation", async () => {
  const item = fixture("content");
  try {
    const first = await item.complete({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "initial" }] });
    const verifier = await item.complete(
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "verify independently" }] },
      2_000,
      { role: "verifier_initial" },
    );
    assert.notEqual(verifier.providerSessionId, first.providerSessionId);
    await assert.rejects(item.complete(
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "replacement history" }] },
      2_000,
      { priorProviderSessionId: first.providerSessionId },
    ), /append to the exact prior conversation/i);

    const replacement = new CodexSubscriptionInferenceUpstream({
      command: process.execPath,
      commandPrefixArgs: ["--experimental-strip-types", fake, "content"],
      expectedVersion: /^codex-cli 0\.147\.0$/,
      codexHome: item.home,
      scratchRoot: item.scratch,
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      outputSchemaPath: join(item.root, "schema.json"),
      stopTimeoutMs: 100,
    });
    await assert.rejects(replacement.complete({
      capabilityId: "icap_codex_subscription_fixture", requestId: "ireq_after_restart",
      provider: "openai-codex-subscription", model: "gpt-5.6-sol", role: "implementer",
      priorProviderSessionId: first.providerSessionId,
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "initial" }, { role: "user", content: "later" }] },
      timeoutMs: 2_000, signal: new AbortController().signal,
    }), /not owned by this live control-plane process/i);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});
