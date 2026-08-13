import { createHash } from "node:crypto";
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readContainedWorkspaceFile, ATOMIC_FIXTURE_PROJECT_ID } from "./atomic-fixture-pilot.ts";
import { ATOMIC_MODEL_PILOT_TASK_ID } from "./atomic-model-pilot-lifecycle.ts";
import type { ScopedInferenceGateway, ScopedInferencePolicy } from "./scoped-inference-gateway.ts";
import { issueScopedInferenceCapability } from "./scoped-inference-gateway.ts";
import {
  approvalBindingOf, canonicalJson, type ControlPlaneStore, type InferenceRole,
} from "./store.ts";
import type { Approval, Artifact, MemoryProposal, Project, Run, StartRunInput } from "./types.ts";
import type { ArtifactManifestEntry } from "./governed-artifact-export.ts";
import type { OciRunResult, OciSandboxHandle } from "./oci-sandbox-provider.ts";
import {
  WriterSandboxBoundary,
  type WriterSandboxProvider,
  type WriterSandboxValidatedExport,
  type WriterSandboxWorkloadBinding,
} from "./writer-sandbox-boundary.ts";
import {
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  ATOMIC_FIXTURE_TARGET,
  ATOMIC_FIXTURE_TEST,
  ATOMIC_FIXTURE_TEST_SHA256,
} from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

export const DIRECT_CODEX_MODEL_WORKFLOW = "direct-codex-fixture-model-pilot";
export const DIRECT_CLAUDE_MODEL_WORKFLOW = "direct-claude-code-fixture-model-pilot";
export const DIRECT_CODEX_APPROVAL_ACTION = "accept_direct_codex_fixture_result";
export const DIRECT_CODEX_APPROVAL_EFFECT =
  "Record an evidence-bound direct-Codex safe mock receipt in the control-plane ledger only. Do not create a PR, access GitHub, merge, deploy, change an external or product database, expand credential access, or promote memory.";

const OUTPUT_ROOT = ".valkyrie-direct-output";
const PATHS = Object.freeze({
  evidence: `${OUTPUT_ROOT}/evidence.json`,
  patch: `${OUTPUT_ROOT}/candidate.patch`,
  checksInitial: `${OUTPUT_ROOT}/checks-initial.json`,
  verifierInitial: `${OUTPUT_ROOT}/verifier-initial.json`,
  checksFinal: `${OUTPUT_ROOT}/checks-final.json`,
  verifierFinal: `${OUTPUT_ROOT}/verifier-final.json`,
  memoryProposal: `${OUTPUT_ROOT}/memory-proposal.json`,
  draftPrMock: `${OUTPUT_ROOT}/draft-pr-mock.json`,
  contextPack: `${OUTPUT_ROOT}/context-pack.json`,
  runContract: `${OUTPUT_ROOT}/run-contract.json`,
  launchManifest: `${OUTPUT_ROOT}/direct-launch-manifest.json`,
});

export const DIRECT_CODEX_ARTIFACTS: readonly ArtifactManifestEntry[] = Object.freeze([
  [PATHS.evidence, "direct-codex-evidence", "application/json"],
  [PATHS.patch, "candidate-patch", "text/x-diff"],
  [PATHS.checksInitial, "deterministic-checks-initial", "application/json"],
  [PATHS.verifierInitial, "fresh-model-verifier-initial", "application/json"],
  [PATHS.checksFinal, "deterministic-checks-final", "application/json"],
  [PATHS.verifierFinal, "fresh-model-verifier-final", "application/json"],
  [PATHS.memoryProposal, "memory-proposal-draft", "application/json"],
  [PATHS.draftPrMock, "draft-pr-mock", "application/json"],
  [PATHS.contextPack, "project-brain-context-pack", "application/json"],
  [PATHS.runContract, "run-contract", "application/json"],
  [PATHS.launchManifest, "direct-launch-manifest", "application/json"],
].map(([relativePath, kind, mediaType]) => ({ relativePath, kind, mediaType })));

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 8 * 1024;
const MAX_FINDINGS = 8;

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): string { return `${canonicalJson(value)}\n`; }
function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

function privateDirectory(pathInput: string): string {
  const path = resolve(pathInput);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("Direct model context must be a private non-symlink directory");
  }
  return realpathSync(path);
}

function contained(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new Error("Direct model context path escaped its root");
}

function writeExclusive(root: string, relativePath: string, body: string): { sha256: string } {
  const destination = resolve(root, ...relativePath.split("/"));
  contained(root, destination);
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  const fd = openSync(destination, "wx", 0o600);
  try { writeFileSync(fd, body, "utf8"); } finally { closeSync(fd); }
  return { sha256: sha(body) };
}

function parseAssistantContent(result: Awaited<ReturnType<ScopedInferenceGateway["complete"]>>, label: string): string {
  if (result.contentType !== "application/json") throw new Error(`${label} did not return bounded JSON`);
  let response: any;
  try { response = JSON.parse(result.body.toString("utf8")); } catch { throw new Error(`${label} response was invalid JSON`); }
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content || Buffer.byteLength(content) > 128 * 1024) {
    throw new Error(`${label} response omitted bounded assistant content`);
  }
  return content;
}

function parseModelJson(content: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error(`${label} assistant content was not JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} assistant content must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} keys changed from the reviewed schema`);
  }
}

function parseSource(value: Record<string, unknown>, label: string): string {
  exactKeys(value, ["source"], label);
  if (typeof value.source !== "string" || Buffer.byteLength(value.source) < 1 || Buffer.byteLength(value.source) > MAX_SOURCE_BYTES
      || value.source.includes("\0")) throw new Error(`${label} source is outside its bound`);
  return value.source.endsWith("\n") ? value.source : `${value.source}\n`;
}

