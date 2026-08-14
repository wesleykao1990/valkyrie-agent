const kind = process.argv[2];
const behavior = process.argv[3] ?? "success";
const args = process.argv.slice(4);

if (kind !== "codex" && kind !== "claude") {
  process.stderr.write("fake runtime requires codex or claude\n");
  process.exit(2);
}

if (args.includes("--version")) {
  process.stdout.write(kind === "codex" ? "codex-cli 0.147.0-alpha.6.5\n" : "2.1.81 (Claude Code)\n");
  process.exit(0);
}

if (kind === "codex" && args.includes("login") && args.includes("status")) {
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (kind === "claude" && args.includes("auth") && args.includes("status")) {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "fixture" })}\n`);
  process.exit(0);
}

let receivedPrompt = "";
for await (const chunk of process.stdin) receivedPrompt += chunk.toString("utf8");
const promptInArgv = args.some((argument) => argument.includes("VALKYRIE_FIXTURE_OK"));
const expectedMarker = /Return exactly ([A-Z][A-Z0-9_]{2,63}) and nothing else\./.exec(receivedPrompt)?.[1]
  ?? "MISSING_CONNECTIVITY_MARKER";
const reportedMarker = behavior === "wrong-marker" ? "WRONG_MARKER" : expectedMarker;
const isolationArgs = {
  bare: args.includes("--bare"),
  strictMcp: args.includes("--strict-mcp-config"),
  noChrome: args.includes("--no-chrome"),
  noSessionPersistence: args.includes("--no-session-persistence"),
  settingSourcesDisabled: args[args.indexOf("--setting-sources") + 1] === "",
};

if (behavior === "malformed") {
  process.stdout.write("{not-json}\n");
  process.exit(0);
}

if (behavior === "ignore-term-no-session") {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1_000);
} else

if (behavior === "slow") {
  const session = kind === "codex"
    ? { type: "thread.started", thread_id: "codex-fixture-slow", leakedSecret: process.env.VALKYRIE_TEST_SECRET ?? null }
    : { type: "system", subtype: "init", session_id: "claude-fixture-slow", leakedSecret: process.env.VALKYRIE_TEST_SECRET ?? null };
  Object.assign(session, { promptBytes: Buffer.byteLength(receivedPrompt), promptInArgv, isolationArgs });
  process.stdout.write(`${JSON.stringify(session)}\n`);
  setTimeout(() => process.exit(0), 30_000).unref();
} else if (kind === "codex") {
  const records = [
    { type: "thread.started", thread_id: "codex-fixture-session", leakedSecret: process.env.VALKYRIE_TEST_SECRET ?? null, promptBytes: Buffer.byteLength(receivedPrompt), promptInArgv, isolationArgs },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: reportedMarker } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
  ];
  process.stdout.write(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
} else {
  const records = [
    { type: "system", subtype: "init", session_id: "claude-fixture-session", leakedSecret: process.env.VALKYRIE_TEST_SECRET ?? null, promptBytes: Buffer.byteLength(receivedPrompt), promptInArgv, isolationArgs },
    { type: "assistant", message: { content: [{ type: "text", text: reportedMarker }] }, session_id: "claude-fixture-session" },
    { type: "result", subtype: "success", is_error: false, result: reportedMarker, session_id: "claude-fixture-session", total_cost_usd: 0.01 },
  ];
  process.stdout.write(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
