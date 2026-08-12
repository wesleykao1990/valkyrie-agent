import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { loadControlPlaneAuth, validateLoopbackControlPlaneApi } from "../apps/control-plane/src/auth.ts";
import { canonicalJson } from "../apps/control-plane/src/store.ts";
import {
  ATOMIC_FIXTURE_APPROVAL_ACTION,
  ATOMIC_FIXTURE_APPROVAL_EFFECT,
  ATOMIC_FIXTURE_PROJECT_ID,
  ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS,
  ATOMIC_FIXTURE_RUNTIME_VERSION,
  ATOMIC_FIXTURE_TASK_ID,
  ATOMIC_FIXTURE_WORKFLOW_NAME,
} from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import { ATOMIC_FIXTURE_REQUEST } from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";

/**
 * Opt-in live M5 proof for an already-running authenticated control plane.
 *
 *   CONTROL_PLANE_API=http://127.0.0.1:8787 \
 *   CONTROL_PLANE_AUTH_TOKEN_FILE=data/auth/control-plane.token \
 *   npm run smoke:atomic-fixture
 *
 * The default leaves the run-generated memory proposal in `proposed`. Set
 * VALKYRIE_ATOMIC_FIXTURE_SMOKE_REJECT_MEMORY=true only when the operator also
 * wants this smoke to reject that proposal through its separately allow-listed
 * MCP mutation.
 */