interface Review { approved: boolean; findings: string[] }
function parseReview(value: Record<string, unknown>, label: string): Review {
  exactKeys(value, ["approved", "findings"], label);
  if (typeof value.approved !== "boolean" || !Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS
      || value.findings.some((item) => typeof item !== "string" || item.length < 1 || item.length > 500)
      || (value.approved && value.findings.length !== 0)) throw new Error(`${label} is outside its reviewed schema`);
  return { approved: value.approved, findings: [...value.findings] as string[] };
}

function artifactDigest(artifacts: readonly Artifact[]): string {
  return sha(canonicalJson(artifacts.map((artifact) => ({
    id: artifact.id, kind: artifact.kind, uri: artifact.uri, checksum: artifact.checksum, mediaType: artifact.mediaType,
  })).sort((left, right) => left.kind.localeCompare(right.kind) || left.uri.localeCompare(right.uri) || left.id.localeCompare(right.id))));
}

function parseJsonArtifact(body: Buffer, label: string): Record<string, any> {
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); }
  catch { throw new Error(`${label} artifact is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} artifact must be an object`);
  return value as Record<string, any>;
}

function writeInContainer(provider: WriterSandboxProvider, handle: OciSandboxHandle, relativePath: string, body: string): Promise<OciRunResult> {
  if (!(new Set<string>([ATOMIC_FIXTURE_TARGET, ...Object.values(PATHS)])).has(relativePath)) throw new Error("Direct model write path is not allowlisted");
  const script = [
    "const fs=require('node:fs'),p=require('node:path');",
    "const allowed=new Set(JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8')));",
    "const target=process.argv[2];if(!allowed.has(target))throw new Error('path');",
    "const body=Buffer.from(process.argv[3],'base64');if(body.length>524288)throw new Error('size');",
    "const full=p.resolve('/workspace/worktree',...target.split('/'));",
    "if(!full.startsWith('/workspace/worktree/'))throw new Error('escape');",
    "fs.mkdirSync(p.dirname(full),{recursive:true,mode:0o700});fs.writeFileSync(full,body,{mode:0o600});",
  ].join("");
  const allowed = Buffer.from(JSON.stringify([ATOMIC_FIXTURE_TARGET, ...Object.values(PATHS)])).toString("base64");
  return provider.execute(handle, ["/usr/local/bin/node", "-e", script, allowed, relativePath, Buffer.from(body).toString("base64")]);
}

