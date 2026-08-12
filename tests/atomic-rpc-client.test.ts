import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import {
  AtomicRpcClient,
  AtomicRpcCommandError,
  AtomicRpcProtocolError,
  AtomicRpcStopUncertainError,
  AtomicRpcStoppedError,
  AtomicRpcTimeoutError,
  JsonlLfDecoder,
  type AtomicRpcClientOptions,
  type AtomicRpcNativeEvent,
  type AtomicRpcProtocolIssue,
} from "../apps/control-plane/src/atomic-rpc-client.ts";

const fakeScript = resolve("scripts/fake-atomic-rpc.ts");

function startFake(
  t: TestContext,
  clientOptions: AtomicRpcClientOptions = {},
  env: Record<string, string> = {},
): AtomicRpcClient {
  const client = new AtomicRpcClient({
    command: process.execPath,
    commandArgs: ["--experimental-strip-types", fakeScript],
    requestTimeoutMs: 2_000,
    stopTimeoutMs: 1_000,
    ...clientOptions,
  });
  client.start({ cwd: process.cwd(), env });
  t.after(async () => client.stop());
  return client;
}

async function nextEvent(client: AtomicRpcClient): Promise<AtomicRpcNativeEvent> {
  const [event] = await once(client, "event");
  return event as AtomicRpcNativeEvent;
}

async function nextProtocolIssue(client: AtomicRpcClient): Promise<AtomicRpcProtocolIssue> {
  const [issue] = await once(client, "protocol_error");
  return issue as AtomicRpcProtocolIssue;
}

test("Atomic RPC decoder is UTF-8 safe, LF-only, CRLF tolerant, and bounded", () => {
  const decoder = new JsonlLfDecoder({ maxLineBytes: 128 });
  const frame = Buffer.from(`${JSON.stringify({ text: "before\u2028after\u2029🙂" })}\r\n`, "utf8");
  const emoji = frame.indexOf(Buffer.from("🙂", "utf8"));
  assert.deepEqual(decoder.push(frame.subarray(0, emoji + 2)), []);
  const records = decoder.push(frame.subarray(emoji + 2));
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).text, "before\u2028after\u2029🙂");
  assert.equal(decoder.finish(), "");

  const bounded = new JsonlLfDecoder({ maxLineBytes: 8 });
  assert.throws(() => bounded.push("123456789"), AtomicRpcProtocolError);

  const invalidUtf8 = new JsonlLfDecoder();
  assert.throws(
    () => invalidUtf8.push(Buffer.from([0xc3, 0x28, 0x0a])),
    (error: unknown) => error instanceof AtomicRpcProtocolError && /invalid UTF-8/.test(error.message),
  );
});

test("Atomic CLI version probe and RPC discovery helpers use the pinned command boundary", async (t) => {
  const client = startFake(t);
  const version = await client.probeVersion();
  assert.equal(version.version, "0.9.12-fake");

  const state = await client.getState<{ sessionId: string; isStreaming: boolean }>();
  assert.equal(state.command, "get_state");
  assert.equal(state.data?.sessionId, "fake-main-session");
  assert.equal(state.data?.isStreaming, false);

  const commands = await client.getCommands<{ commands: Array<{ name: string }> }>();
  assert.deepEqual(commands.data?.commands.map((item) => item.name), [
    "workflow",
    "atomic-routing",
    "skill:atomic-workflow-architect",
  ]);
  const models = await client.getAvailableModels<{ models: Array<{ id: string }> }>();
  assert.equal(models.data?.models[0]?.id, "contract-model");
  const stats = await client.getSessionStats<{ cost: number }>();
  assert.equal(stats.data?.cost, 0.001);
  const entries = await client.getEntries<{ since: string; leafId: string }>("native-entry-0");
  assert.equal(entries.data?.since, "native-entry-0");
  assert.match(entries.data?.leafId ?? "", /^native-entry-/);
  const followUp = await client.followUp("after completion");
  assert.equal(followUp.command, "follow_up");
  await client.respondToExtensionUi({
    type: "extension_ui_response",
    id: "fake-ui-request",
    cancelled: true,
  });
  assert.equal((await client.getState({ timeoutMs: 1_000 })).success, true);
});