const root = resolve(".");
const apiBase = validateLoopbackControlPlaneApi(process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787");
const timeoutMs = positiveInteger(
  process.env.VALKYRIE_ATOMIC_FIXTURE_SMOKE_TIMEOUT_MS ?? "300000",
  "VALKYRIE_ATOMIC_FIXTURE_SMOKE_TIMEOUT_MS",
);
const rejectMemory = booleanFlag(
  process.env.VALKYRIE_ATOMIC_FIXTURE_SMOKE_REJECT_MEMORY,
  "VALKYRIE_ATOMIC_FIXTURE_SMOKE_REJECT_MEMORY",
);
const budgetUsd = 0.25;
const idempotencyKey = process.env.VALKYRIE_ATOMIC_FIXTURE_SMOKE_IDEMPOTENCY_KEY?.trim()
  || `atomic-fixture-live-smoke-v1-${Date.now()}-${process.pid}`;
const terminalStates = new Set(["completed", "failed", "cancelled"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

const governedArtifacts = Object.freeze([
  { relativePath: ".valkyrie-output/evidence.json", kind: "atomic-pilot-evidence", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/candidate.patch", kind: "candidate-patch", mediaType: "text/x-diff" },
  { relativePath: ".valkyrie-output/checks.json", kind: "deterministic-checks", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/verifier.json", kind: "fresh-deterministic-verifier", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/memory-proposal.json", kind: "memory-proposal-draft", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/draft-pr-mock.json", kind: "draft-pr-mock", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/context-pack.json", kind: "project-brain-context-pack", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/run-contract.json", kind: "run-contract", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/atomic-launch-manifest.json", kind: "atomic-launch-manifest", mediaType: "application/json" },
]);

interface RuntimePreflight {
  runtime?: string;
  adapter?: string;
  enabled?: boolean;
  available?: boolean;
  executionMode?: string;
  workflow?: string;
  modelExecutionAttempted?: boolean;
  version?: string;
  reason?: string;
  provider?: { reason?: string };
}

interface Artifact {
  id: string;
  runId: string;
  kind: string;
  uri: string;
  checksum: string;
  mediaType: string;
  createdAt: string;
}

interface RunEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface Approval {
  id: string;
  runId: string;
  action: string;
  exactEffect: string;
  state: string;
  evidence: string[];
  projectId?: string | null;
  workflow?: string | null;
  evidenceDigest?: string | null;
  policyHash?: string | null;
  expiresAt?: string | null;
  decision?: string | null;
}

interface RunDetail {
  run: {
    id: string;
    taskId?: string | null;
    projectId: string;
    rootRuntime: string;
    workflow?: string | null;
    status: string;
    stage?: string | null;
    budgetUsd: number;
    costUsd: number;
    workspaceId?: string | null;
    nativeRunId?: string | null;
    metadata: Record<string, unknown>;
  };
  events: RunEvent[];
  approvals: Approval[];
  artifacts: Artifact[];
}

interface MemoryProposal {
  id: string;
  projectId: string;
  runId?: string | null;
  claim: string;
  evidence: string[];
  state: string;
  targetNote?: string | null;
}

interface ProjectBrief {
  pendingApprovals?: Approval[];
  memoryProposals?: MemoryProposal[];
}

interface ArtifactReview {
  runId: string;
  approvalId: string;
  artifactId: string;
  kind: string;
  mediaType: string;
  checksum: string;
  sizeBytes: number;
  evidenceDigest: string;
  content: string;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function booleanFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function governedUri(runId: string, relativePath: string): string {
  return `artifact://runs/${encodeURIComponent(runId)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function artifactDigest(artifacts: readonly Artifact[]): string {
  return sha256(canonicalJson(artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    checksum: artifact.checksum,
    mediaType: artifact.mediaType,
  })).sort((left, right) => left.kind.localeCompare(right.kind))));
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function failureReason(detail: RunDetail): string {
  const metadata = detail.run.metadata;
  return String(
    metadata.atomicFixtureFailure
    ?? metadata.sandboxIsolationReason
    ?? metadata.sandboxFailureCode
    ?? metadata.reconciliationReason
    ?? "no failure reason was recorded",
  );
}

class StdioMcpClient {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly rpcTimeoutMs: number;
  private sequence = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;

  constructor(environment: NodeJS.ProcessEnv, rpcTimeoutMs: number) {
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.process = spawn(process.execPath, ["--experimental-strip-types", "apps/mcp-server/src/index.ts"], {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: string) => { this.stderrBuffer += chunk; });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`MCP process exited before completing the smoke (code=${String(code)}, signal=${String(signal)})`));
    });
  }

  async initialize(): Promise<void> {
    const initialized = plainObject(await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "atomic-fixture-live-smoke", version: "1" },
    }), "MCP initialize result");
    const serverInfo = plainObject(initialized.serverInfo, "MCP serverInfo");
    assertEqual(serverInfo.name, "wesley-agent-control-plane", "Unexpected MCP server identity");
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const result = plainObject(await this.rpc("tools/list"), "MCP tools/list result");
    if (!Array.isArray(result.tools)) throw new Error("MCP tools/list omitted its tools array");
    return result.tools.map((item) => plainObject(item, "MCP tool"));
  }

  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = plainObject(await this.rpc("tools/call", { name, arguments: args }), `${name} result`);
    if (result.isError === true || !Array.isArray(result.content)) throw new Error(`${name} returned an invalid MCP content envelope`);
    const first = plainObject(result.content[0], `${name} first content item`);
    if (first.type !== "text" || typeof first.text !== "string") throw new Error(`${name} did not return JSON text content`);
    try {
      return JSON.parse(first.text) as T;
    } catch {
      throw new Error(`${name} returned non-JSON text content`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolvePromise) => this.process.once("exit", () => resolvePromise())),
      delay(1_000).then(() => undefined),
    ]);
    if (this.stderrBuffer.trim()) process.stderr.write(this.stderrBuffer);
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP process is closed"));
    const id = ++this.sequence;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`MCP ${method} timed out after ${this.rpcTimeoutMs}ms${this.stderrSuffix()}`));
      }, this.rpcTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response: Record<string, unknown>;
      try { response = plainObject(JSON.parse(line), "MCP response"); }
      catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (!Number.isInteger(response.id)) continue;
      const pending = this.pending.get(Number(response.id));
      if (!pending) continue;
      this.pending.delete(Number(response.id));
      clearTimeout(pending.timer);
      if (response.error) {
        const rpcError = plainObject(response.error, "MCP error");
        pending.reject(new Error(`${String(rpcError.message ?? "MCP call failed")}${this.stderrSuffix()}`));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${error.message}${this.stderrSuffix()}`));
    }
    this.pending.clear();
  }

  private stderrSuffix(): string {
    const stderr = this.stderrBuffer.trim();
    return stderr ? `; MCP stderr: ${stderr.slice(-1_000)}` : "";
  }
}

function assertPreflight(preflights: RuntimePreflight[]): RuntimePreflight {
  const pilot = preflights.find((item) =>
    item.runtime === "atomic"
    && item.workflow === ATOMIC_FIXTURE_WORKFLOW_NAME
    && item.executionMode === "isolated-writer");
  if (!pilot) {
    throw new Error("The control plane does not expose the Atomic fixture isolated-writer preflight; enable ATOMIC_FIXTURE_PILOT_ENABLED on the separately running server");
  }
  if (pilot.adapter !== "native" || pilot.enabled !== true || pilot.modelExecutionAttempted !== false) {
    throw new Error("Atomic fixture preflight does not retain its native credential-free isolated-writer contract");
  }
  if (pilot.available !== true) {
    throw new Error(`Atomic fixture runner is unavailable: ${pilot.reason ?? pilot.provider?.reason ?? "preflight returned no reason"}`);
  }
  if (pilot.version !== ATOMIC_FIXTURE_RUNTIME_VERSION) {
    throw new Error(`Atomic fixture preflight did not observe pinned Atomic ${ATOMIC_FIXTURE_RUNTIME_VERSION} inside the exact runner image`);
  }
  return pilot;
}

function verifyRawAndNormalizedEvents(detail: RunDetail): void {
  const nativeSessionId = detail.run.metadata.nativeSessionId;
  const nativeWorkflowRunId = detail.run.metadata.nativeWorkflowRunId;
  if (typeof nativeSessionId !== "string" || !nativeSessionId) throw new Error("Run metadata omitted Atomic's native main session ID");
  if (typeof nativeWorkflowRunId !== "string" || !nativeWorkflowRunId) throw new Error("Run metadata omitted Atomic's native workflow run ID");
  assertEqual(detail.run.nativeRunId, nativeWorkflowRunId, "Control-plane nativeRunId is not the native workflow run ID");

  const raw = detail.events.filter((event) => event.type === "runtime.native");
  if (raw.length < 8) throw new Error(`Atomic fixture retained only ${raw.length} raw native records; expected at least 8`);
  const indices = new Set<number>();
  for (const event of raw) {
    assertEqual(event.payload.runtime, "atomic", "Raw native event has the wrong runtime");
    if (!event.payload.rawNative || typeof event.payload.rawNative !== "object") throw new Error("Raw Atomic event omitted its native payload");
    const index = event.payload.nativeRecordIndex;
    if (!Number.isSafeInteger(index) || Number(index) < 1) throw new Error("Raw Atomic event has an invalid native record index");
    if (indices.has(Number(index))) throw new Error("Raw Atomic event occurrence indexes are not unique");
    indices.add(Number(index));
  }
  const running = detail.events.find((event) => event.type === "atomic.workflow.running");
  const completed = detail.events.find((event) =>
    event.type === "atomic.workflow.completed"
    && event.payload.nativeWorkflowRunId === nativeWorkflowRunId);
  if (!running || !completed) throw new Error("Atomic fixture omitted normalized native workflow running/completed evidence");
}

function verifyArtifactsAndApproval(detail: RunDetail): Approval {
  if (detail.artifacts.length !== governedArtifacts.length) {
    throw new Error(`Atomic fixture produced ${detail.artifacts.length} governed artifacts; expected ${governedArtifacts.length}`);
  }
  const byKind = new Map(detail.artifacts.map((artifact) => [artifact.kind, artifact]));
  if (byKind.size !== governedArtifacts.length) throw new Error("Atomic fixture governed artifact kinds are not unique");
  for (const expected of governedArtifacts) {
    const artifact = byKind.get(expected.kind);
    if (!artifact) throw new Error(`Atomic fixture omitted governed artifact ${expected.kind}`);
    assertEqual(artifact.runId, detail.run.id, `${expected.kind} belongs to another run`);
    assertEqual(artifact.mediaType, expected.mediaType, `${expected.kind} has the wrong media type`);
    assertEqual(artifact.uri, governedUri(detail.run.id, expected.relativePath), `${expected.kind} has the wrong governed URI`);
    if (!sha256Pattern.test(artifact.checksum)) throw new Error(`${expected.kind} has an invalid SHA-256 checksum`);
  }

  const approvals = detail.approvals.filter((approval) => approval.action === ATOMIC_FIXTURE_APPROVAL_ACTION);
  if (approvals.length !== 1) throw new Error(`Atomic fixture has ${approvals.length} evidence-bound acceptance approvals; expected exactly one`);
  const approval = approvals[0]!;
  assertEqual(approval.runId, detail.run.id, "Atomic fixture approval belongs to another run");
  assertEqual(approval.state, "pending", "Atomic fixture approval is not pending");
  assertEqual(approval.exactEffect, ATOMIC_FIXTURE_APPROVAL_EFFECT, "Atomic fixture approval exact effect changed");
  assertEqual(approval.projectId, ATOMIC_FIXTURE_PROJECT_ID, "Atomic fixture approval project binding changed");
  assertEqual(approval.workflow, ATOMIC_FIXTURE_WORKFLOW_NAME, "Atomic fixture approval workflow binding changed");
  if (!sha256Pattern.test(String(approval.evidenceDigest ?? ""))) throw new Error("Atomic fixture approval has an invalid evidence digest");
  if (!sha256Pattern.test(String(approval.policyHash ?? ""))) throw new Error("Atomic fixture approval has an invalid sandbox policy hash");
  assertEqual(approval.evidenceDigest, artifactDigest(detail.artifacts), "Atomic fixture approval evidence digest does not bind the governed artifacts");
  const expectedEvidence = [...detail.artifacts]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.uri.localeCompare(right.uri))
    .map((artifact) => `${artifact.kind}:${artifact.uri}#sha256=${artifact.checksum}`);
  if (canonicalJson(approval.evidence) !== canonicalJson(expectedEvidence)) {
    throw new Error("Atomic fixture approval evidence refs do not exactly bind all governed artifacts");
  }
  if (!approval.expiresAt || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) {
    throw new Error("Atomic fixture approval is already expired or has no valid expiry");
  }
  return approval;
}

