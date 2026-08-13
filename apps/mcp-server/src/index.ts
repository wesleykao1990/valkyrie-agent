import { loadControlPlaneAuth, validateLoopbackControlPlaneApi } from "../../control-plane/src/auth.ts";

const apiBase = validateLoopbackControlPlaneApi(process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787");
const authToken = loadControlPlaneAuth()?.token;
const safeControlPlaneId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface RpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any }

const allTools = [
  tool("projects_list", "List all registered projects and portfolio health.", {}),
  tool("project_get_brief", "Get current roadmap, runs, accepted decisions, approvals, and freshness for one project.", { projectId: stringProp("Project ID") }, ["projectId"]),
  tool("runtimes_status", "Inspect configured runtime adapters, verified availability, authentication, and supported capabilities.", {}),
  tool("engineering_assess", "Persist an explainable control-plane routing assessment for a literal engineering request. Hermes may state an upward-only preference but cannot supply scores or launch a fixed pilot through this tool.", {
    projectId: controlPlaneIdProp("Project ID"),
    taskId: controlPlaneIdProp("Optional current task ID"),
    request: boundedStringProp("Literal user engineering request", 5, 16_000),
    preference: enumProp(["auto", "direct", "atomic-lite", "atomic-full"]),
    finalAction: enumProp(["analysis_only", "prepare_reviewable_result"]),
    idempotencyKey: controlPlaneIdProp("Optional safe retry key"),
  }, ["projectId", "request"]),
  tool("engineering_assessment_get", "Read one durable engineering routing assessment, including source freshness, scores, reasons, and fail-closed execution support.", {
    assessmentId: controlPlaneIdProp("Routing assessment ID"),
  }, ["assessmentId"]),
  tool("idea_capture", "Check for duplicates and capture an idea for a project.", { projectId: stringProp("Project ID"), title: stringProp("Idea title") }, ["projectId", "title"]),
  tool("runs_start", "Start a bounded agent run under control-plane policy.", { projectId: stringProp("Project ID"), taskId: stringProp("Task ID. Fixed pilots require their exact fixture task."), objective: stringProp("Objective. Native connectivity and fixed pilots require their exact published literal objective."), runtime: enumProp(["atomic", "codex", "claude", "prime", "hermes"]), workflow: { ...enumProp(["runtime-connectivity", "atomic-fixture-pilot", "atomic-fixture-model-pilot", "direct-codex-fixture-model-pilot", "direct-claude-code-fixture-model-pilot"]), description: "Select the connectivity probe or one fixed isolated pilot" }, maxCostUsd: numberProp("Maximum cost in USD"), idempotencyKey: stringProp("Optional idempotency key for safe run-create retries") }, ["projectId", "objective"]),
  tool("runs_list", "List recent runs.", {}),
  tool("run_get", "Get one run with events, evidence, approvals, and artifacts.", { runId: stringProp("Run ID") }, ["runId"]),
  tool("atomic_fixture_artifact_read", "Read one bounded, checksum-verified UTF-8 artifact that is bound to the pending disposable Atomic fixture approval.", { runId: controlPlaneIdProp("Atomic fixture run ID"), artifactId: controlPlaneIdProp("Artifact ID from run_get") }, ["runId", "artifactId"]),
  tool("atomic_model_fixture_artifact_read", "Read one bounded, checksum-verified UTF-8 artifact bound to the pending fixed Atomic model-pilot approval.", { runId: controlPlaneIdProp("Atomic model fixture run ID"), artifactId: controlPlaneIdProp("Artifact ID from run_get") }, ["runId", "artifactId"]),
  tool("direct_codex_fixture_artifact_read", "Read one bounded, checksum-verified UTF-8 artifact bound to the pending fixed direct Codex comparison approval.", { runId: controlPlaneIdProp("Direct Codex fixture run ID"), artifactId: controlPlaneIdProp("Artifact ID from run_get") }, ["runId", "artifactId"]),
  tool("run_steer", "Send a bounded steering instruction when the runtime supports it.", { runId: stringProp("Run ID"), message: stringProp("Steering instruction") }, ["runId", "message"]),
  tool("run_compare", "Start or attach the fixed isolated Atomic/direct-Codex comparison under one durable evidence ledger.", { projectId: stringProp("Project ID"), taskId: stringProp("Exact fixed comparison task ID"), objective: stringProp("Exact fixed comparison objective"), runtimes: runtimeArrayProp(), candidateRunIds: arrayProp("Optional existing run IDs in runtime order"), perRunMaxCostUsd: numberProp("Maximum cost per candidate in USD"), idempotencyKey: stringProp("Optional comparison retry key") }, ["projectId", "objective"]),
  tool("comparison_get", "Get one durable comparison and refresh evidence-bound candidate metrics.", { comparisonId: controlPlaneIdProp("Comparison ID") }, ["comparisonId"]),
  tool("run_cancel", "Cancel a non-terminal run.", { runId: stringProp("Run ID") }, ["runId"]),
  tool("approvals_list", "List all approvals, including pending actions that need Wesley.", {}),
  tool("approval_resolve", "Resolve an explicit approval request.", { approvalId: stringProp("Approval ID"), decision: enumProp(["approve", "deny", "request_changes"]) }, ["approvalId", "decision"]),
  tool("atomic_fixture_approval_resolve", "Resolve only the evidence-bound final acceptance gate for the disposable Atomic fixture pilot; this never creates a PR, merges, deploys, or promotes memory.", { approvalId: stringProp("Atomic fixture approval ID"), decision: enumProp(["approve", "deny", "request_changes"]) }, ["approvalId", "decision"]),
  tool("atomic_model_fixture_approval_resolve", "Resolve only the evidence-bound safe-mock gate for the fixed Atomic model pilot; this never creates a PR, merges, deploys, changes a product database, or promotes memory.", { approvalId: controlPlaneIdProp("Atomic model fixture approval ID"), decision: enumProp(["approve", "deny", "request_changes"]) }, ["approvalId", "decision"]),
  tool("direct_codex_fixture_approval_resolve", "Resolve only the evidence-bound safe-mock gate for the fixed direct Codex candidate; this never creates a PR, merges, deploys, changes a product database, or promotes memory.", { approvalId: controlPlaneIdProp("Direct Codex fixture approval ID"), decision: enumProp(["approve", "deny", "request_changes"]) }, ["approvalId", "decision"]),
  tool("memory_search", "Search project-scoped accepted and advisory knowledge in read-only mode; results label authority and status.", { projectId: stringProp("Project ID"), query: stringProp("Search query") }, ["projectId", "query"]),
  tool("memory_propose", "Propose a project learning without promoting it.", { projectId: stringProp("Project ID"), claim: stringProp("Proposed durable claim"), runId: stringProp("Optional run ID"), evidence: arrayProp("Evidence strings") }, ["projectId", "claim"]),
  tool("memory_preview", "Return the exact target and content for human review without writing canonical memory.", { proposalId: stringProp("Proposal ID") }, ["proposalId"]),
  tool("memory_promote", "Promote only the exact preview previously shown to Wesley into accepted Markdown.", { proposalId: stringProp("Proposal ID"), preview: promotionPreviewProp() }, ["proposalId", "preview"]),
  tool("memory_reject", "Reject a memory proposal.", { proposalId: stringProp("Proposal ID") }, ["proposalId"])
];

