#!/usr/bin/env -S node --experimental-strip-types

/**
 * Deterministic fake for the Atomic JSONL subprocess boundary.
 *
 * It intentionally is not a runtime adapter: tests drive it through the same
 * stdin/stdout pipes as a pinned Atomic CLI. Special prompt messages exercise
 * framing, correlation, timeout, process, stderr, and backpressure failures.
 */

type JsonRecord = Record<string, unknown>;

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(process.env.ATOMIC_TEST_SECRET ? "secret-leaked-to-version-probe\n" : "0.9.12-fake\n");
  process.exit(0);
}

if (!args.some((value, index) => value === "--mode" && args[index + 1] === "rpc")) {
  process.stderr.write("fake-atomic-rpc requires --mode rpc\n");
  process.exit(2);
}

let input = "";
let eventSequence = 0;

function line(value: JsonRecord, ending = "\n"): string {
  return `${JSON.stringify(value)}${ending}`;
}

function write(value: JsonRecord, ending = "\n"): void {
  process.stdout.write(line(value, ending));
}

function response(command: JsonRecord, success = true, data?: unknown, error?: string): JsonRecord {
  return {
    id: command.id,
    type: "response",
    command: command.type,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  };
}

function nativeEvent(message: string): JsonRecord {
  eventSequence += 1;
  return {
    type: "entry_appended",
    entry: {
      id: `native-entry-${eventSequence}`,
      type: "custom_message",
      customType: "workflow.stage.start",
      content: message,
    },
  };
}

function handlePrompt(command: JsonRecord): void {
  const message = String(command.message ?? "");
  if (message === "/workflow list") {
    write({
      type: "message_start",
      customType: "workflows:chat-surface",
      details: {
        kind: "list",
        workflows: ["request-preflight", "idea-to-decision", "project-blueprint"],
      },
    });
    write(response(command, true, { handled: true }));
    return;
  }
  if (message === "__fake:hang__") return;
  if (message === "__fake:exit__") {
    setTimeout(() => process.exit(7), 5);
    return;
  }
  if (message === "__fake:error__") {
    write(response(command, false, undefined, "synthetic Atomic command failure"));
    return;
  }
  if (message === "__fake:mismatch__") {
    write({ ...response(command), command: "get_state" });
    return;
  }
  if (message === "__fake:malformed__") {
    process.stdout.write("{\"type\":\n");
    return;
  }
  if (message === "__fake:oversized__") {
    write({ type: "entry_appended", text: "x".repeat(16_384) });
    return;
  }
  if (message === "__fake:trailing__") {
    process.stdout.write(line(response(command)).slice(0, -1));
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (message === "__fake:stderr__") {
    process.stderr.write("synthetic native diagnostic\n");
    write(response(command, true, { echoed: message }));
    return;
  }
  if (message === "__fake:crlf__") {
    write(response(command, true, { echoed: message }), "\r\n");
    return;
  }
  if (message.startsWith("__fake:large__:")) {
    write(response(command, true, { receivedBytes: Buffer.byteLength(message) }));
    return;
  }
  if (message === "__fake:multiple__") {
    process.stdout.write(`${line(nativeEvent("multiple-record-event"))}${line(response(command, true, { echoed: message }), "\r\n")}`);
    return;
  }
  if (message === "__fake:split_unicode__") {
    const frame = Buffer.from(
      `${line(nativeEvent("before\u2028after\u2029emoji-🙂"))}${line(response(command, true, { echoed: message }))}`,
      "utf8",
    );
    const emojiStart = frame.indexOf(Buffer.from("🙂", "utf8"));
    const splitAt = emojiStart >= 0 ? emojiStart + 2 : Math.floor(frame.length / 2);
    process.stdout.write(frame.subarray(0, splitAt));
    setTimeout(() => process.stdout.write(frame.subarray(splitAt)), 5);
    return;
  }
  const delayed = /^__fake:delay:(\d+):(.*)$/.exec(message);
  if (delayed) {
    const delayMs = Number(delayed[1]);
    const label = delayed[2];
    setTimeout(() => write(response(command, true, { label })), delayMs);
    return;
  }

  write(response(command, true, { echoed: message }));
  setTimeout(() => write(nativeEvent(`async:${message}`)), 5);
}

function handle(command: JsonRecord): void {
  if (typeof command.id !== "string" || typeof command.type !== "string") {
    process.stdout.write("{\"type\":\"response\",\"success\":false,\"error\":\"missing id or type\"}\n");
    return;
  }
  switch (command.type) {
    case "prompt":
      handlePrompt(command);
      return;
    case "steer":
    case "follow_up":
    case "abort":
      write(response(command, true, { echoed: command.message ?? null }));
      return;
    case "extension_ui_response":
      // Atomic's extension UI response half is fire-and-forget.
      return;
    case "get_state":
      write(response(command, true, {
        sessionId: "fake-main-session",
        sessionFile: "/tmp/fake-main-session.jsonl",
        sessionName: "fake-contract",
        isStreaming: false,
        messageCount: 0,
        offline: process.env.ATOMIC_OFFLINE ?? null,
        leakedSecret: process.env.ATOMIC_TEST_SECRET ?? null,
        projectTrustArg: args.includes("--no-approve") ? "--no-approve" : args.includes("--approve") ? "--approve" : null,
      }));
      return;
    case "get_commands":
      write(response(command, true, {
        commands: [
          { name: "workflow", source: "extension" },
          { name: "atomic-routing", source: "extension" },
          { name: "skill:atomic-workflow-architect", source: "extension" },
        ],
      }));
      return;
    case "get_available_models":
      write(response(command, true, {
        models: [{ provider: "fake", id: "contract-model" }],
      }));
      return;
    case "get_entries":
      write(response(command, true, {
        since: command.since ?? null,
        entries: [nativeEvent("cursor-replay").entry],
        leafId: `native-entry-${eventSequence}`,
      }));
      return;
    case "get_session_stats":
      write(response(command, true, {
        tokens: { input: 3, output: 2, total: 5 },
        cost: 0.001,
      }));
      return;
    default:
      write(response(command, false, undefined, `unsupported fake command: ${command.type}`));
  }
}

function consume(chunk: Buffer): void {
  input += chunk.toString("utf8");
  while (true) {
    const index = input.indexOf("\n");
    if (index < 0) return;
    const record = input.slice(0, index).replace(/\r$/, "");
    input = input.slice(index + 1);
    if (!record) continue;
    try {
      const value = JSON.parse(record);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) handle(value as JsonRecord);
      else process.stdout.write("null\n");
    } catch {
      process.stdout.write("{\"type\":\"response\",\"success\":false,\"error\":\"invalid input\"}\n");
    }
  }
}

function attachInput(): void {
  process.stdin.on("data", consume);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

const readDelayMs = Number(process.env.FAKE_ATOMIC_READ_DELAY_MS ?? "0");
if (Number.isFinite(readDelayMs) && readDelayMs > 0) setTimeout(attachInput, readDelayMs);
else attachInput();

process.on("SIGTERM", () => process.exit(0));