function verifyEvidenceReady(detail: RunDetail): Approval {
  const run = detail.run;
  assertEqual(run.projectId, ATOMIC_FIXTURE_PROJECT_ID, "Atomic fixture run project changed");
  assertEqual(run.taskId, ATOMIC_FIXTURE_TASK_ID, "Atomic fixture run task changed");
  assertEqual(run.rootRuntime, "atomic", "Atomic fixture has another root runtime");
  assertEqual(run.workflow, ATOMIC_FIXTURE_WORKFLOW_NAME, "Atomic fixture workflow changed");
  assertEqual(run.status, "awaiting_approval", "Atomic fixture did not stop at the human gate");
  assertEqual(run.stage, "approval", "Atomic fixture did not enter its approval stage");
  assertEqual(run.budgetUsd, budgetUsd, "Atomic fixture persisted another budget");
  assertEqual(run.costUsd, 0, "Credential-free Atomic fixture reported a non-zero control-plane cost");
  assertEqual(run.metadata.requestedObjective, ATOMIC_FIXTURE_REQUEST, "Atomic fixture literal objective changed");
  assertEqual(run.metadata.approvalPolicy && plainObject(run.metadata.approvalPolicy, "approval policy").preparePr, "human", "Atomic fixture approval policy changed");
  assertEqual(run.metadata.adapter, "atomic-fixture-pilot", "Atomic fixture adapter binding changed");
  assertEqual(run.metadata.executionMode, "isolated-writer", "Atomic fixture execution mode changed");
  assertEqual(run.metadata.atomicVersion, ATOMIC_FIXTURE_RUNTIME_VERSION, "Atomic fixture persisted another Atomic version");
  const runnerImageRef = run.metadata.atomicRunnerImageRef;
  const runnerImageDigest = run.metadata.atomicRunnerImageDigest;
  if (typeof runnerImageRef !== "string" || !/@sha256:[a-f0-9]{64}$/.test(runnerImageRef)) {
    throw new Error("Atomic fixture omitted its exact immutable runner image reference");
  }
  assertEqual(runnerImageDigest, runnerImageRef.slice(runnerImageRef.lastIndexOf("@") + 1), "Atomic runner digest evidence changed");
  if (!sha256Pattern.test(String(run.metadata.atomicRunnerProvenanceDigest ?? ""))) {
    throw new Error("Atomic fixture omitted its reviewed runner provenance digest");
  }
  if (canonicalJson(run.metadata.atomicRunnerProvenanceLabels) !== canonicalJson(ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS)) {
    throw new Error("Atomic fixture persisted another runner provenance label set");
  }
  assertEqual(run.metadata.atomicRunnerPreflightNetwork, "none", "Atomic runner preflight was not offline");
  assertEqual(run.metadata.modelExecutionAttempted, false, "Atomic fixture run metadata claims model execution");
  assertEqual(run.metadata.automaticEpisodicCapture, false, "Atomic fixture enabled automatic episodic capture");
  assertEqual(run.metadata.crossProcessResume, false, "Atomic fixture overstated cross-process resumability");
  assertEqual(run.metadata.nativeSessionCostUsd, 0, "Atomic native session reported a non-zero model cost");
  assertEqual(run.metadata.nativeSessionTokens, 0, "Atomic native session reported model tokens");
  assertEqual(run.metadata.atomicFixtureModelExecutionAttempted, false, "Atomic fixture attempted model execution");
  assertEqual(run.metadata.atomicFixtureChecksPassed, true, "Atomic fixture deterministic checks did not pass");
  assertEqual(run.metadata.atomicFixtureVerifierPassed, true, "Atomic fixture fresh deterministic verifier did not pass");
  assertEqual(run.metadata.atomicFixtureFrozenExportsValidated, true, "Atomic fixture governed exports were not rebound to the native snapshot");
  assertEqual(run.metadata.sandboxEvidenceReady, true, "Atomic fixture sandbox did not reach evidence-ready cleanup");
  assertEqual(run.metadata.containerCleaned, true, "Atomic fixture container cleanup is not proven");
  assertEqual(run.metadata.writerWorkspaceRemoved, true, "Atomic fixture worktree cleanup is not proven");
  assertEqual(run.metadata.writerLeaseReleased, true, "Atomic fixture still has a live writer-lease claim");
  assertEqual(run.metadata.externalActionPerformed, false, "Atomic fixture performed an external final action");
  if (detail.events.some((event) => event.payload?.externalActionPerformed === true)) {
    throw new Error("Atomic fixture event evidence reports an external final action");
  }
  assertEqual(run.metadata.artifactCount, governedArtifacts.length, "Atomic fixture artifact count metadata changed");
  if (run.metadata.safeMockAcceptanceReceipt === true) throw new Error("Atomic fixture recorded acceptance before human approval");
  verifyRawAndNormalizedEvents(detail);
  return verifyArtifactsAndApproval(detail);
}

