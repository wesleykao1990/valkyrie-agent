import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadControlPlaneAuth, validateLoopbackControlPlaneApi } from "../apps/control-plane/src/auth.ts";

type RuntimeName = "atomic" | "codex" | "claude";

interface RuntimePreflight {
  runtime: string;
  adapter: "mock" | "native";
  enabled: boolean;
  available: boolean;
  executionMode: "simulated" | "read-only";
  command?: string;
  version?: string;
  authenticated?: boolean | "unknown";
  reason?: string;
}

interface RunEvent {
  type: string;
  payload?: Record<string, unknown>;
}

interface Artifact {
  kind: string;
  uri: string;
  checksum: string;
}

interface RunDetail {
  run: {
    id: string;
    rootRuntime: string;
    status: string;
    metadata: Record<string, unknown>;
  };
  events: RunEvent[];
  artifacts: Artifact[];
}

interface PromotionPreview {
  projectId: string;
  proposalId: string;
  target: string;
  path: string;
  content: string;
  contentHash: string;
  previewHash: string;
  approvedBy: string;
  approvedAt: string;
}

const apiBase = validateLoopbackControlPlaneApi(process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787");
const authEnvironment = { ...process.env };
if (!authEnvironment.CONTROL_PLANE_AUTH_TOKEN?.trim() && !authEnvironment.CONTROL_PLANE_AUTH_TOKEN_FILE?.trim()) {
  authEnvironment.CONTROL_PLANE_AUTH_TOKEN_FILE = "data/auth/control-plane.token";
}
const auth = loadControlPlaneAuth(authEnvironment);
if (!auth) throw new Error("Native smoke requires CONTROL_PLANE_AUTH_TOKEN or CONTROL_PLANE_AUTH_TOKEN_FILE");
const authorization = `Bearer ${auth.token}`;
const runTimeoutMs = parsePositiveInteger(process.env.VALKYRIE_NATIVE_SMOKE_TIMEOUT_MS ?? "600000", "VALKYRIE_NATIVE_SMOKE_TIMEOUT_MS");
const requestTimeoutMs = Math.min(runTimeoutMs, 90_000);
const terminalStates = new Set(["completed", "failed", "cancelled"]);

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; authenticated?: boolean; timeoutMs?: number } = {},
): Promise<{ response: Response; body: T }> {
  const headers: Record<string, string> = {};
  if (options.authenticated !== false) headers.authorization = authorization;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs),
  });
  const text = await response.text();
  let body: T;
  try { body = (text ? JSON.parse(text) : null) as T; }
  catch { throw new Error(`${options.method ?? "GET"} ${path} returned non-JSON (HTTP ${response.status})`); }
  return { response, body };
}

