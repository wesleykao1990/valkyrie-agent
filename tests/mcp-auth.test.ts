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
    if (request.url === "/api/skill-suites") {
      return response.end(JSON.stringify({ enabled: false, rootRef: "private-managed-skill-suites", suites: [] }));
    }
    if (request.url === "/api/engineering/assessments" && request.method === "POST") {
      return response.end(JSON.stringify({ assessment: { id: "route_fixture", selectedShape: "atomic-lite", executionSupported: false } }));
    }
    if (request.url === "/api/engineering/assessments/route_fixture") {
      return response.end(JSON.stringify({ id: "route_fixture", selectedShape: "atomic-lite", executionSupported: false }));
    }
    if (request.url === "/api/atomic-fixture/runs/run_fixture/artifacts/artifact_fixture") {
      return response.end(JSON.stringify({
        runId: "run_fixture",
        artifactId: "artifact_fixture",
        checksum: "a".repeat(64),
        content: "patch bytes\n",
      }));
    }
    if (request.url === "/api/atomic-model-fixture/runs/run_model/artifacts/artifact_model") {
      return response.end(JSON.stringify({
        runId: "run_model",
        artifactId: "artifact_model",
        checksum: "b".repeat(64),
        content: "{\"approved\":true}\n",
      }));
    }
    if (request.url === "/api/atomic-model-fixture/approvals/approval_model/resolve") {
      return response.end(JSON.stringify({ run: { id: "run_model", status: "completed" } }));
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
  environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST =
    "projects_list,runtimes_status,skill_suites_status,engineering_assess,engineering_assessment_get,runs_start,atomic_fixture_artifact_read,atomic_model_fixture_artifact_read,atomic_model_fixture_approval_resolve";
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
    assert.deepEqual(listed.result.tools.map((item: any) => item.name), [
      "projects_list", "runtimes_status", "skill_suites_status", "engineering_assess", "engineering_assessment_get", "runs_start", "atomic_fixture_artifact_read",
      "atomic_model_fixture_artifact_read", "atomic_model_fixture_approval_resolve",
    ]);
    const engineeringTool = listed.result.tools.find((item: any) => item.name === "engineering_assess");
    assert.deepEqual(engineeringTool.inputSchema.required, ["projectId", "request"]);
    assert.equal(engineeringTool.inputSchema.additionalProperties, false);
    assert.equal(engineeringTool.inputSchema.properties.request.maxLength, 16_000);
    assert.equal("structure" in engineeringTool.inputSchema.properties, false, "Hermes cannot submit routing scores");
    const runStartTool = listed.result.tools.find((item: any) => item.name === "runs_start");
    assert.deepEqual(runStartTool.inputSchema.properties.workflow.enum, [
      "runtime-connectivity", "atomic-fixture-pilot", "atomic-fixture-model-pilot",
      "direct-codex-fixture-model-pilot", "direct-claude-code-fixture-model-pilot",
    ]);
    const artifactReadTool = listed.result.tools.find((item: any) =>
      item.name === "atomic_fixture_artifact_read");
    assert.deepEqual(artifactReadTool.inputSchema.required, ["runId", "artifactId"]);
    assert.equal(artifactReadTool.inputSchema.additionalProperties, false);
    for (const property of ["runId", "artifactId"]) {
      assert.equal(artifactReadTool.inputSchema.properties[property].minLength, 1);
      assert.equal(artifactReadTool.inputSchema.properties[property].maxLength, 128);
      assert.equal(artifactReadTool.inputSchema.properties[property].pattern,
        "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$");
    }

    const projects = await rpc("tools/call", { name: "projects_list", arguments: {} });
    assert.match(projects.result.content[0].text, /ovalo/);
    const runtimes = await rpc("tools/call", { name: "runtimes_status", arguments: {} });
    assert.match(runtimes.result.content[0].text, /codex/);
    const suites = await rpc("tools/call", { name: "skill_suites_status", arguments: {} });
    assert.match(suites.result.content[0].text, /private-managed-skill-suites/);
    const assessment = await rpc("tools/call", {
      name: "engineering_assess",
      arguments: {
        projectId: "ovalo", request: "Implement a bounded parser with unit tests.",
        preference: "atomic-lite", finalAction: "prepare_reviewable_result", idempotencyKey: "route_retry_1",
      },
    });
    assert.match(assessment.result.content[0].text, /atomic-lite/);
    const assessmentGet = await rpc("tools/call", {
      name: "engineering_assessment_get", arguments: { assessmentId: "route_fixture" },
    });
    assert.match(assessmentGet.result.content[0].text, /route_fixture/);
    const scoreInjection = await rpc("tools/call", {
      name: "engineering_assess",
      arguments: { projectId: "ovalo", request: "Implement a bounded parser with unit tests.", structure: 0 },
    });
    assert.equal(scoreInjection.error.code, -32000);
    assert.match(scoreInjection.error.message, /unsupported field/);
    const artifact = await rpc("tools/call", {
      name: "atomic_fixture_artifact_read",
      arguments: { runId: "run_fixture", artifactId: "artifact_fixture" },
    });
    assert.match(artifact.result.content[0].text, /patch bytes/);
    const modelArtifact = await rpc("tools/call", {
      name: "atomic_model_fixture_artifact_read",
      arguments: { runId: "run_model", artifactId: "artifact_model" },
    });
    assert.match(modelArtifact.result.content[0].text, /approved/);
    const modelApproval = await rpc("tools/call", {
      name: "atomic_model_fixture_approval_resolve",
      arguments: { approvalId: "approval_model", decision: "approve" },
    });
    assert.match(modelApproval.result.content[0].text, /completed/);

    const invalidArtifact = await rpc("tools/call", {
      name: "atomic_fixture_artifact_read",
      arguments: { runId: "run_fixture/escape", artifactId: "artifact_fixture" },
    });
    assert.equal(invalidArtifact.error.code, -32000);
    assert.match(invalidArtifact.error.message, /safe control-plane ID/);
    const extraArtifactArgument = await rpc("tools/call", {
      name: "atomic_fixture_artifact_read",
      arguments: { runId: "run_fixture", artifactId: "artifact_fixture", path: "/tmp/private" },
    });
    assert.equal(extraArtifactArgument.error.code, -32000);
    assert.match(extraArtifactArgument.error.message, /accepts exactly/);
    assert.doesNotMatch(extraArtifactArgument.error.message, /\/tmp\/private/);

    const denied = await rpc("tools/call", { name: "memory_search", arguments: {} });
    assert.equal(denied.error.code, -32601);
    assert.match(denied.error.message, /not available/);
    assert.deepEqual(receivedAuthorization, Array(8).fill(`Bearer ${token}`));
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

test("MCP exposes bounded production connector and external-action tools only", () => {
  const names = [
    "connectors_status", "connector_dead_letters_list", "connector_dead_letter_replay",
    "external_action_github_draft_pr_prepare", "external_action_linear_evidence_comment_prepare",
    "external_action_linear_issue_prepare",
    "external_action_plans_list", "external_action_plan_get", "external_action_plan_resolve",
  ];
  const environment = { ...process.env };
  delete environment.CONTROL_PLANE_AUTH_TOKEN_FILE;
  environment.CONTROL_PLANE_AUTH_TOKEN = token;
  environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = names.join(",");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "apps/mcp-server/src/index.ts"],
    {
      cwd: resolve("."),
      env: environment,
      encoding: "utf8",
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout.trim()).result.tools;
  assert.deepEqual(listed.map((item: any) => item.name), names);
  for (const item of listed) assert.equal(item.inputSchema.additionalProperties, false);
  const github = listed.find((item: any) => item.name === "external_action_github_draft_pr_prepare");
  assert.deepEqual(github.inputSchema.required, ["runId", "title", "body"]);
  assert.equal("owner" in github.inputSchema.properties, false);
  assert.equal("repo" in github.inputSchema.properties, false);
  assert.equal(github.inputSchema.properties.title.maxLength, 4096);
  const linearIssue = listed.find((item: any) => item.name === "external_action_linear_issue_prepare");
  assert.deepEqual(linearIssue.inputSchema.required, ["runId", "title", "description"]);
  assert.equal("teamId" in linearIssue.inputSchema.properties, false);
  assert.equal("projectId" in linearIssue.inputSchema.properties, false);
  assert.equal(linearIssue.inputSchema.properties.description.maxLength, 4096);
  const resolveTool = listed.find((item: any) => item.name === "external_action_plan_resolve");
  assert.deepEqual(resolveTool.inputSchema.required, ["planId", "decision"]);
  assert.deepEqual(resolveTool.inputSchema.properties.decision.enum, ["approve", "deny", "request_changes"]);
  const deadList = listed.find((item: any) => item.name === "connector_dead_letters_list");
  assert.equal(deadList.inputSchema.properties.limit.maximum, 1000);
});

test("MCP rejects non-origin or non-loopback API targets before loading or sending bearer auth", () => {
  for (const api of [
    "http://example.com:8787",
    "http://user:password@127.0.0.1:8787",
    "http://127.0.0.1:8787/api",
    "http://127.0.0.1:8787/?redirect=external",
  ]) {
    const environment = { ...process.env };
    delete environment.CONTROL_PLANE_AUTH_TOKEN_FILE;
    environment.CONTROL_PLANE_AUTH_TOKEN = token;
    environment.CONTROL_PLANE_API = api;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "apps/mcp-server/src/index.ts"],
      { cwd: resolve("."), env: environment, encoding: "utf8", input: "" },
    );
    assert.notEqual(result.status, 0, api);
    assert.match(result.stderr, /loopback origin/i, api);
    assert.doesNotMatch(result.stderr, new RegExp(token), api);
  }
});