function verifyProposedMemory(brief: ProjectBrief, detail: RunDetail, approval: Approval): MemoryProposal {
  const proposals = (brief.memoryProposals ?? []).filter((proposal) => proposal.runId === detail.run.id);
  if (proposals.length !== 1) throw new Error(`Atomic fixture has ${proposals.length} proposed memory records; expected exactly one`);
  const proposal = proposals[0]!;
  assertEqual(proposal.projectId, ATOMIC_FIXTURE_PROJECT_ID, "Atomic fixture memory proposal project changed");
  assertEqual(proposal.state, "proposed", "Atomic fixture memory was silently resolved or promoted");
  if (proposal.claim.length < 10) throw new Error("Atomic fixture memory proposal claim is missing");
  if (canonicalJson(proposal.evidence) !== canonicalJson(approval.evidence)) {
    throw new Error("Atomic fixture memory proposal is not bound to the approval evidence");
  }
  const pending = (brief.pendingApprovals ?? []).filter((candidate) => candidate.id === approval.id);
  if (pending.length !== 1) throw new Error("Project brief does not expose the Atomic fixture pending approval");
  return proposal;
}

function verifyAccepted(detail: RunDetail, approvalId: string): void {
  assertEqual(detail.run.status, "completed", "Approved Atomic fixture did not complete");
  assertEqual(detail.run.stage, "accepted_mock_final_action", "Approved Atomic fixture did not stop at the safe mock receipt");
  assertEqual(detail.run.costUsd, 0, "Approved Atomic fixture changed its control-plane cost");
  assertEqual(detail.run.metadata.safeMockAcceptanceReceipt, true, "Approved Atomic fixture omitted the safe mock receipt");
  assertEqual(detail.run.metadata.externalActionPerformed, false, "Approved Atomic fixture performed an external final action");
  assertEqual(detail.run.metadata.memoryPromoted, false, "Approved Atomic fixture promoted memory");
  assertEqual(detail.run.metadata.writerLeaseReleased, true, "Approved Atomic fixture regained a writer lease");
  assertEqual(detail.run.metadata.containerCleaned, true, "Approved Atomic fixture no longer proves container cleanup");
  const approval = detail.approvals.find((candidate) => candidate.id === approvalId);
  if (!approval) throw new Error("Approved Atomic fixture response omitted its approval record");
  assertEqual(approval.state, "approved", "Atomic fixture approval was not recorded as approved");
  assertEqual(approval.decision, "approve", "Atomic fixture approval recorded another decision");
  const accepted = detail.events.filter((event) =>
    event.type === "atomic.fixture.accepted"
    && event.payload.approvalId === approvalId
    && event.payload.externalActionPerformed === false
    && event.payload.memoryPromoted === false);
  if (accepted.length !== 1) throw new Error("Atomic fixture safe acceptance event is missing or duplicated");
}

