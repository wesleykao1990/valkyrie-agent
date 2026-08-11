import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

const token = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";

interface PendingResponse {
  resolve: (response: any) => void;
  reject: (error: Error) => void;
}

test("MCP sends bearer auth and enforces its configured tool allowlist", async () => {
  const receivedAuthorization: Array<string | undefined> = [];
  const api = createServer((request, response) => {
    receivedAuthorization.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "Unauthorized" }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/runtimes") {
      return response.end(JSON.stringify([{ runtime: "codex", available: true }]));
    }
    return response.end(JSON.stringify({ projects: [{ id: "ovalo" }] }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const port = (api.address() as AddressInfo).port;
  const environment = { ...process.env };
  delete environment.CONTROL_PLANE_AUTH_TOKEN_FILE;
  environment.CONTROL_PLANE_AUTH_TOKEN = token;
  environment.CONTROL_PLANE_API = `http://127.0.0.1:${port}`;
  environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = "projects_list,runtimes_status,runs_start";
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "apps/mcp-server/src/index.ts"],
    { cwd: resolve("."), env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );

  const pending = new Map<number, PendingResponse>();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (true) {
      const boundary = stdout.indexOf("\n");
      if (boundary < 0) break;
      const line = stdout.slice(0, boundary).replace(/\r$/, "");
      stdout = stdout.slice(boundary + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  let nextId = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    return new Promise<any>((resolveResponse, reject) => {
      pending.set(id, { resolve: resolveResponse, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
  };

  try {
    const initialized = await rpc("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(initialized.result.serverInfo.name, "wesley-agent-control-plane");
    const listed = await rpc("tools/list");
    assert.deepEqual(listed.result.tools.map((item: any) => item.name), ["projects_list", "runtimes_status", "runs_start"]);
    const runStartTool = listed.result.tools.find((item: any) => item.name === "runs_start");
    assert.deepEqual(runStartTool.inputSchema.properties.workflow.enum, ["runtime-connectivity"]);

    const projects = await rpc("tools/call", { name: "projects_list", arguments: {} });
    assert.match(projects.result.content[0].text, /ovalo/);
    const runtimes = await rpc("tools/call", { name: "runtimes_status", arguments: {} });
    assert.match(runtimes.result.content[0].text, /codex/);

    const denied = await rpc("tools/call", { name: "memory_search", arguments: {} });
    assert.equal(denied.error.code, -32601);
    assert.match(denied.error.message, /not available/);
    assert.deepEqual(receivedAuthorization, [`Bearer ${token}`, `Bearer ${token}`]);
    assert.doesNotMatch(stderr, new RegExp(token));
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    api.close();
    await once(api, "close");
  }
});

test("MCP rejects an unknown tool name in the allowlist before serving requests", () => {
  const environment = { ...process.env };
  delete environment.CONTROL_PLANE_AUTH_TOKEN_FILE;
  environment.CONTROL_PLANE_AUTH_TOKEN = token;
  environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = "projects_list,raw_shell";
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "apps/mcp-server/src/index.ts"],
    { cwd: resolve("."), env: environment, encoding: "utf8", input: "" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown tool/);
  assert.doesNotMatch(result.stderr, new RegExp(token));
});