function selectAllowedTools(environmentValue: string | undefined) {
  if (environmentValue === undefined) return allTools;
  const names = [...new Set(environmentValue.split(",").map((name) => name.trim()).filter(Boolean))];
  const knownNames = new Set(allTools.map((item) => item.name));
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !knownNames.has(name)) {
      throw new Error(`CONTROL_PLANE_MCP_TOOL_ALLOWLIST contains unknown tool ${JSON.stringify(name)}`);
    }
  }
  const selected = new Set(names);
  return allTools.filter((item) => selected.has(item.name));
}

const tools = selectAllowedTools(process.env.CONTROL_PLANE_MCP_TOOL_ALLOWLIST);
const allowedToolNames = new Set(tools.map((item) => item.name));

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
function stringProp(description: string) { return { type: "string", description }; }
function controlPlaneIdProp(description: string) {
  return {
    type: "string",
    description,
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
  };
}
function numberProp(description: string) { return { type: "number", description }; }
function enumProp(values: string[]) { return { type: "string", enum: values }; }
function boundedStringProp(description: string, minLength: number, maxLength: number) {
  return { type: "string", description, minLength, maxLength };
}
function arrayProp(description: string) { return { type: "array", items: { type: "string" }, description }; }
function runtimeArrayProp() { return { type: "array", items: enumProp(["atomic", "codex", "claude", "prime", "hermes"]), minItems: 2, maxItems: 4, description: "Distinct root runtimes to compare" }; }
function promotionPreviewProp() {
  return {
    type: "object",
    description: "The complete, unchanged value returned by memory_preview after human review.",
    properties: {
      projectId: stringProp("Project ID"),
      proposalId: stringProp("Proposal ID"),
      target: stringProp("Relative canonical Project Brain target"),
      path: stringProp("Resolved target path"),
      content: stringProp("Exact canonical Markdown content"),
      contentHash: stringProp("SHA-256 of content"),
      previewHash: stringProp("Bound preview SHA-256"),
      approvedBy: stringProp("Reviewer identity"),
      approvedAt: stringProp("Review timestamp"),
    },
    required: ["projectId", "proposalId", "target", "path", "content", "contentHash", "previewHash", "approvedBy", "approvedAt"],
    additionalProperties: false,
  };
}

