import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { loadControlPlaneAuth, validateLoopbackControlPlaneApi } from "../apps/control-plane/src/auth.ts";
import {
  ATOMIC_MODEL_PILOT_APPROVAL_ACTION,
  ATOMIC_MODEL_PILOT_ARTIFACTS,
  ATOMIC_MODEL_PILOT_WORKFLOW,
} from "../apps/control-plane/src/atomic-model-pilot-coordinator.ts";
import { ATOMIC_MODEL_PILOT_TASK_ID } from "../apps/control-plane/src/atomic-model-pilot-lifecycle.ts";
import { ATOMIC_FIXTURE_PROJECT_ID } from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

const root = resolve(".");
const apiBase = validateLoopbackControlPlaneApi(process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787");
const timeoutMs = positiveInteger(process.env.VALKYRIE_ATOMIC_MODEL_SMOKE_TIMEOUT_MS ?? "420000", "VALKYRIE_ATOMIC_MODEL_SMOKE_TIMEOUT_MS");
const approve = booleanFlag(process.env.VALKYRIE_ATOMIC_MODEL_SMOKE_APPROVE, "VALKYRIE_ATOMIC_MODEL_SMOKE_APPROVE");
const idempotencyKey = process.env.VALKYRIE_ATOMIC_MODEL_SMOKE_IDEMPOTENCY_KEY?.trim()
  || `atomic-model-live-smoke-v1-${Date.now()}-${process.pid}`;

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Artifact { id: string; kind: string; uri: string; checksum: string; mediaType: string }
interface Approval { id: string; action: string; state: string; evidenceDigest?: string | null; expiresAt?: string | null }
interface Detail {
  run: { id: string; status: string; stage?: string | null; costUsd: number; metadata: Record<string, unknown> };
  artifacts: Artifact[];
  approvals: Approval[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}
function booleanFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
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
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("MCP process exited before the model smoke completed")));
  }
  async initialize(): Promise<void> {
    await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "atomic-model-live-smoke", version: "1" } });
  }
  async tools(): Promise<string[]> {
    const response = object(await this.rpc("tools/list"), "tools/list");
    if (!Array.isArray(response.tools)) throw new Error("tools/list omitted tools");
    return response.tools.map((item) => String(object(item, "tool").name));
  }
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = object(await this.rpc("tools/call", { name, arguments: args }), name);
    if (!Array.isArray(response.content)) throw new Error(`${name} omitted MCP content`);
    const first = object(response.content[0], `${name} content`);
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
      timer.unref();
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const boundary = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, boundary).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      const response = object(JSON.parse(line), "MCP response");
      if (!Number.isSafeInteger(response.id)) continue;
      const pending = this.pending.get(Number(response.id));
      if (!pending) continue;
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

async function waitForApproval(client: McpClient, runId: string): Promise<Detail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await client.call<Detail>("run_get", { runId });
    if (detail.run.status === "awaiting_approval") return detail;
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) {
      throw new Error(`Atomic model pilot ended ${detail.run.status} at ${String(detail.run.stage)}`);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Atomic model evidence for ${runId}`);
}

const environment = { ...process.env };
if (!environment.CONTROL_PLANE_AUTH_TOKEN?.trim() && !environment.CONTROL_PLANE_AUTH_TOKEN_FILE?.trim()) {
  environment.CONTROL_PLANE_AUTH_TOKEN_FILE = "data/auth/control-plane.token";
}
const auth = loadControlPlaneAuth(environment);
if (!auth) throw new Error("Atomic model live smoke requires the control-plane auth token or token file");
const allowed = ["runtimes_status", "runs_start", "run_get", "atomic_model_fixture_artifact_read"];
if (approve) allowed.push("atomic_model_fixture_approval_resolve");
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
  const pilot = runtimes.find((item) => item.workflow === ATOMIC_MODEL_PILOT_WORKFLOW);
  if (!pilot || pilot.available !== true || pilot.modelExecutionAttempted !== false) {
    throw new Error(`Atomic model pilot is not ready: ${String(pilot?.reason ?? "missing preflight")}`);
  }
  const start = {
    projectId: ATOMIC_FIXTURE_PROJECT_ID,
    taskId: ATOMIC_MODEL_PILOT_TASK_ID,
    objective: ATOMIC_FIXTURE_MODEL_REQUEST,
    runtime: "atomic",
    workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
    maxCostUsd: 1,
    idempotencyKey,
  };
  const first = await client.call<any>("runs_start", start);
  const replay = await client.call<any>("runs_start", start);
  const runId = first.run?.run?.id;
  if (typeof runId !== "string" || replay.run?.run?.id !== runId) throw new Error("Atomic model idempotent admission failed");
  const detail = await waitForApproval(client, runId);
  if (detail.artifacts.length !== ATOMIC_MODEL_PILOT_ARTIFACTS.length) throw new Error("Atomic model governed artifact set is incomplete");
  if (detail.run.metadata.liveProviderExpected !== true || detail.run.metadata.liveProviderVerified !== true
      || detail.run.metadata.modelExecutionAttempted !== true || detail.run.metadata.externalActionPerformed !== false) {
    throw new Error("Atomic model run did not prove bounded live provider execution without external action");
  }
  const approval = detail.approvals.filter((item) => item.action === ATOMIC_MODEL_PILOT_APPROVAL_ACTION);
  if (approval.length !== 1 || approval[0].state !== "pending" || !approval[0].expiresAt) {
    throw new Error("Atomic model run did not stop at exactly one pending evidence gate");
  }
  for (const kind of ["candidate-patch", "deterministic-checks-final", "fresh-model-verifier-final", "atomic-model-pilot-evidence"]) {
    const artifact = detail.artifacts.find((item) => item.kind === kind);
    if (!artifact) throw new Error(`Atomic model review artifact ${kind} is missing`);
    const read = await client.call<any>("atomic_model_fixture_artifact_read", { runId, artifactId: artifact.id });
    if (read.checksum !== artifact.checksum || sha(String(read.content)) !== artifact.checksum
        || read.evidenceDigest !== approval[0].evidenceDigest) {
      throw new Error(`Atomic model review artifact ${kind} lost its evidence binding`);
    }
  }
  console.log(`Atomic model evidence ready: run=${runId}, approval=${approval[0].id}, artifacts=${detail.artifacts.length}, cost=$${detail.run.costUsd}`);
  if (approve) {
    const accepted = await client.call<Detail>("atomic_model_fixture_approval_resolve", { approvalId: approval[0].id, decision: "approve" });
    if (accepted.run.status !== "completed" || accepted.run.metadata.safeMockAcceptanceReceipt !== true
        || accepted.run.metadata.externalActionPerformed !== false) throw new Error("Atomic model safe-mock acceptance failed");
    console.log("Operator-authorized safe-mock acceptance recorded; no PR, merge, deployment, product DB mutation, credential expansion, or memory promotion occurred.");
  } else {
    console.log("Stopped before approval. Review the four returned evidence artifacts, then resolve the printed approval separately or rerun with VALKYRIE_ATOMIC_MODEL_SMOKE_APPROVE=true.");
  }
} finally {
  await client.close();
}