test("correlated responses remain separate from asynchronous native events", async (t) => {
  const client = startFake(t);
  const eventPromise = nextEvent(client);
  const response = await client.prompt("contract prompt");
  assert.equal(response.command, "prompt");
  assert.deepEqual(response.data, { echoed: "contract prompt" });
  const event = await eventPromise;
  assert.equal(event.type, "entry_appended");
  assert.equal((event.entry as { content: string }).content, "async:contract prompt");
});

test("bounded startup records replay when the persistence subscriber attaches after spawn", async (t) => {
  const client = startFake(t, {}, { FAKE_ATOMIC_STARTUP_EVENT: "1" });
  assert.equal((await client.getState()).success, true);
  const records: AtomicRpcNativeEvent[] = [];
  const unsubscribe = client.subscribeRecords((record) => records.push(record));
  t.after(unsubscribe);
  assert.ok(records.some((record) => record.type === "entry_appended"
    && (record.entry as { content?: string }).content === "startup-before-first-command"));
});

test("request IDs correlate out-of-order responses", async (t) => {
  const client = startFake(t);
  const slow = client.prompt("__fake:delay:50:slow");
  const fast = client.prompt("__fake:delay:5:fast");
  const fastResult = await fast;
  const slowResult = await slow;
  assert.deepEqual(fastResult.data, { label: "fast" });
  assert.deepEqual(slowResult.data, { label: "slow" });
});

test("split UTF-8, Unicode separators, CRLF, and multiple records preserve framing", async (t) => {
  const client = startFake(t);

  const splitEventPromise = nextEvent(client);
  const splitResponse = await client.prompt("__fake:split_unicode__");
  const splitEvent = await splitEventPromise;
  assert.equal(splitResponse.success, true);
  assert.equal(
    (splitEvent.entry as { content: string }).content,
    "before\u2028after\u2029emoji-🙂",
  );

  const crlf = await client.prompt("__fake:crlf__");
  assert.equal(crlf.success, true);

  const multipleEventPromise = nextEvent(client);
  const multiple = await client.prompt("__fake:multiple__");
  const multipleEvent = await multipleEventPromise;
  assert.equal(multiple.success, true);
  assert.equal((multipleEvent.entry as { content: string }).content, "multiple-record-event");
});

test("native stderr is observable without corrupting stdout JSONL", async (t) => {
  const client = startFake(t);
  const stderrPromise = once(client, "stderr");
  const response = await client.prompt("__fake:stderr__");
  const [stderr] = await stderrPromise;
  assert.equal(response.success, true);
  assert.match(String(stderr), /synthetic native diagnostic/);
});

test("command failures and mismatched response commands reject the right request", async (t) => {
  const client = startFake(t);
  const records: Array<Record<string, unknown>> = [];
  client.on("record", (record) => records.push(record));
  await assert.rejects(client.prompt("__fake:error__"), AtomicRpcCommandError);
  assert.ok(records.some((record) => record.type === "response" && record.success === false));

  const issuePromise = nextProtocolIssue(client);
  await assert.rejects(client.prompt("__fake:mismatch__"), /expected prompt/);
  assert.equal((await issuePromise).kind, "response_command_mismatch");

  const state = await client.getState();
  assert.equal(state.success, true, "a correlated mismatch does not desynchronize later LF records");
});

test("request timeout is bounded and does not require killing the subprocess", async (t) => {
  const client = startFake(t, { requestTimeoutMs: 50 });
  await assert.rejects(client.prompt("__fake:hang__"), AtomicRpcTimeoutError);
  assert.equal((await client.getState({ timeoutMs: 1_000 })).success, true);
});