async function api(path: string, options?: { method?: string; body?: unknown }) {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const response = await fetch(`${apiBase}${path}`, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

async function callTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "projects_list": return api("/api/portfolio");
    case "project_get_brief": return api(`/api/projects/${encodeURIComponent(args.projectId)}/brief`);
    case "runtimes_status": return api("/api/runtimes");
    case "engineering_assess": return api("/api/engineering/assessments", {
      method: "POST", body: requireEngineeringAssessmentArguments(args),
    });
    case "engineering_assessment_get": return api(
      `/api/engineering/assessments/${encodeURIComponent(requireExactIdArgument(args, "assessmentId"))}`,
    );
    case "idea_capture": return api("/api/ideas", { method: "POST", body: args });
    case "runs_start": return api("/api/runs", { method: "POST", body: args });
    case "runs_list": return api("/api/runs");
    case "run_get": return api(`/api/runs/${encodeURIComponent(args.runId)}`);
    case "atomic_fixture_artifact_read": {
      const { runId, artifactId } = requireArtifactReadArguments(args);
      return api(`/api/atomic-fixture/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
    }
    case "atomic_model_fixture_artifact_read": {
      const { runId, artifactId } = requireArtifactReadArguments(args);
      return api(`/api/atomic-model-fixture/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
    }
    case "direct_codex_fixture_artifact_read": {
      const { runId, artifactId } = requireArtifactReadArguments(args);
      return api(`/api/direct-codex-fixture/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
    }
    case "run_steer": return api(`/api/runs/${encodeURIComponent(args.runId)}/steer`, { method: "POST", body: { message: args.message } });
    case "run_compare": return api("/api/runs/compare", { method: "POST", body: args });
    case "comparison_get": return api(`/api/comparisons/${encodeURIComponent(args.comparisonId)}`);
    case "run_cancel": return api(`/api/runs/${encodeURIComponent(args.runId)}/cancel`, { method: "POST" });
    case "approvals_list": return api("/api/approvals");
    case "approval_resolve": return api(`/api/approvals/${encodeURIComponent(args.approvalId)}/resolve`, { method: "POST", body: { decision: args.decision } });
    case "atomic_fixture_approval_resolve": return api(`/api/atomic-fixture/approvals/${encodeURIComponent(args.approvalId)}/resolve`, { method: "POST", body: { decision: args.decision } });
    case "atomic_model_fixture_approval_resolve": {
      const input = requireModelApprovalArguments(args);
      return api(`/api/atomic-model-fixture/approvals/${encodeURIComponent(input.approvalId)}/resolve`, { method: "POST", body: { decision: input.decision } });
    }
    case "direct_codex_fixture_approval_resolve": {
      const input = requireModelApprovalArguments(args);
      return api(`/api/direct-codex-fixture/approvals/${encodeURIComponent(input.approvalId)}/resolve`, { method: "POST", body: { decision: input.decision } });
    }
    case "memory_search": return api(`/api/memory/search?projectId=${encodeURIComponent(args.projectId)}&q=${encodeURIComponent(args.query)}`);
    case "memory_propose": return api("/api/memory/proposals", { method: "POST", body: args });
    case "memory_preview": return api(`/api/memory/proposals/${encodeURIComponent(args.proposalId)}/preview`);
    case "memory_promote": return api(`/api/memory/proposals/${encodeURIComponent(args.proposalId)}/resolve`, { method: "POST", body: { decision: "promote", preview: args.preview } });
    case "memory_reject": return api(`/api/memory/proposals/${encodeURIComponent(args.proposalId)}/resolve`, { method: "POST", body: { decision: "reject" } });
    default: throw new Error(`Unknown tool ${name}`);
  }
}

function requireArtifactReadArguments(value: unknown): { runId: string; artifactId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Atomic artifact-read arguments must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["artifactId", "runId"])) {
    throw new Error("Atomic artifact read accepts exactly runId and artifactId");
  }
  return {
    runId: requireControlPlaneId(record.runId, "runId"),
    artifactId: requireControlPlaneId(record.artifactId, "artifactId"),
  };
}

function requireEngineeringAssessmentArguments(value: unknown): {
  projectId: string;
  taskId?: string;
  request: string;
  preference?: "auto" | "direct" | "atomic-lite" | "atomic-full";
  finalAction?: "analysis_only" | "prepare_reviewable_result";
  idempotencyKey?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Engineering assessment arguments must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["projectId", "taskId", "request", "preference", "finalAction", "idempotencyKey"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Engineering assessment received an unsupported field");
  }
  if (typeof record.request !== "string" || record.request.trim().length < 5 || record.request.length > 16_000) {
    throw new Error("Engineering request must contain 5 to 16000 characters");
  }
  if (record.preference !== undefined
      && !["auto", "direct", "atomic-lite", "atomic-full"].includes(String(record.preference))) {
    throw new Error("Engineering execution preference is invalid");
  }
  if (record.finalAction !== undefined
      && !["analysis_only", "prepare_reviewable_result"].includes(String(record.finalAction))) {
    throw new Error("Engineering final-action intent is invalid");
  }
  return {
    projectId: requireControlPlaneId(record.projectId, "projectId"),
    request: record.request,
    ...(record.taskId !== undefined ? { taskId: requireControlPlaneId(record.taskId, "taskId") } : {}),
    ...(record.preference !== undefined ? { preference: record.preference as "auto" | "direct" | "atomic-lite" | "atomic-full" } : {}),
    ...(record.finalAction !== undefined ? { finalAction: record.finalAction as "analysis_only" | "prepare_reviewable_result" } : {}),
    ...(record.idempotencyKey !== undefined
      ? { idempotencyKey: requireControlPlaneId(record.idempotencyKey, "idempotencyKey") }
      : {}),
  };
}

function requireExactIdArgument(value: unknown, field: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} arguments must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([field])) {
    throw new Error(`${field} accepts exactly ${field}`);
  }
  return requireControlPlaneId(record[field], field);
}

function requireModelApprovalArguments(value: unknown): { approvalId: string; decision: "approve" | "deny" | "request_changes" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Atomic model approval arguments must be an object");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["approvalId", "decision"])) {
    throw new Error("Atomic model approval accepts exactly approvalId and decision");
  }
  if (record.decision !== "approve" && record.decision !== "deny" && record.decision !== "request_changes") {
    throw new Error("Atomic model approval decision is invalid");
  }
  return { approvalId: requireControlPlaneId(record.approvalId, "approvalId"), decision: record.decision };
}

function requireControlPlaneId(value: unknown, field: string): string {
  if (typeof value !== "string" || !safeControlPlaneId.test(value)) {
    throw new Error(`${field} must be a safe control-plane ID of at most 128 characters`);
  }
  return value;
}

function respond(id: RpcRequest["id"], result?: unknown, error?: { code: number; message: string; data?: unknown }) {
  if (id === undefined || id === null) return;
  const payload = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handle(request: RpcRequest) {
  try {
    if (request.method === "initialize") {
      return respond(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wesley-agent-control-plane", version: "0.3.0" }
      });
    }
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
    if (request.method === "ping") return respond(request.id, {});
    if (request.method === "tools/list") return respond(request.id, { tools });
    if (request.method === "tools/call") {
      const name = request.params?.name;
      if (typeof name !== "string" || !allowedToolNames.has(name)) {
        return respond(request.id, undefined, { code: -32601, message: "Tool is not available through this MCP profile" });
      }
      const args = request.params?.arguments ?? {};
      const value = await callTool(name, args);
      return respond(request.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false });
    }
    respond(request.id, undefined, { code: -32601, message: `Method not found: ${request.method}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    respond(request.id, undefined, { code: -32000, message });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try { void handle(JSON.parse(line)); }
    catch (error) { console.error("Invalid JSON-RPC line", error); }
  }
});