async function runChecks(provider: WriterSandboxProvider, handle: OciSandboxHandle, round: "initial" | "final") {
  const commands = [
    ["/usr/local/bin/node", "--test"],
    ["/usr/bin/git", "diff", "--check"],
    ["/usr/bin/git", "diff", "--name-only"],
  ] as const;
  const results = [];
  for (const command of commands) {
    const result = await provider.execute(handle, command);
    results.push({ argv: [...command], exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }
  const changed = results[2]!.stdout.split("\n").map((item) => item.trim()).filter(Boolean).sort();
  const findings: string[] = [];
  if (results[0]!.exit_code !== 0) findings.push("node_test_failed");
  if (results[1]!.exit_code !== 0) findings.push("git_diff_check_failed");
  if (changed.length !== 1 || changed[0] !== ATOMIC_FIXTURE_TARGET) findings.push("changed_file_scope_failed");
  const value = { schema_version: "1.0.0", round, passed: findings.length === 0, findings, commands: results };
  await writeInContainer(provider, handle, round === "initial" ? PATHS.checksInitial : PATHS.checksFinal, json(value));
  return value;
}

async function patchOf(provider: WriterSandboxProvider, handle: OciSandboxHandle): Promise<string> {
  const result = await provider.execute(handle, ["/usr/bin/git", "diff", "--binary", "--", ATOMIC_FIXTURE_TARGET]);
  if (result.exitCode !== 0 || !result.stdout.startsWith(`diff --git a/${ATOMIC_FIXTURE_TARGET} b/${ATOMIC_FIXTURE_TARGET}\n`)) {
    throw new Error("Direct Codex candidate patch is missing or outside the fixed target");
  }
  return result.stdout;
}

export interface DirectModelPilotOptions {
  store: ControlPlaneStore;
  brain: { buildContextPack(project: Project, objective: string, input: { runId: string; taskId?: string }): unknown };
  boundary: WriterSandboxBoundary;
  provider: WriterSandboxProvider;
  gateway: ScopedInferenceGateway;
  policy: ScopedInferencePolicy;
  repositoryPath: string;
  repositoryCommit: string;
  contextRoot: string;
  maxCostUsd: number;
  /** Startup already exercised the reviewed broker/profile or credential boundary. */
  inferenceAuthenticated: boolean;
  approvalTtlMs?: number;
  now?: () => Date;
}

interface PreparedContext {
  token: string;
  capabilityId: string;
  policyHash: string;
  contextPackBody: string;
  runContractBody: string;
  launchBody: string;
}

/** Fixed-contract direct Codex root candidate. It never starts or calls Atomic. */
export class DirectModelPilotCoordinator {
  private readonly options: DirectModelPilotOptions;
  private readonly clock: () => Date;
  private readonly workerId = `direct_codex_${sha(String(Math.random())).slice(0, 24)}`;
  private readonly active = new Map<string, { operation: Promise<void>; abort: AbortController }>();
  private readonly failures = new Map<string, Error>();
  private shuttingDown = false;

  constructor(options: DirectModelPilotOptions) {
    if (!resolve(options.repositoryPath).startsWith("/") || !resolve(options.contextRoot).startsWith("/")
        || !/^[a-f0-9]{40,64}$/.test(options.repositoryCommit)) throw new Error("Direct Codex pilot paths/commit are invalid");
    if (options.inferenceAuthenticated !== true) throw new Error("Direct Codex pilot requires a startup-verified inference boundary");
    this.options = { ...options, contextRoot: privateDirectory(options.contextRoot) };
    this.clock = options.now ?? (() => new Date());
  }

  isPilotRun(run: Run): boolean { return run.rootRuntime === "codex" && run.workflow === DIRECT_CODEX_MODEL_WORKFLOW; }

  validateStart(input: StartRunInput): number {
    if (input.projectId !== ATOMIC_FIXTURE_PROJECT_ID || input.taskId !== ATOMIC_MODEL_PILOT_TASK_ID
        || input.runtime !== "codex" || input.workflow !== DIRECT_CODEX_MODEL_WORKFLOW
        || input.objective !== ATOMIC_FIXTURE_MODEL_REQUEST) throw new Error("Direct Codex pilot requires the exact M5b disposable task contract");
    const budget = input.maxCostUsd ?? this.options.maxCostUsd;
    if (!Number.isFinite(budget) || budget <= 0 || budget > this.options.maxCostUsd) throw new Error("Direct Codex pilot budget exceeds its configured cap");
    return budget;
  }

  async preflight() {
    const provider = await this.options.provider.preflight();
    return {
      enabled: true, available: provider.enabled && provider.available && this.options.inferenceAuthenticated,
      workflow: DIRECT_CODEX_MODEL_WORKFLOW, executionMode: "isolated-writer" as const,
      modelExecutionAttempted: false, authenticated: this.options.inferenceAuthenticated,
      reason: provider.enabled && provider.available && this.options.inferenceAuthenticated
        ? "Direct Codex fixed candidate is ready through the scoped subscription broker; preflight made no model request"
        : provider.reason ?? "Scoped inference authentication was not verified",
    };
  }

  schedule(runId: string): void {
    if (!SAFE_ID.test(runId) || this.shuttingDown || this.active.has(runId)) return;
    const abort = new AbortController();
    const operation = this.runQueued(runId, abort.signal).catch(async (error) => {
      const failure = errorOf(error); this.failures.set(runId, failure);
      const run = await this.options.store.getRun(runId);
      if (run && !["completed", "failed", "cancelled", "awaiting_approval"].includes(run.status)) {
        const at = this.clock().toISOString();
        await this.options.store.updateRun(run.id, {
          status: "failed", stage: "direct_codex_failed", completedAt: at, nextActionAt: null,
          metadata: { ...run.metadata, failureCode: failure.name, externalActionPerformed: false },
        });
        await this.options.store.appendEvent({
          id: `event_direct_failed_${sha(run.id).slice(0, 32)}`, runId: run.id, type: "run.failed",
          message: "Direct Codex candidate failed closed", payload: { externalActionPerformed: false }, createdAt: at,
        });
      }
    }).finally(async () => {
      await this.options.store.releaseRunClaim(runId, this.workerId).catch(() => undefined);
      this.active.delete(runId);
    });
    this.active.set(runId, { operation, abort });
  }

  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.operation;
    const failure = this.failures.get(runId); if (failure) throw failure;
  }

  async cancel(run: Run, resolvedBy = "authenticated-control-plane-client"): Promise<void> {
    if (!this.isPilotRun(run)) throw new Error("Run is not a direct Codex pilot");
    const active = this.active.get(run.id);
    active?.abort.abort(new Error("Direct Codex pilot cancelled by an authenticated control-plane client"));
    if (active) await active.operation;
    const current = await this.options.store.getRun(run.id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
    if (current.status === "awaiting_approval") {
      const approvals = (await this.options.store.listApprovals("pending")).filter((item) => item.runId === current.id && item.action === DIRECT_CODEX_APPROVAL_ACTION);
      if (approvals.length !== 1) throw new Error("Direct Codex cancellation requires one pending approval");
      await this.resolveApproval(approvals[0]!, "deny", resolvedBy);
      return;
    }
    const at = this.clock().toISOString();
    await this.options.store.updateRun(current.id, {
      status: "cancelled", stage: "cancelled", completedAt: at, nextActionAt: null,
      metadata: { ...current.metadata, cancelledBy: resolvedBy, externalActionPerformed: false },
    });
    await this.options.store.appendEvent({
      id: `event_direct_cancel_${sha(current.id).slice(0, 32)}`, runId: current.id, type: "run.cancelled",
      message: "Direct Codex candidate was cancelled without an external action",
      payload: { resolvedBy, externalActionPerformed: false }, createdAt: at,
    });
  }

  async readApprovalArtifact(runId: string, artifactId: string) {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(artifactId)) throw new Error("Direct Codex artifact ID is invalid");
    const run = await this.options.store.getRun(runId);
    if (!run || !this.isPilotRun(run)) throw new Error("Run is not a direct Codex pilot");
    const approvals = (await this.options.store.listApprovals("pending")).filter((item) => item.runId === run.id && item.action === DIRECT_CODEX_APPROVAL_ACTION);
    if (approvals.length !== 1) throw new Error("Direct Codex artifact review requires one pending approval");
    const validated = await this.validateEvidence(run, approvals[0]);
    const artifact = validated.artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new Error("Artifact is outside the direct Codex approval evidence");
    const expected = validated.snapshot.find((item) => item.kind === artifact.kind);
    if (!expected || expected.checksum !== artifact.checksum || expected.mediaType !== artifact.mediaType) throw new Error("Direct Codex artifact changed after approval binding");
    const read = this.options.boundary.readGovernedArtifact(run.id, expected);
    return {
      runId: run.id, approvalId: approvals[0]!.id, artifactId: artifact.id, kind: artifact.kind,
      mediaType: artifact.mediaType, checksum: artifact.checksum, sizeBytes: read.sizeBytes,
      evidenceDigest: approvals[0]!.evidenceDigest, content: read.content,
    };
  }

  async resolveApproval(approval: Approval, decision: "approve" | "deny" | "request_changes", resolvedBy: string): Promise<void> {
    const current = await this.options.store.getApproval(approval.id);
    if (!current || current.action !== DIRECT_CODEX_APPROVAL_ACTION || current.exactEffect !== DIRECT_CODEX_APPROVAL_EFFECT) {
      throw new Error("Approval is not the exact direct Codex safe-mock gate");
    }
    const run = await this.options.store.getRun(current.runId);
    if (!run || !this.isPilotRun(run)) throw new Error("Direct Codex approval does not own its run");
    const binding = approvalBindingOf(current);
    if (!binding) throw new Error("Direct Codex approval lost its binding");
    if (current.state === "pending") await this.validateEvidence(run, current);
    const at = this.clock().toISOString();
    const approved = decision === "approve";
    const costMicros = Number(run.metadata.nativeCostMicros ?? 0);
    await this.options.store.resolveApprovalTransaction({
      approvalId: current.id,
      state: approved ? "approved" : decision === "request_changes" ? "changes_requested" : "denied",
      decision, resolvedBy, resolvedAt: at, expectedBinding: binding,
      runPatch: {
        status: approved ? "completed" : "failed",
        stage: approved ? "accepted_mock_final_action" : decision === "request_changes" ? "changes_requested" : "approval_denied",
        completedAt: at, nextActionAt: null,
        costUsd: Number.isSafeInteger(costMicros) && costMicros >= 0 ? costMicros / 1_000_000 : run.costUsd,
        metadata: { ...run.metadata, approvalDecision: decision, safeMockAcceptanceReceipt: approved, externalActionPerformed: false, memoryPromoted: false },
      },
      event: {
        id: `event_direct_approval_${sha(`${current.id}\0${decision}`).slice(0, 32)}`, runId: run.id,
        type: approved ? "codex.direct_fixture.accepted" : "codex.direct_fixture.rejected",
        message: approved ? "Authenticated approval client accepted direct Codex evidence; only a safe mock receipt was recorded"
          : "Authenticated approval client did not accept direct Codex evidence; no external action was performed",
        payload: { approvalId: current.id, decision, resolvedBy, evidenceDigest: binding.evidenceDigest, externalActionPerformed: false }, createdAt: at,
      },
    });
  }

  async tick(): Promise<void> {
    const now = this.clock();
    const approvals = await this.options.store.listExpiredApprovals(ATOMIC_FIXTURE_PROJECT_ID, DIRECT_CODEX_MODEL_WORKFLOW, now.toISOString(), 100);
    for (const approval of approvals) {
      const run = await this.options.store.getRun(approval.runId);
      if (!run || !this.isPilotRun(run) || run.status !== "awaiting_approval") continue;
      await this.options.store.expireApprovalTransaction({
        approvalId: approval.id,
        runPatch: { status: "failed", stage: "approval_expired", completedAt: now.toISOString(), nextActionAt: null, metadata: { ...run.metadata, approvalExpired: true } },
        event: { id: `event_direct_expired_${sha(approval.id).slice(0, 32)}`, runId: run.id, type: "approval.expired", message: "Direct Codex approval expired without an external action", payload: { approvalId: approval.id }, createdAt: now.toISOString() },
      });
    }
  }

  async reconcileStartup(): Promise<void> {
    await this.options.boundary.reconcileStartup();
    const candidates = await this.options.store.listReconciliationCandidates(this.clock().toISOString());
    for (const run of candidates.queuedRuns) if (this.isPilotRun(run)) this.schedule(run.id);
    const cleaned = await this.options.store.listSandboxInstances(["cleaned"]);
    for (const instance of cleaned) {
      let run = await this.options.store.getRun(instance.runId);
      if (!run || !this.isPilotRun(run)) continue;
      if (run.status === "running" && run.stage !== "evidence_ready") {
        const capabilityId = run.metadata.directModelCapabilityId;
        const capability = typeof capabilityId === "string" ? await this.options.store.getInferenceCapability(capabilityId) : null;
        if (capability?.state === "active") await this.options.store.revokeInferenceCapability(capability.id, this.clock().toISOString());
        await this.validateEvidenceBytes(run, undefined, true);
        await this.options.store.updateRun(run.id, {
          status: "running", stage: "evidence_ready", nextActionAt: null,
          metadata: { ...run.metadata, directModelCleanedRecovery: true, externalActionPerformed: false },
        });
        run = (await this.options.store.getRun(run.id))!;
      }
      this.cleanupContext(run.id);
      if (run.status === "running" && run.stage === "evidence_ready") await this.ensureApproval(run);
      if (run.status === "awaiting_approval") {
        const pending = (await this.options.store.listApprovals("pending")).filter((item) => item.runId === run!.id && item.action === DIRECT_CODEX_APPROVAL_ACTION);
        if (pending.length !== 1) throw new Error("Direct Codex restart requires one pending approval");
        await this.validateEvidence(run, pending[0]!);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.active.values()];
    for (const item of active) item.abort.abort(new Error("Control plane is shutting down"));
    await Promise.allSettled(active.map((item) => item.operation));
  }

  private contextPath(runId: string): string { return resolve(this.options.contextRoot, sha(runId)); }
  private cleanupContext(runId: string): void {
    const path = this.contextPath(runId); if (!existsSync(path)) return;
    const root = realpathSync(this.options.contextRoot); const real = realpathSync(path); contained(root, real);
    const marker = join(real, ".valkyrie-run-id");
    if (readFileSync(marker, "utf8") !== `${runId}\n`) throw new Error("Direct context cleanup ownership could not be proven");
    rmSync(real, { recursive: true });
  }

  private async runQueued(runId: string, signal: AbortSignal): Promise<void> {
    let run: Run | null = null;
    while (!run) {
      if (signal.aborted) throw errorOf(signal.reason);
      run = await this.options.store.claimQueuedRunForStart(runId, this.workerId, new Date(this.clock().getTime() + 6 * 60_000).toISOString());
      const observed = await this.options.store.getRun(runId);
      if (!observed || observed.status !== "queued") return;
      if (!run) await delay(100, undefined, { signal });
    }
    if (!this.isPilotRun(run) || run.taskId !== ATOMIC_MODEL_PILOT_TASK_ID || run.workspaceId) throw new Error("Direct Codex queued run lost its fixed contract");
    const [project, task] = await Promise.all([this.options.store.getProject(run.projectId), this.options.store.getTask(run.taskId)]);
    if (!project || !task || task.objective !== ATOMIC_FIXTURE_MODEL_REQUEST) throw new Error("Direct Codex task/project binding changed");
    this.cleanupContext(run.id);
    const contextPack = this.options.brain.buildContextPack(project, ATOMIC_FIXTURE_MODEL_REQUEST, { runId: run.id, taskId: task.id });
    await this.execute(run, project, contextPack as Record<string, unknown>, signal);
    this.cleanupContext(run.id);
    await this.ensureApproval((await this.options.store.getRun(run.id))!);
  }

  private async execute(run: Run, project: Project, contextPack: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const contextPath = this.contextPath(run.id);
    mkdirSync(contextPath, { mode: 0o700 });
    writeExclusive(contextPath, ".valkyrie-run-id", `${run.id}\n`);
    let prepared: PreparedContext | undefined;
    let snapshot: WriterSandboxValidatedExport[] | undefined;
    try {
      const result = await this.options.boundary.runWorkload({
        allowedWorkflow: DIRECT_CODEX_MODEL_WORKFLOW, run, project,
        repositoryPath: this.options.repositoryPath, baseRef: this.options.repositoryCommit,
        contextPath, artifacts: DIRECT_CODEX_ARTIFACTS, completion: "evidence_ready",
        prepareContext: async (binding) => { prepared = await this.prepareContext(run, binding, contextPack, contextPath); },
        execute: async (handle) => {
          if (!prepared) throw new Error("Direct Codex inference capability was not prepared");
          const started = this.clock().getTime();
          const initialSource = readContainedWorkspaceFile(handle, ATOMIC_FIXTURE_TARGET).toString("utf8");
          const test = readContainedWorkspaceFile(handle, ATOMIC_FIXTURE_TEST).toString("utf8");
          if (sha(initialSource) !== ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256 || sha(test) !== ATOMIC_FIXTURE_TEST_SHA256) throw new Error("Direct Codex fixture bytes changed before execution");
          let source = await this.requestSource(prepared.token, "implementer", initialSource, test, undefined);
          await writeInContainer(this.options.provider, handle, ATOMIC_FIXTURE_TARGET, source);
          const initialChecks = await runChecks(this.options.provider, handle, "initial");
          const initialReview = await this.requestReview(prepared.token, "verifier_initial", source, test, initialChecks);
          await writeInContainer(this.options.provider, handle, PATHS.verifierInitial, json({ schema_version: "1.0.0", round: "initial", context: "fresh", ...initialReview }));
          let repairCount = 0;
          if (!initialChecks.passed || !initialReview.approved) {
            repairCount = 1;
            source = await this.requestSource(prepared.token, "repair", initialSource, test, { checks: initialChecks, verifier: initialReview, candidate: source });
            await writeInContainer(this.options.provider, handle, ATOMIC_FIXTURE_TARGET, source);
          }
          const finalChecks = await runChecks(this.options.provider, handle, "final");
          const finalReview = await this.requestReview(prepared.token, "verifier_final", source, test, finalChecks);
          await writeInContainer(this.options.provider, handle, PATHS.verifierFinal, json({ schema_version: "1.0.0", round: "final", context: "fresh", ...finalReview }));
          if (!finalChecks.passed || !finalReview.approved) throw new Error("Direct Codex candidate failed deterministic checks or fresh final verification");
          const patch = await patchOf(this.options.provider, handle);
          await writeInContainer(this.options.provider, handle, PATHS.patch, patch);
          await writeInContainer(this.options.provider, handle, PATHS.contextPack, prepared.contextPackBody);
          await writeInContainer(this.options.provider, handle, PATHS.runContract, prepared.runContractBody);
          await writeInContainer(this.options.provider, handle, PATHS.launchManifest, prepared.launchBody);
          await writeInContainer(this.options.provider, handle, PATHS.memoryProposal, json({ schema_version: "1.0.0", state: "proposed", claim: "The bounded direct Codex candidate completed the disposable slug-normalization fixture.", promotion: "separate_review_required" }));
          await writeInContainer(this.options.provider, handle, PATHS.draftPrMock, json({ schema_version: "1.0.0", action: "mock_only", external_action_performed: false }));
          const requests = await this.options.store.listInferenceRequests(run.id);
          const usage = {
            input_tokens: requests.reduce((sum, item) => sum + item.inputTokens, 0),
            output_tokens: requests.reduce((sum, item) => sum + item.outputTokens, 0),
            cost_micros: requests.reduce((sum, item) => sum + item.costMicros, 0),
          };
          const evidence = {
            schema_version: "1.0.0-direct", control_plane_run_id: run.id, workflow: DIRECT_CODEX_MODEL_WORKFLOW,
            root_runtime: "codex", source_after_sha256: sha(source), repair_count: repairCount,
            checks_passed: true, verifier_passed: true, model: this.options.policy.model,
            usage, elapsed_ms: this.clock().getTime() - started, final_action: "stop_before_external_action",
          };
          await writeInContainer(this.options.provider, handle, PATHS.evidence, json(evidence));
          snapshot = DIRECT_CODEX_ARTIFACTS.map((item) => {
            const body = readContainedWorkspaceFile(handle, item.relativePath);
            return { relativePath: item.relativePath, kind: item.kind, mediaType: item.mediaType, checksum: sha(body), sizeBytes: body.byteLength };
          }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
          const current = (await this.options.store.getRun(run.id))!;
          await this.options.store.updateRun(run.id, { metadata: {
            ...current.metadata, directModelFrozenExportsValidated: true,
            directModelValidatedWorkspaceArtifacts: snapshot, directModelFrozenExportArtifacts: snapshot,
            directModelCapabilityId: prepared.capabilityId, directModelPolicySha256: prepared.policyHash,
            repairCount, nativeInputTokens: usage.input_tokens, nativeOutputTokens: usage.output_tokens,
            nativeCostMicros: usage.cost_micros, elapsedMs: evidence.elapsed_ms,
            directModelSourceAfterSha256: evidence.source_after_sha256,
            modelExecutionAttempted: true, liveProviderVerified: true, externalActionPerformed: false,
          } });
          return {
            exitCode: 0,
            stdout: "direct_codex_evidence_ready\n",
            stderr: "",
            stdoutBytes: Buffer.byteLength("direct_codex_evidence_ready\n"),
            stderrBytes: 0,
          };
        },
        validateExports: (exports) => {
          if (!snapshot || canonicalJson(snapshot) !== canonicalJson([...exports].sort((a, b) => a.relativePath.localeCompare(b.relativePath)))) {
            throw new Error("Direct Codex frozen exports changed after validation");
          }
        },
      });
      const current = (await this.options.store.getRun(run.id))!;
      await this.options.store.updateRun(run.id, { metadata: { ...current.metadata, artifactCount: result.artifacts.length } });
    } finally {
      if (prepared) await this.options.store.revokeInferenceCapability(prepared.capabilityId, this.clock().toISOString()).catch(() => undefined);
    }
  }

  private async prepareContext(run: Run, binding: Readonly<WriterSandboxWorkloadBinding>, contextPack: Record<string, unknown>, root: string): Promise<PreparedContext> {
    const issued = await issueScopedInferenceCapability({ store: this.options.store, runId: run.id, projectId: run.projectId, workflow: DIRECT_CODEX_MODEL_WORKFLOW, policy: this.options.policy, now: this.clock });
    const contextPackBody = json(JSON.parse(JSON.stringify(contextPack)));
    const contract = {
      schemaVersion: "1.0.0-direct", runId: run.id, projectId: run.projectId, taskId: run.taskId,
      request: ATOMIC_FIXTURE_MODEL_REQUEST, rootRuntime: "codex", workflow: DIRECT_CODEX_MODEL_WORKFLOW,
      finalAction: "stop_before_external_action", crossProcessResume: false,
      contextPack: { ref: "context-pack.json", checksum: sha(contextPackBody) },
      workspace: { id: binding.workspaceId, ownerId: binding.leaseOwnerId, fencingToken: binding.fencingToken, baseCommit: binding.baseCommit },
      inference: { capabilityId: issued.capability.id, policySha256: issued.capability.policyHash, credentialInWriter: false },
      approval: { action: DIRECT_CODEX_APPROVAL_ACTION, exactEffect: DIRECT_CODEX_APPROVAL_EFFECT },
    };
    const runContractBody = json(contract);
    const launchBody = json({
      schema_version: "1.0.0-direct", run_id: run.id, root_runtime: "codex", workflow: DIRECT_CODEX_MODEL_WORKFLOW,
      contract_sha256: sha(runContractBody), context_pack_sha256: sha(contextPackBody), sandbox_policy_sha256: binding.sandboxContract.policyHash,
      model: this.options.policy.model, max_cost_usd: run.budgetUsd, max_repair_rounds: 1, max_concurrency: 1,
      final_action: "stop_before_external_action",
    });
    writeExclusive(root, "context-pack.json", contextPackBody);
    writeExclusive(root, "run-contract.json", runContractBody);
    writeExclusive(root, "direct-launch-manifest.json", launchBody);
    return { token: issued.token, capabilityId: issued.capability.id, policyHash: issued.capability.policyHash, contextPackBody, runContractBody, launchBody };
  }

  private async request(role: InferenceRole, token: string, prompt: string): Promise<Record<string, unknown>> {
    const result = await this.options.gateway.complete(token, role, {
      model: this.options.policy.roleModels[role],
      messages: [{ role: "system", content: "You are a bounded coding candidate. Return only the requested JSON object. Do not call tools or claim unprovided results." }, { role: "user", content: prompt }],
      max_tokens: Math.min(8_192, this.options.policy.maxOutputTokens), temperature: 0, stream: false, store: false,
    });
    return parseModelJson(parseAssistantContent(result, `Direct Codex ${role}`), `Direct Codex ${role}`);
  }

  private async requestSource(token: string, role: "implementer" | "repair", initial: string, test: string, findings: unknown): Promise<string> {
    const prompt = [
      ATOMIC_FIXTURE_MODEL_REQUEST,
      `Only ${ATOMIC_FIXTURE_TARGET} may change. Return exactly {\"source\":\"complete JavaScript file\"}.`,
      "Initial source:", initial, "Immutable test:", test,
      findings ? `Evidence-backed repair input:\n${canonicalJson(findings)}` : "No repair input.",
    ].join("\n");
    return parseSource(await this.request(role, token, prompt), `Direct Codex ${role}`);
  }

  private async requestReview(token: string, role: "verifier_initial" | "verifier_final", source: string, test: string, checks: unknown): Promise<Review> {
    const prompt = [
      "Independently review the fixed normalizeProjectSlug task from fresh context.",
      "Return exactly {\"approved\":boolean,\"findings\":[strings]}. Approve only if the source satisfies the immutable test and deterministic checks passed.",
      "Candidate source:", source, "Immutable test:", test, "Deterministic check evidence:", canonicalJson(checks),
    ].join("\n");
    return parseReview(await this.request(role, token, prompt), `Direct Codex ${role}`);
  }

  private snapshot(run: Run): WriterSandboxValidatedExport[] {
    const value = run.metadata.directModelFrozenExportArtifacts;
    if (!Array.isArray(value) || value.length !== DIRECT_CODEX_ARTIFACTS.length) throw new Error("Direct Codex frozen artifact snapshot is incomplete");
    return value.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Direct Codex artifact snapshot is invalid");
      const item = raw as Record<string, unknown>;
      if (typeof item.relativePath !== "string" || typeof item.kind !== "string" || typeof item.mediaType !== "string"
          || typeof item.checksum !== "string" || !SHA256.test(item.checksum) || !Number.isSafeInteger(item.sizeBytes)) throw new Error("Direct Codex artifact snapshot is invalid");
      return { relativePath: item.relativePath, kind: item.kind, mediaType: item.mediaType, checksum: item.checksum, sizeBytes: Number(item.sizeBytes) };
    }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private async validateEvidence(run: Run, approval?: Approval) {
    if (run.stage !== "evidence_ready" && run.status !== "awaiting_approval") throw new Error("Direct Codex evidence is not ready");
    return this.validateEvidenceBytes(run, approval);
  }

  private async validateEvidenceBytes(run: Run, approval?: Approval, allowCleanedRecovery = false) {
    if (!allowCleanedRecovery && run.stage !== "evidence_ready" && run.status !== "awaiting_approval") {
      throw new Error("Direct Codex evidence is not ready");
    }
    const snapshot = this.snapshot(run);
    if (run.metadata.directModelFrozenExportsValidated !== true
        || canonicalJson(snapshot) !== canonicalJson(run.metadata.directModelValidatedWorkspaceArtifacts)
        || canonicalJson(this.options.boundary.verifyGovernedArtifacts(run.id, snapshot)) !== canonicalJson(snapshot)) {
      throw new Error("Direct Codex governed evidence bytes changed");
    }
    const artifacts = (await this.options.store.listArtifacts(run.id)).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    if (artifacts.length !== DIRECT_CODEX_ARTIFACTS.length) throw new Error("Direct Codex persisted artifact set is incomplete");
    const expectedByKind = new Map(snapshot.map((item) => [item.kind, item]));
    if (expectedByKind.size !== DIRECT_CODEX_ARTIFACTS.length || artifacts.some((item) => {
      const expected = expectedByKind.get(item.kind);
      return !expected || item.checksum !== expected.checksum || item.mediaType !== expected.mediaType;
    })) throw new Error("Direct Codex persisted artifacts changed from the frozen export");
    const instance = await this.options.store.getSandboxInstance(run.id);
    const workspace = await this.options.store.getWorkspaceForRun(run.id);
    if (!instance || instance.state !== "cleaned" || !workspace || existsSync(workspace.path) || await this.options.store.getWorkspaceLease(instance.workspaceId)) {
      throw new Error("Direct Codex writer cleanup evidence is incomplete");
    }
    const capabilityId = run.metadata.directModelCapabilityId;
    const capability = typeof capabilityId === "string" ? await this.options.store.getInferenceCapability(capabilityId) : null;
    if (!capability || capability.runId !== run.id || capability.workflow !== DIRECT_CODEX_MODEL_WORKFLOW || capability.state === "active") {
      throw new Error("Direct Codex capability was not durably closed");
    }
    const requests = await this.options.store.listInferenceRequests(run.id);
    const roles = [...new Set(requests.map((item) => item.role))].sort();
    const expected = run.metadata.repairCount === 1 ? ["implementer", "repair", "verifier_final", "verifier_initial"] : ["implementer", "verifier_final", "verifier_initial"];
    if (canonicalJson(roles) !== canonicalJson(expected) || requests.some((item) => item.state !== "completed")) throw new Error("Direct Codex provider evidence is incomplete");

    const readKind = (kind: string): Buffer => {
      const expectedArtifact = expectedByKind.get(kind);
      if (!expectedArtifact) throw new Error(`Direct Codex ${kind} artifact is missing`);
      return Buffer.from(this.options.boundary.readGovernedArtifact(run.id, expectedArtifact).content, "utf8");
    };
    const evidence = parseJsonArtifact(readKind("direct-codex-evidence"), "Direct Codex evidence");
    const checksInitial = parseJsonArtifact(readKind("deterministic-checks-initial"), "Direct Codex initial checks");
    const checksFinal = parseJsonArtifact(readKind("deterministic-checks-final"), "Direct Codex final checks");
    const verifierInitial = parseJsonArtifact(readKind("fresh-model-verifier-initial"), "Direct Codex initial verifier");
    const verifierFinal = parseJsonArtifact(readKind("fresh-model-verifier-final"), "Direct Codex final verifier");
    const memory = parseJsonArtifact(readKind("memory-proposal-draft"), "Direct Codex memory proposal");
    const draftPr = parseJsonArtifact(readKind("draft-pr-mock"), "Direct Codex draft PR mock");
    const contextPackBody = readKind("project-brain-context-pack");
    const contractBody = readKind("run-contract");
    const launch = parseJsonArtifact(readKind("direct-launch-manifest"), "Direct Codex launch manifest");
    const patch = readKind("candidate-patch").toString("utf8");
    const usage = {
      input_tokens: requests.reduce((sum, item) => sum + item.inputTokens, 0),
      output_tokens: requests.reduce((sum, item) => sum + item.outputTokens, 0),
      cost_micros: requests.reduce((sum, item) => sum + item.costMicros, 0),
    };
    const structuredChecks = (value: Record<string, any>, round: string) => value.schema_version === "1.0.0"
      && value.round === round && typeof value.passed === "boolean" && Array.isArray(value.findings)
      && Array.isArray(value.commands) && value.commands.length === 3
      && value.commands.every((command: any) => Number.isSafeInteger(command?.exit_code));
    const structuredVerifier = (value: Record<string, any>, round: string) => value.schema_version === "1.0.0"
      && value.round === round && value.context === "fresh" && typeof value.approved === "boolean"
      && Array.isArray(value.findings);
    const repairCount = Number(run.metadata.repairCount);
    const initialNeedsRepair = checksInitial.passed !== true || verifierInitial.approved !== true;
    if (evidence.schema_version !== "1.0.0-direct" || evidence.control_plane_run_id !== run.id
        || evidence.workflow !== DIRECT_CODEX_MODEL_WORKFLOW || evidence.root_runtime !== "codex"
        || evidence.source_after_sha256 !== run.metadata.directModelSourceAfterSha256
        || evidence.repair_count !== run.metadata.repairCount || evidence.checks_passed !== true
        || evidence.verifier_passed !== true || evidence.model !== this.options.policy.model
        || canonicalJson(evidence.usage) !== canonicalJson(usage)
        || evidence.final_action !== "stop_before_external_action"
        || !Number.isSafeInteger(evidence.elapsed_ms) || evidence.elapsed_ms < 0
        || !structuredChecks(checksInitial, "initial") || !structuredChecks(checksFinal, "final")
        || !structuredVerifier(verifierInitial, "initial") || !structuredVerifier(verifierFinal, "final")
        || checksFinal.passed !== true || checksFinal.findings.length !== 0
        || checksFinal.commands.some((command: any) => command.exit_code !== 0)
        || verifierFinal.approved !== true || verifierFinal.findings.length !== 0
        || ![0, 1].includes(repairCount) || (repairCount === 0 && initialNeedsRepair) || (repairCount === 1 && !initialNeedsRepair)
        || memory.schema_version !== "1.0.0" || memory.state !== "proposed" || memory.promotion !== "separate_review_required"
        || draftPr.schema_version !== "1.0.0" || draftPr.action !== "mock_only" || draftPr.external_action_performed !== false
        || !patch.startsWith(`diff --git a/${ATOMIC_FIXTURE_TARGET} b/${ATOMIC_FIXTURE_TARGET}\n`)
        || launch.schema_version !== "1.0.0-direct" || launch.run_id !== run.id || launch.root_runtime !== "codex"
        || launch.workflow !== DIRECT_CODEX_MODEL_WORKFLOW || launch.contract_sha256 !== sha(contractBody)
        || launch.context_pack_sha256 !== sha(contextPackBody) || launch.model !== this.options.policy.model
        || launch.max_cost_usd !== run.budgetUsd || launch.max_repair_rounds !== 1 || launch.max_concurrency !== 1
        || launch.final_action !== "stop_before_external_action") {
      throw new Error("Direct Codex governed evidence semantics changed");
    }
    const contract = parseJsonArtifact(contractBody, "Direct Codex run contract");
    if (contract.runId !== run.id || contract.projectId !== run.projectId || contract.taskId !== run.taskId
        || contract.request !== ATOMIC_FIXTURE_MODEL_REQUEST || contract.rootRuntime !== "codex"
        || contract.workflow !== DIRECT_CODEX_MODEL_WORKFLOW || contract.finalAction !== "stop_before_external_action"
        || contract.crossProcessResume !== false || contract.contextPack?.checksum !== sha(contextPackBody)
        || contract.inference?.capabilityId !== capability.id || contract.inference?.policySha256 !== capability.policyHash
        || contract.inference?.credentialInWriter !== false || contract.approval?.action !== DIRECT_CODEX_APPROVAL_ACTION
        || contract.approval?.exactEffect !== DIRECT_CODEX_APPROVAL_EFFECT) {
      throw new Error("Direct Codex run-contract evidence changed");
    }
    if (approval) {
      const binding = approvalBindingOf(approval);
      if (!binding || binding.evidenceDigest !== artifactDigest(artifacts) || binding.policyHash !== instance.policyHash) throw new Error("Direct Codex approval evidence binding changed");
    }
    return { artifacts, instance, snapshot };
  }

  private async ensureApproval(run: Run): Promise<void> {
    if (!run || !this.isPilotRun(run) || run.status !== "running" || run.stage !== "evidence_ready" || existsSync(this.contextPath(run.id))) {
      throw new Error("Direct Codex approval requires cleaned evidence and context");
    }
    const validated = await this.validateEvidence(run);
    const digest = artifactDigest(validated.artifacts);
    const evidence = validated.artifacts.map((item) => `${item.kind}:${item.uri}#sha256=${item.checksum}`);
    const proposal: MemoryProposal = {
      id: `memory_direct_codex_${sha(`${run.id}\0${digest}`).slice(0, 32)}`, projectId: run.projectId, runId: run.id,
      claim: "The disposable direct Codex candidate completed bounded implementation, deterministic checks, and fresh final verification.",
      evidence, state: "proposed", createdAt: validated.artifacts[0]!.createdAt,
    };
    const existingProposal = await this.options.store.getMemoryProposal(proposal.id);
    if (!existingProposal) await this.options.store.createMemoryProposal(proposal);
    else if (canonicalJson(existingProposal) !== canonicalJson({
      ...proposal, resolvedAt: null, reviewer: null, targetNote: null,
    })) throw new Error("Direct Codex memory proposal replay changed");
    const approvalId = `approval_direct_codex_${sha(`${run.id}\0${digest}`).slice(0, 32)}`;
    const existingApproval = await this.options.store.getApproval(approvalId);
    if (existingApproval) {
      const binding = approvalBindingOf(existingApproval);
      if (existingApproval.runId !== run.id || existingApproval.action !== DIRECT_CODEX_APPROVAL_ACTION
          || existingApproval.exactEffect !== DIRECT_CODEX_APPROVAL_EFFECT || binding?.evidenceDigest !== digest
          || binding.policyHash !== validated.instance.policyHash) throw new Error("Direct Codex approval replay changed");
      return;
    }
    const requestedAt = this.clock().toISOString();
    await this.options.store.requestApprovalTransaction({
      approval: {
        id: approvalId, runId: run.id, action: DIRECT_CODEX_APPROVAL_ACTION, exactEffect: DIRECT_CODEX_APPROVAL_EFFECT,
        state: "pending", evidence, requestedAt, projectId: run.projectId, workflow: DIRECT_CODEX_MODEL_WORKFLOW,
        evidenceDigest: digest, policyHash: validated.instance.policyHash,
        expiresAt: new Date(this.clock().getTime() + (this.options.approvalTtlMs ?? 15 * 60_000)).toISOString(),
      },
      event: {
        id: `event_direct_approval_requested_${sha(approvalId).slice(0, 32)}`, runId: run.id, type: "approval.requested",
        message: "Direct Codex evidence is cleaned and ready for an authenticated operator-intended safe-mock decision",
        payload: { approvalId, evidenceDigest: digest, externalActionPerformed: false }, createdAt: requestedAt,
      },
    });
  }
}
