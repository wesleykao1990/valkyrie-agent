import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadControlPlaneAuth, validateLoopbackControlPlaneApi } from "../apps/control-plane/src/auth.ts";
import {
  DIRECT_CODEX_APPROVAL_ACTION,
  DIRECT_CODEX_ARTIFACTS,
  DIRECT_CODEX_MODEL_WORKFLOW,
} from "../apps/control-plane/src/direct-model-pilot.ts";
import { ATOMIC_MODEL_PILOT_WORKFLOW } from "../apps/control-plane/src/atomic-model-pilot-coordinator.ts";
import { ATOMIC_MODEL_PILOT_TASK_ID } from "../apps/control-plane/src/atomic-model-pilot-lifecycle.ts";
import { ATOMIC_FIXTURE_PROJECT_ID } from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

const root = resolve(".");
const apiBase = validateLoopbackControlPlaneApi(process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787");
const timeoutMs = Number(process.env.VALKYRIE_M6_SMOKE_TIMEOUT_MS ?? "420000");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000) throw new Error("VALKYRIE_M6_SMOKE_TIMEOUT_MS is invalid");
const suppliedAtomicRunId = process.env.VALKYRIE_M6_ATOMIC_RUN_ID?.trim();
const idempotencyKey = process.env.VALKYRIE_M6_SMOKE_IDEMPOTENCY_KEY?.trim()
  || `m6-direct-live-${Date.now()}-${process.pid}`;

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Artifact { id: string; kind: string; uri: string; checksum: string; mediaType: string }
interface Detail {
  run: { id: string; taskId?: string | null; rootRuntime: string; workflow?: string | null; status: string; stage?: string | null; metadata: Record<string, unknown> };
  artifacts: Artifact[];
  approvals: Array<{ id: string; action: string; state: string; evidenceDigest?: string | null }>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";
  private sequence = 0;
  constructor(environment: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, ["--experimental-strip-types", "apps/mcp-server/src/index.ts"], {
      cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("MCP process exited before the M6 smoke completed")));
  }
  async initialize(): Promise<void> {
    await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m6-direct-comparison-smoke", version: "1" } });
  }
  async tools(): Promise<string[]> {
    const response = object(await this.rpc("tools/list"), "tools/list");
    return response.tools.map((item: unknown) => String(object(item, "tool").name));
  }
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = object(await this.rpc("tools/call", { name, arguments: args }), name);
    const first = object(response.content?.[0], `${name} content`);
    if (typeof first.text !== "string") throw new Error(`${name} returned non-text content`);
    return JSON.parse(first.text) as T;
  }
  async close(): Promise<void> {
    this.child.kill("SIGTERM");
    await Promise.race([new Promise<void>((done) => this.child.once("exit", () => done())), delay(1_000)]);
    if (this.stderr.trim()) process.stderr.write(this.stderr);
  }
  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, Math.min(timeoutMs, 45_000));
      timer.unref(); this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const boundary = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, boundary).replace(/\r$/u, ""); this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      const response = object(JSON.parse(line), "MCP response");
      if (!Number.isSafeInteger(response.id)) continue;
      const pending = this.pending.get(Number(response.id)); if (!pending) continue;
      this.pending.delete(Number(response.id)); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(String(object(response.error, "MCP error").message ?? "MCP call failed")));
      else pending.resolve(response.result);
    }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