test("malformed JSON is a fatal protocol error", async (t) => {
  const client = startFake(t);
  const issuePromise = nextProtocolIssue(client);
  await assert.rejects(client.prompt("__fake:malformed__"), AtomicRpcProtocolError);
  assert.equal((await issuePromise).kind, "invalid_json");
});

test("oversized native records are rejected without partial parsing", async (t) => {
  const client = startFake(t, { maxLineBytes: 512 });
  const issuePromise = nextProtocolIssue(client);
  await assert.rejects(client.prompt("__fake:oversized__"), AtomicRpcProtocolError);
  const issue = await issuePromise;
  assert.equal(issue.kind, "line_too_large");
  assert.ok((issue.lineBytes ?? 0) > 512);
});

test("a final JSON object without LF is rejected as a trailing record", async (t) => {
  const client = startFake(t);
  const issuePromise = nextProtocolIssue(client);
  await assert.rejects(client.prompt("__fake:trailing__"), /non-LF-terminated/);
  const issue = await issuePromise;
  assert.equal(issue.kind, "trailing_record");
  assert.match(issue.line ?? "", /\"type\":\"response\"/);
});

test("unexpected process exit rejects every outstanding request", async (t) => {
  const client = startFake(t);
  await assert.rejects(client.prompt("__fake:exit__"), /exited code=7/);
});

test("spawn failures are surfaced and reject requests", async (t) => {
  const client = new AtomicRpcClient({
    command: resolve("/tmp", `missing-atomic-${process.pid}`),
    requestTimeoutMs: 1_000,
  });
  const spawnErrorPromise = once(client, "spawn_error");
  client.start({ cwd: process.cwd() });
  t.after(async () => client.stop());
  const request = client.getState();
  const [spawnError] = await spawnErrorPromise;
  assert.match(String(spawnError), /Failed to spawn Atomic RPC command/);
  await assert.rejects(request, /Failed to spawn|stdin failed/);
});

test("stdin backpressure drains before a large correlated command completes", async (t) => {
  const client = startFake(t, { requestTimeoutMs: 5_000 }, { FAKE_ATOMIC_READ_DELAY_MS: "200" });
  const backpressurePromise = once(client, "backpressure");
  const nativeEvents: AtomicRpcNativeEvent[] = [];
  client.on("event", (event) => nativeEvents.push(event));
  const message = `__fake:large__:${"x".repeat(4 * 1024 * 1024)}`;
  const largeRequest = client.prompt(message);
  const expiredQueuedRequest = client.prompt("must-not-run-after-timeout", { timeoutMs: 50 });
  await assert.rejects(expiredQueuedRequest, AtomicRpcTimeoutError);
  const response = await largeRequest;
  const [backpressure] = await backpressurePromise;
  assert.ok((backpressure as { bytes: number }).bytes > 4 * 1024 * 1024);
  assert.ok(((response.data as { receivedBytes: number }).receivedBytes) > 4 * 1024 * 1024);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  assert.deepEqual(nativeEvents, [], "a timed-out frame queued behind backpressure is never sent later");
});

test("clean stop rejects pending work and is idempotent", async (t) => {
  const client = startFake(t);
  const request = client.prompt("__fake:hang__");
  const rejected = assert.rejects(request, AtomicRpcStoppedError);
  await client.stop();
  await rejected;
  await client.stop();
});

test("stop fails boundedly when inherited stdio prevents the host child close event", async () => {
  const client = new AtomicRpcClient({
    command: process.execPath,
    commandArgs: ["--experimental-strip-types", fakeScript],
    requestTimeoutMs: 1_000,
    stopTimeoutMs: 50,
  });
  client.start({
    cwd: process.cwd(),
    env: { FAKE_ATOMIC_HOLD_STDIO_AFTER_PARENT_MS: "750" },
  });
  assert.equal((await client.getState()).success, true);
  const startedAt = Date.now();
  await assert.rejects(client.stop(), AtomicRpcStopUncertainError);
  assert.ok(Date.now() - startedAt < 500, "host transport cleanup uncertainty is reported within the hard bound");
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 800));
  await client.stop().catch(() => undefined);
});