async function waitForApproval(client: StdioMcpClient, runId: string): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: RunDetail | undefined;
  while (Date.now() < deadline) {
    last = await client.call<RunDetail>("run_get", { runId });
    if (last.run.status === "awaiting_approval") return last;
    if (terminalStates.has(last.run.status)) {
      throw new Error(`Atomic fixture run ${runId} ended ${last.run.status} before approval: ${failureReason(last)}`);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Atomic fixture run ${runId}; last status=${last?.run.status ?? "unknown"}, stage=${last?.run.stage ?? "unknown"}`);
}

const authEnvironment = { ...process.env };
if (!authEnvironment.CONTROL_PLANE_AUTH_TOKEN?.trim() && !authEnvironment.CONTROL_PLANE_AUTH_TOKEN_FILE?.trim()) {
  authEnvironment.CONTROL_PLANE_AUTH_TOKEN_FILE = "data/auth/control-plane.token";
}
const auth = loadControlPlaneAuth(authEnvironment);
if (!auth) throw new Error("Atomic fixture live smoke requires CONTROL_PLANE_AUTH_TOKEN or CONTROL_PLANE_AUTH_TOKEN_FILE");

const allowedTools = [
  "runtimes_status",
  "runs_start",
  "run_get",
  "atomic_fixture_artifact_read",
  "project_get_brief",
  "atomic_fixture_approval_resolve",
];
if (rejectMemory) allowedTools.push("memory_reject");
const mcpEnvironment = { ...process.env };
mcpEnvironment.CONTROL_PLANE_API = apiBase;
mcpEnvironment.CONTROL_PLANE_AUTH_TOKEN = auth.token;
delete mcpEnvironment.CONTROL_PLANE_AUTH_TOKEN_FILE;
mcpEnvironment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = allowedTools.join(",");

const client = new StdioMcpClient(mcpEnvironment, Math.min(timeoutMs, 45_000));
try {
  await client.initialize();
  const tools = await client.listTools();
  const toolNames = tools.map((tool) => String(tool.name));
  if (canonicalJson([...toolNames].sort()) !== canonicalJson([...allowedTools].sort())) {
    throw new Error(`MCP did not expose the exact Atomic fixture smoke allowlist: ${toolNames.join(", ")}`);
  }

  const preflights = await client.call<RuntimePreflight[]>("runtimes_status");
  if (!Array.isArray(preflights)) throw new Error("runtimes_status did not return an array");
  const pilot = assertPreflight(preflights);
  console.log(`Atomic fixture runner ready: ${pilot.reason ?? "isolated-writer preflight passed"}`);

  const startArguments = {
    projectId: ATOMIC_FIXTURE_PROJECT_ID,
    taskId: ATOMIC_FIXTURE_TASK_ID,
    objective: ATOMIC_FIXTURE_REQUEST,
    runtime: "atomic",
    workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
    maxCostUsd: budgetUsd,
    idempotencyKey,
  };
  const first = await client.call<{ run?: RunDetail }>("runs_start", startArguments);
  const replay = await client.call<{ run?: RunDetail }>("runs_start", startArguments);
  const runId = first.run?.run?.id;
  if (!runId) throw new Error("runs_start omitted the Atomic fixture control-plane run ID");
  assertEqual(replay.run?.run?.id, runId, "Atomic fixture idempotent start replay created another run");
  console.log(`Atomic fixture admitted: run=${runId}, idempotency=${idempotencyKey}, budget=$${budgetUsd.toFixed(2)}`);

  const approvalReady = await waitForApproval(client, runId);
  const approval = verifyEvidenceReady(approvalReady);
  const reviewTargets = approvalReady.artifacts.filter((artifact) => [
    "candidate-patch",
    "deterministic-checks",
    "fresh-deterministic-verifier",
    "atomic-pilot-evidence",
  ].includes(artifact.kind));
  if (reviewTargets.length !== 4) throw new Error("Atomic fixture omitted a human-review evidence artifact");
  for (const artifact of reviewTargets) {
    const review = await client.call<ArtifactReview>("atomic_fixture_artifact_read", {
      runId,
      artifactId: artifact.id,
    });
    assertEqual(review.approvalId, approval.id, `${artifact.kind} review belongs to another approval`);
    assertEqual(review.checksum, artifact.checksum, `${artifact.kind} review checksum changed`);
    assertEqual(review.evidenceDigest, approval.evidenceDigest, `${artifact.kind} review lost approval binding`);
    assertEqual(sha256(review.content), artifact.checksum, `${artifact.kind} returned content does not hash to its evidence`);
  }
  const brief = await client.call<ProjectBrief>("project_get_brief", { projectId: ATOMIC_FIXTURE_PROJECT_ID });
  const proposal = verifyProposedMemory(brief, approvalReady, approval);
  console.log(`Evidence gate ready: ${approvalReady.artifacts.length} checksummed governed artifacts (${reviewTargets.length} read back through MCP), ${approvalReady.events.filter((event) => event.type === "runtime.native").length} raw Atomic records, approval=${approval.id}`);

  const accepted = await client.call<RunDetail>("atomic_fixture_approval_resolve", {
    approvalId: approval.id,
    decision: "approve",
  });
  verifyAccepted(accepted, approval.id);
  const afterBrief = await client.call<ProjectBrief>("project_get_brief", { projectId: ATOMIC_FIXTURE_PROJECT_ID });
  const stillProposed = (afterBrief.memoryProposals ?? []).find((candidate) => candidate.id === proposal.id);
  if (!stillProposed || stillProposed.state !== "proposed") {
    throw new Error("Safe mock acceptance silently resolved or promoted the governed memory proposal");
  }

  if (rejectMemory) {
    const rejected = await client.call<MemoryProposal>("memory_reject", { proposalId: proposal.id });
    assertEqual(rejected.state, "rejected", "Explicit smoke cleanup did not reject the memory proposal");
    if (rejected.targetNote) throw new Error("Rejected Atomic fixture memory unexpectedly has a canonical target");
    console.log(`Memory proposal explicitly rejected by smoke opt-in: ${proposal.id}`);
  } else {
    console.log(`Memory proposal remains proposed for governed review: ${proposal.id}`);
  }
  console.log(`Atomic fixture live smoke passed: run=${runId}; native Atomic workflow, deterministic checks, fresh verifier, sandbox/worktree/lease cleanup, evidence-bound approval, and safe mock receipt verified. No model cost/tokens, PR, merge, deployment, external/product database mutation, credential expansion, or memory promotion occurred.`);
} finally {
  await client.close();
}