async function waitForApproval(client: McpClient, runId: string, label: string): Promise<Detail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await client.call<Detail>("run_get", { runId });
    if (detail.run.status === "awaiting_approval") return detail;
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) {
      throw new Error(`${label} candidate ended ${detail.run.status} at ${String(detail.run.stage)}`);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label} evidence for ${runId}`);
}

const environment = { ...process.env };
if (!environment.CONTROL_PLANE_AUTH_TOKEN?.trim() && !environment.CONTROL_PLANE_AUTH_TOKEN_FILE?.trim()) {
  environment.CONTROL_PLANE_AUTH_TOKEN_FILE = "data/auth/control-plane.token";
}
const auth = loadControlPlaneAuth(environment);
if (!auth) throw new Error("M6 live smoke requires the control-plane auth token or token file");
const allowed = [
  "runtimes_status", "runs_start", "run_get", "atomic_model_fixture_artifact_read",
  "direct_codex_fixture_artifact_read", "run_compare", "comparison_get",
];
environment.CONTROL_PLANE_API = apiBase;
environment.CONTROL_PLANE_AUTH_TOKEN = auth.token;
delete environment.CONTROL_PLANE_AUTH_TOKEN_FILE;
environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = allowed.join(",");

const client = new McpClient(environment);
try {
  await client.initialize();
  const tools = await client.tools();
  if (JSON.stringify(tools) !== JSON.stringify(allowed)) throw new Error(`MCP exposed another tool set: ${tools.join(",")}`);
  const runtimes = await client.call<Array<Record<string, unknown>>>("runtimes_status");
  const direct = runtimes.find((item) => item.workflow === DIRECT_CODEX_MODEL_WORKFLOW);
  const claude = runtimes.find((item) => item.workflow === "direct-claude-code-fixture-model-pilot");
  if (!direct || direct.available !== true || direct.modelExecutionAttempted !== false) throw new Error("Direct Codex candidate is not ready");
  if (!claude || claude.available !== false) throw new Error("Claude Code candidate did not remain separately fail-closed");

  let atomicRunId = suppliedAtomicRunId;
  if (!atomicRunId) {
    const atomicStart = {
      projectId: ATOMIC_FIXTURE_PROJECT_ID, taskId: ATOMIC_MODEL_PILOT_TASK_ID,
      objective: ATOMIC_FIXTURE_MODEL_REQUEST, runtime: "atomic", workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
      maxCostUsd: 1, idempotencyKey: `atomic:${idempotencyKey}`,
    };
    const started = await client.call<any>("runs_start", atomicStart);
    const replayed = await client.call<any>("runs_start", atomicStart);
    atomicRunId = started.run?.run?.id;
    if (typeof atomicRunId !== "string" || replayed.run?.run?.id !== atomicRunId) throw new Error("Atomic idempotent admission failed");
    await waitForApproval(client, atomicRunId, "Atomic");
  }
  const atomic = await client.call<Detail>("run_get", { runId: atomicRunId });
  if (atomic.run.rootRuntime !== "atomic" || atomic.run.workflow !== ATOMIC_MODEL_PILOT_WORKFLOW
      || atomic.run.taskId !== ATOMIC_MODEL_PILOT_TASK_ID || !["awaiting_approval", "completed"].includes(atomic.run.status)
      || atomic.artifacts.length === 0) throw new Error("Supplied Atomic comparison run is not exact verified M5b evidence");

  const start = {
    projectId: ATOMIC_FIXTURE_PROJECT_ID, taskId: ATOMIC_MODEL_PILOT_TASK_ID,
    objective: ATOMIC_FIXTURE_MODEL_REQUEST, runtime: "codex", workflow: DIRECT_CODEX_MODEL_WORKFLOW,
    maxCostUsd: 1, idempotencyKey,
  };
  const first = await client.call<any>("runs_start", start);
  const replay = await client.call<any>("runs_start", start);
  const runId = first.run?.run?.id;
  if (typeof runId !== "string" || replay.run?.run?.id !== runId) throw new Error("Direct Codex idempotent admission failed");
  const detail = await waitForApproval(client, runId, "direct Codex");
  if (detail.run.rootRuntime !== "codex" || detail.run.workflow !== DIRECT_CODEX_MODEL_WORKFLOW
      || detail.artifacts.length !== DIRECT_CODEX_ARTIFACTS.length
      || detail.run.metadata.modelExecutionAttempted !== true || detail.run.metadata.liveProviderVerified !== true
      || detail.run.metadata.externalActionPerformed !== false) throw new Error("Direct Codex live evidence is incomplete");
  const approval = detail.approvals.filter((item) => item.action === DIRECT_CODEX_APPROVAL_ACTION && item.state === "pending");
  if (approval.length !== 1) throw new Error("Direct Codex did not stop at exactly one evidence-bound approval");
  if (!detail.events.some((event) => event.type === "inference.native.raw")
      || !detail.events.some((event) => event.type === "inference.request.completed")) {
    throw new Error("Direct Codex native and normalized inference evidence is incomplete");
  }
  for (const kind of ["candidate-patch", "deterministic-checks-final", "fresh-model-verifier-final", "direct-codex-evidence"]) {
    const artifact = detail.artifacts.find((item) => item.kind === kind);
    if (!artifact) throw new Error(`Direct Codex review artifact ${kind} is missing`);
    const read = await client.call<any>("direct_codex_fixture_artifact_read", { runId, artifactId: artifact.id });
    if (read.checksum !== artifact.checksum || sha(String(read.content)) !== artifact.checksum
        || read.evidenceDigest !== approval[0]!.evidenceDigest) throw new Error(`${kind} lost its approval binding`);
  }

  const compared = await client.call<any>("run_compare", {
    projectId: ATOMIC_FIXTURE_PROJECT_ID, taskId: ATOMIC_MODEL_PILOT_TASK_ID,
    objective: ATOMIC_FIXTURE_MODEL_REQUEST, runtimes: ["atomic", "codex"],
    candidateRunIds: [atomicRunId, runId], perRunMaxCostUsd: 1,
    idempotencyKey: `comparison:${idempotencyKey}`,
  });
  const comparison = await client.call<any>("comparison_get", { comparisonId: compared.comparisonId });
  if (comparison.comparison?.status !== "complete" || comparison.candidates?.length !== 2
      || comparison.candidates.some((item: any) => item.metrics?.correctness !== "passed" || !item.evidenceDigest)) {
    throw new Error("M6 comparison metrics did not finalize from both evidence sets");
  }
  console.log(`M6 evidence ready: comparison=${compared.comparisonId}, atomic=${atomicRunId}, codex=${runId}, directApproval=${approval[0]!.id}`);
  console.log("Stopped before either candidate approval. No PR, merge, deployment, product DB mutation, credential expansion, or memory promotion occurred.");
} finally {
  await client.close();
}
