import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(".");
const dataDir = mkdtempSync(join(tmpdir(), "wesley-acp-smoke-"));
const port = 18877 + Math.floor(Math.random() * 1000);
const api = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ["--experimental-strip-types", "apps/control-plane/src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    DEMO_STAGE_DELAY_MS: "10",
  },
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
  env: { ...process.env, CONTROL_PLANE_API: api },
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
  const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const listed = await rpc("tools/list");
  const projects = await rpc("tools/call", { name: "projects_list", arguments: {} });
  const memory = await rpc("tools/call", { name: "memory_search", arguments: { projectId: "ovalo", query: "terminology latency" } });
  const toolNames = new Set((listed.tools ?? []).map((tool: any) => tool.name));
  if (initialized.serverInfo?.name !== "wesley-agent-control-plane") throw new Error("Unexpected MCP server identity");
  if (!toolNames.has("runs_start") || !toolNames.has("memory_promote")) throw new Error("Expected MCP tools were not listed");
  if (!projects.content?.[0]?.text?.includes("Ovalo")) throw new Error("projects_list did not return seeded projects");
  if (!memory.content?.[0]?.text?.toLowerCase().includes("terminology")) throw new Error("memory_search did not return accepted project context");
  console.log(`MCP smoke passed: ${listed.tools.length} tools, portfolio and memory calls succeeded.`);
} finally {
  mcp.kill("SIGTERM");
  server.kill("SIGTERM");
  await delay(100);
  rmSync(dataDir, { recursive: true, force: true });
  if (mcpError.trim()) process.stderr.write(mcpError);
}
