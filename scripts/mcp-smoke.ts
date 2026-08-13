import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildIsolatedSmokeEnvironment } from "./smoke-environment.ts";

const root = resolve(".");
const temporaryRoot = mkdtempSync(join(tmpdir(), "wesley-acp-smoke-"));
const dataDir = join(temporaryRoot, "data");
const brainDir = join(temporaryRoot, "project-brain");
cpSync(join(root, "project-brain"), brainDir, { recursive: true });
const port = 18877 + Math.floor(Math.random() * 1000);
const api = `http://127.0.0.1:${port}`;
const authToken = "mcp-smoke-local-bearer-token-0123456789";
const allowedTools = [
  "projects_list",
  "runtimes_status",
  "skill_suites_status",
  "runs_start",
  "memory_search",
  "memory_propose",
  "memory_preview",
  "memory_promote",
];

const server = spawn(process.execPath, ["--experimental-strip-types", "apps/control-plane/src/index.ts"], {
  cwd: root,
  env: buildIsolatedSmokeEnvironment({
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    PROJECT_BRAIN_DIR: brainDir,
    DEMO_STAGE_DELAY_MS: "10",
    CONTROL_PLANE_AUTH_TOKEN: authToken,
  }),
  stdio: ["ignore", "pipe", "pipe"],
});

let serverError = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverError += chunk; });

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`Control plane did not become healthy. ${serverError}`);
}

interface Pending { resolve: (value: any) => void; reject: (error: Error) => void }
const mcp = spawn(process.execPath, ["--experimental-strip-types", "apps/mcp-server/src/index.ts"], {
  cwd: root,
  env: buildIsolatedSmokeEnvironment({
    CONTROL_PLANE_API: api,
    CONTROL_PLANE_AUTH_TOKEN: authToken,
    CONTROL_PLANE_MCP_TOOL_ALLOWLIST: allowedTools.join(","),
  }),
  stdio: ["pipe", "pipe", "pipe"],
});
let mcpError = "";
mcp.stderr.setEncoding("utf8");
mcp.stderr.on("data", (chunk) => { mcpError += chunk; });
let buffer = "";
const pending = new Map<number, Pending>();
mcp.stdout.setEncoding("utf8");
mcp.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    const request = pending.get(response.id);
    if (!request) continue;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  }
});

let sequence = 0;
function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++sequence;
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  await waitForHealth();
  const unauthenticated = await fetch(`${api}/api/portfolio`);
  if (unauthenticated.status !== 401) throw new Error("MCP smoke control plane did not enforce bearer authentication");
  const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const listed = await rpc("tools/list");
  const projects = await rpc("tools/call", { name: "projects_list", arguments: {} });
  const runtimeStatus = await rpc("tools/call", { name: "runtimes_status", arguments: {} });
  const memory = await rpc("tools/call", { name: "memory_search", arguments: { projectId: "ovalo", query: "terminology latency" } });
  const proposedMemory = await rpc("tools/call", {
    name: "memory_propose",
    arguments: {
      projectId: "ovalo",
      claim: "MCP promotion must use the exact reviewed preview.",
      evidence: ["MCP smoke evidence"],
    },
  });
  const proposal = JSON.parse(proposedMemory.content?.[0]?.text ?? "null");
  const previewResult = await rpc("tools/call", { name: "memory_preview", arguments: { proposalId: proposal?.id } });
  const preview = JSON.parse(previewResult.content?.[0]?.text ?? "null");
  const promotedResult = await rpc("tools/call", {
    name: "memory_promote",
    arguments: { proposalId: proposal?.id, preview },
  });
  const promoted = JSON.parse(promotedResult.content?.[0]?.text ?? "null");
  const runArguments = {
    projectId: "ovalo",
    objective: "Exercise idempotent MCP run creation",
    runtime: "codex",
    maxCostUsd: 2,
    idempotencyKey: "mcp-smoke-run-create",
  };
  const firstRun = await rpc("tools/call", { name: "runs_start", arguments: runArguments });
  const replayedRun = await rpc("tools/call", { name: "runs_start", arguments: runArguments });
  const toolNames = new Set((listed.tools ?? []).map((tool: any) => tool.name));
  const runStartTool = (listed.tools ?? []).find((tool: any) => tool.name === "runs_start");
  const memoryPromoteTool = (listed.tools ?? []).find((tool: any) => tool.name === "memory_promote");
  if (initialized.serverInfo?.name !== "wesley-agent-control-plane") throw new Error("Unexpected MCP server identity");
  if (toolNames.size !== allowedTools.length || allowedTools.some((name) => !toolNames.has(name))) {
    throw new Error("MCP tools/list did not exactly enforce CONTROL_PLANE_MCP_TOOL_ALLOWLIST");
  }
  if (!toolNames.has("runs_start") || !toolNames.has("skill_suites_status") || !toolNames.has("memory_preview") || !toolNames.has("memory_promote")) throw new Error("Expected MCP tools were not listed");
  let disallowedRejected = false;
  try {
    await rpc("tools/call", { name: "approvals_list", arguments: {} });
  } catch (error) {
    disallowedRejected = error instanceof Error && error.message.includes("not available");
  }
  if (!disallowedRejected) throw new Error("MCP accepted a tool call excluded from its allowlist");
  if (!runStartTool?.inputSchema?.properties?.idempotencyKey) throw new Error("runs_start did not advertise optional idempotencyKey");
  if (runStartTool?.inputSchema?.properties?.workflow?.enum?.[0] !== "runtime-connectivity") {
    throw new Error("runs_start did not advertise the explicit native runtime-connectivity workflow");
  }
  if (!memoryPromoteTool?.inputSchema?.required?.includes("preview") || !memoryPromoteTool?.inputSchema?.properties?.preview) {
    throw new Error("memory_promote did not require the exact preview schema");
  }
  if (!projects.content?.[0]?.text?.includes("Ovalo")) throw new Error("projects_list did not return seeded projects");
  if (!runtimeStatus.content?.[0]?.text?.includes('"runtime": "atomic"')) throw new Error("runtimes_status did not return adapter preflight data");
  if (!memory.content?.[0]?.text?.toLowerCase().includes("terminology")) throw new Error("memory_search did not return accepted project context");
  if (preview?.proposalId !== proposal?.id || !preview?.content?.includes(proposal?.claim)) throw new Error("memory_preview did not expose exact target content");
  if (promoted?.state !== "promoted" || !promoted?.targetNote) throw new Error("memory_promote did not accept the unchanged reviewed preview");
  const firstRunId = JSON.parse(firstRun.content?.[0]?.text ?? "null")?.run?.run?.id;
  const replayedRunId = JSON.parse(replayedRun.content?.[0]?.text ?? "null")?.run?.run?.id;
  if (!firstRunId || firstRunId !== replayedRunId) throw new Error("runs_start did not safely replay the idempotent request");
  console.log(`MCP smoke passed: ${listed.tools.length} allowlisted authenticated tools, runtime status, governed memory preview/promotion, portfolio calls, and idempotent run replay succeeded.`);
} finally {
  mcp.kill("SIGTERM");
  server.kill("SIGTERM");
  await delay(100);
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (mcpError.trim()) process.stderr.write(mcpError);
}