async function json<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const result = await request<T>(path, options);
  if (!result.response.ok) {
    const message = typeof (result.body as { error?: unknown } | null)?.error === "string"
      ? (result.body as { error: string }).error
      : `HTTP ${result.response.status}`;
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${message}`);
  }
  return result.body;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertArtifactFiles(artifacts: Artifact[], expectedKinds: string[]): void {
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  for (const kind of expectedKinds) {
    if (!kinds.has(kind)) throw new Error(`Missing ${kind} evidence artifact`);
  }
  for (const artifact of artifacts) {
    if (!/^[a-f0-9]{64}$/.test(artifact.checksum)) throw new Error(`Artifact ${artifact.kind} has an invalid checksum`);
    if (!existsSync(artifact.uri)) throw new Error(`Artifact ${artifact.kind} is not readable on this local pilot host`);
    const actual = sha256(readFileSync(artifact.uri));
    if (actual !== artifact.checksum) throw new Error(`Artifact ${artifact.kind} checksum mismatch`);
  }
}

async function waitForTerminal(runId: string): Promise<RunDetail> {
  const deadline = Date.now() + runTimeoutMs;
  let last: RunDetail | undefined;
  while (Date.now() < deadline) {
    last = await json<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
    if (terminalStates.has(last.run.status)) return last;
    await delay(500);
  }
  throw new Error(`Timed out waiting for run ${runId}; last status was ${last?.run.status ?? "unknown"}`);
}

function verifyRunEvidence(runtime: RuntimeName, detail: RunDetail): void {
  if (detail.run.rootRuntime !== runtime) throw new Error(`${runtime} run was recorded under another root runtime`);
  if (detail.run.status !== "completed") {
    const reason = String(detail.run.metadata.nativeFailure ?? detail.run.metadata.reconciliationReason ?? "no failure reason recorded");
    throw new Error(`${runtime} connectivity run ended ${detail.run.status}: ${reason}`);
  }
  if (detail.run.metadata.adapter !== "native" || detail.run.metadata.crossProcessResume !== false) {
    throw new Error(`${runtime} run did not retain its native/non-resumable boundary`);
  }
  const raw = detail.events.filter((event) => event.type === "runtime.native");
  if (raw.length === 0) throw new Error(`${runtime} run retained no raw native records`);
  if (!raw.every((event) => event.payload && typeof event.payload.rawNative === "object" && Number.isInteger(event.payload.recordIndex))) {
    throw new Error(`${runtime} raw native records are missing payloads or occurrence ordinals`);
  }
  if (!detail.events.some((event) => event.type === "run.completed")) {
    throw new Error(`${runtime} run has no normalized completion event`);
  }
  const commonKinds = ["project-brain-context-pack", "run-contract"];
  const runtimeKinds = runtime === "atomic"
    ? ["atomic-launch-manifest", "atomic-connectivity"]
    : ["native-result"];
  assertArtifactFiles(detail.artifacts, [...commonKinds, ...runtimeKinds]);
  if (runtime === "atomic" && detail.run.metadata.modelExecutionAttempted !== false) {
    throw new Error("Atomic smoke did not retain modelExecutionAttempted=false");
  }
}

function nativeResult(detail: RunDetail): string {
  const artifact = detail.artifacts.find((item) => item.kind === "native-result");
  if (!artifact) throw new Error("Native result artifact is missing");
  return readFileSync(artifact.uri, "utf8");
}

async function startConnectivity(runtime: RuntimeName, marker?: string): Promise<RunDetail> {
  const objective = runtime === "atomic"
    ? "Discover the pinned Atomic package over credential-free offline JSONL RPC. Do not execute a model."
    : `Return exactly ${marker} and nothing else.`;
  const started = await json<{ run?: { run?: { id?: string } } }>("/api/runs", {
    method: "POST",
    timeoutMs: requestTimeoutMs,
    body: {
      projectId: "ovalo",
      objective,
      runtime,
      workflow: "runtime-connectivity",
      maxCostUsd: 1,
      idempotencyKey: `native-smoke-v1-${runtime}-${process.pid}-${Date.now()}`,
    },
  });
  const runId = started.run?.run?.id;
  if (!runId) throw new Error(`${runtime} start response did not contain a run ID`);
  const detail = await waitForTerminal(runId);
  verifyRunEvidence(runtime, detail);
  if (marker && nativeResult(detail).trim() !== marker) {
    throw new Error(`${runtime} result did not exactly equal the requested connectivity marker`);
  }
  console.log(`${runtime}: PASS (${detail.events.filter((event) => event.type === "runtime.native").length} raw records, ${detail.artifacts.length} artifacts, run ${runId})`);
  return detail;
}

async function exerciseGovernedMemory(evidenceRunIds: string[]): Promise<void> {
  const search = await json<{ mode?: string; results?: Array<{ authority?: string; status?: string }> }>(
    "/api/memory/search?projectId=ovalo&q=terminology%20preload",
  );
  if (search.mode !== "read-only-local-vault-prototype" || !search.results?.some((item) => item.authority === "canonical" && item.status === "accepted")) {
    throw new Error("Project Brain search did not return accepted canonical Ovalo context");
  }

  const proposal = await json<{ id?: string; state?: string }>("/api/memory/proposals", {
    method: "POST",
    body: {
      projectId: "ovalo",
      claim: "The native pilot smoke observed bounded read-only connectivity; this test proposal must be rejected, never promoted.",
      evidence: evidenceRunIds.map((runId) => `Local pilot evidence run ${runId}`),
      runId: evidenceRunIds.find(Boolean),
    },
  });
  if (!proposal.id || proposal.state !== "proposed") throw new Error("Memory proposal was not stored in proposed state");

  const preview = await json<PromotionPreview>(`/api/memory/proposals/${encodeURIComponent(proposal.id)}/preview`);
  if (
    preview.projectId !== "ovalo"
    || preview.proposalId !== proposal.id
    || preview.approvedBy !== "wesley"
    || !preview.target.includes("/Decisions/")
    || !preview.content.includes(proposal.id)
    || !/^[a-f0-9]{64}$/.test(preview.contentHash)
    || !/^[a-f0-9]{64}$/.test(preview.previewHash)
  ) {
    throw new Error("Memory promotion preview is incomplete or not bound to the proposal");
  }

  const rejected = await json<{ state?: string; targetNote?: string | null }>(
    `/api/memory/proposals/${encodeURIComponent(proposal.id)}/resolve`,
    { method: "POST", body: { decision: "reject" } },
  );
  if (rejected.state !== "rejected" || rejected.targetNote) {
    throw new Error("Memory proposal was not rejected without a canonical target");
  }
  console.log(`project-brain: PASS (accepted search, proposal ${proposal.id}, exact preview, rejected; no promotion)`);
}

const health = await request<{ ok?: boolean }>("/health", { authenticated: false });
if (!health.response.ok || !health.body?.ok) throw new Error(`Pilot server is not healthy at ${apiBase}`);
const unauthenticated = await request<unknown>("/api/runtimes", { authenticated: false });
if (unauthenticated.response.status !== 401) {
  throw new Error("Pilot /api surface did not reject an unauthenticated request; start it with ./bin/project-os-pilot-server");
}

const preflights = await json<RuntimePreflight[]>("/api/runtimes");
if (!Array.isArray(preflights)) throw new Error("Runtime preflight response was not an array");
console.log(`Authenticated pilot at ${apiBase}`);
for (const runtime of ["atomic", "codex", "claude"] as const) {
  const preflight = preflights.find((item) => item.runtime === runtime);
  if (!preflight) throw new Error(`Runtime preflight omitted ${runtime}`);
  console.log(
    `${runtime} preflight: adapter=${preflight.adapter} available=${preflight.available} `
    + `version=${preflight.version ?? "unknown"} authenticated=${String(preflight.authenticated ?? "unknown")} — ${preflight.reason ?? "no reason"}`,
  );
  if (preflight.adapter !== "native" || preflight.executionMode !== "read-only") {
    throw new Error(`${runtime} is not configured as a native read-only adapter; use ./bin/project-os-pilot-server`);
  }
}

const atomicPreflight = preflights.find((item) => item.runtime === "atomic")!;
const codexPreflight = preflights.find((item) => item.runtime === "codex")!;
const claudePreflight = preflights.find((item) => item.runtime === "claude")!;
if (!atomicPreflight.available) throw new Error(`Atomic preflight failed: ${atomicPreflight.reason ?? "unknown reason"}`);
if (!codexPreflight.available) throw new Error(`Codex preflight failed: ${codexPreflight.reason ?? "unknown reason"}`);

const atomic = await startConnectivity("atomic");
const codex = await startConnectivity("codex", "VALKYRIE_CODEX_LIVE_OK");
const evidenceRunIds = [atomic.run.id, codex.run.id];
if (claudePreflight.available) {
  const claude = await startConnectivity("claude", "VALKYRIE_CLAUDE_LIVE_OK");
  evidenceRunIds.push(claude.run.id);
} else {
  console.log(`claude: SKIP (${claudePreflight.reason ?? "preflight unavailable"})`);
}
await exerciseGovernedMemory(evidenceRunIds);
console.log("Native pilot smoke passed. It performed no repository write, PR, deployment, or canonical-memory promotion action.");
