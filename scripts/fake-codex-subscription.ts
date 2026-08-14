const behavior = process.argv[2] ?? "content";
const args = process.argv.slice(3);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.147.0\n");
  process.exit(0);
}
if (args.includes("login") && args.includes("status")) {
  process.stdout.write(behavior === "logged-out" ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exit(behavior === "logged-out" ? 1 : 0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");

const { appendFileSync, existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const tracePath = join(process.env.TMPDIR ?? "/tmp", "fake-codex-subscription-trace.jsonl");
let priorInvocations = 0;
if (existsSync(tracePath)) priorInvocations = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).length;
appendFileSync(tracePath, `${JSON.stringify({ args, prompt })}\n`, { encoding: "utf8", mode: 0o600 });

const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0;
const resumeThread = resumed
  ? args.find((item, index) => index > resumeIndex && /^codex-session-[0-9]+$/u.test(item))
  : undefined;
const threadId = resumeThread ?? `codex-session-${priorInvocations + 1}`;

const required = [
  "exec", "--json", "--ignore-user-config",
  "--ignore-rules", "--strict-config", "--output-schema", "-C", "-m", "-",
];
if (behavior === "assert-isolation") {
  const disabled = new Set(args.flatMap((item, index) => item === "--disable" ? [args[index + 1]] : []).filter(Boolean));
  const requiredDisabled = ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "multi_agent", "multi_agent_v2"];
  const promptInArgv = args.some((item) => item.includes("SECRET_PROMPT_SENTINEL"));
  const inherited = process.env.VALKYRIE_PARENT_SECRET;
  if (required.some((item) => !args.includes(item)) || !args.includes("--sandbox") || !args.includes("read-only")
      || args.includes("--ephemeral") || requiredDisabled.some((item) => !disabled.has(item))
      || promptInArgv || inherited || !prompt.includes("SECRET_PROMPT_SENTINEL")) {
    process.stderr.write("isolation contract failed\n");
    process.exit(3);
  }
}
if (behavior === "slow") {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1_000);
} else if (behavior === "malformed") {
  process.stdout.write("{bad-json}\n");
} else {
  const final = behavior === "tool"
    ? JSON.stringify({ content: "", tool_calls: [{ name: "write_fixture", arguments_json: JSON.stringify({ path: "src/message.ts", content: "fixed" }) }] })
    : JSON.stringify({ content: "bounded subscription response", tool_calls: [] });
  const records: Record<string, unknown>[] = [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
  ];
  if (behavior === "internal-tool") {
    records.push({ type: "item.completed", item: { id: "tool-1", type: "command_execution", command: "pwd" } });
  }
  records.push({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: final } });
  if (behavior !== "missing-usage") {
    records.push({ type: "turn.completed", usage: { input_tokens: 137, output_tokens: 29 } });
  }
  process.stdout.write(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
