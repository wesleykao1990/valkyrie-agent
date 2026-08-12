import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  ATOMIC_FIXTURE_PROJECT_ID,
} from "./atomic-fixture-pilot.ts";
import {
  ATOMIC_MODEL_PILOT_APPROVAL_ACTION,
  ATOMIC_MODEL_PILOT_APPROVAL_EFFECT,
  ATOMIC_MODEL_PILOT_ARTIFACTS,
  ATOMIC_MODEL_PILOT_WORKFLOW,
  type AtomicModelPilotCoordinator,
  type AtomicModelPilotPreflight,
} from "./atomic-model-pilot-coordinator.ts";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";
import { id } from "./ids.ts";
import type { LocalProjectBrain } from "./project-brain.ts";
import {
  approvalBindingOf,
  canonicalJson,
  type ControlPlaneStore,
  type SandboxInstance,
  type WorkspaceRecord,
} from "./store.ts";
import type { Approval, Artifact, MemoryProposal, Project, Run, StartRunInput, Task } from "./types.ts";
import {
  WriterSandboxBoundary,
  type WriterSandboxValidatedExport,
} from "./writer-sandbox-boundary.ts";

export const ATOMIC_MODEL_PILOT_TASK_ID = "task_atomic_fixture_model_m5b";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

function artifactDigest(artifacts: readonly Artifact[]): string {
  return sha(canonicalJson(artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    checksum: artifact.checksum,
    mediaType: artifact.mediaType,
  })).sort((left, right) => left.kind.localeCompare(right.kind)
    || left.uri.localeCompare(right.uri)
    || left.id.localeCompare(right.id))));
}

function parseSnapshot(value: unknown, label: string): WriterSandboxValidatedExport[] {
  if (!Array.isArray(value) || value.length !== ATOMIC_MODEL_PILOT_ARTIFACTS.length) {
    throw new Error(`${label} is incomplete`);
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${label} is invalid`);
    const item = candidate as Record<string, unknown>;
    if (typeof item.relativePath !== "string" || typeof item.kind !== "string" || typeof item.mediaType !== "string"
        || typeof item.checksum !== "string" || !SHA256.test(item.checksum)
        || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 1) {
      throw new Error(`${label} contains an invalid record`);
    }
    return {
      relativePath: item.relativePath,
      kind: item.kind,
      mediaType: item.mediaType,
      checksum: item.checksum,
      sizeBytes: Number(item.sizeBytes),
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

class ModelPilotShutdownWaitError extends Error {}
class ModelPilotApprovalRetryError extends Error {}
export class AtomicModelPilotArtifactReviewError extends Error {}

export interface AtomicModelPilotLifecycleOptions {
  store: ControlPlaneStore;
  brain: LocalProjectBrain;
  boundary: WriterSandboxBoundary;
  executor: AtomicModelPilotCoordinator;
  maxCostUsd: number;
  approvalTtlMs?: number;
  now?: () => Date;
}

/**
 * Durable control-plane lifecycle around the fixed M5b execution coordinator.
 * It exposes no repository, command, image, provider, credential, or artifact
 * selection. The actual provider remains a separately configured deployment
 * decision and can stay credential-free during deterministic composition tests.
 */
export class AtomicModelPilotLifecycleCoordinator {
  private readonly store: ControlPlaneStore;
  private readonly brain: LocalProjectBrain;
  private readonly boundary: WriterSandboxBoundary;
  private readonly executor: AtomicModelPilotCoordinator;
  private readonly maxCostUsd: number;
  private readonly approvalTtlMs: number;
  private readonly clock: () => Date;
  private readonly workerId = `atomic_model_${sha(id("worker")).slice(0, 24)}`;
  private readonly active = new Map<string, { operation: Promise<void>; abort: AbortController }>();
  private readonly failures = new Map<string, Error>();
  private readonly cancelling = new Set<string>();
  private shuttingDown = false;

  constructor(options: AtomicModelPilotLifecycleOptions) {
    this.store = options.store;
    this.brain = options.brain;
    this.boundary = options.boundary;
    this.executor = options.executor;
    this.maxCostUsd = options.maxCostUsd;
    this.approvalTtlMs = options.approvalTtlMs ?? 15 * 60_000;
    this.clock = options.now ?? (() => new Date());
    if (!Number.isFinite(this.maxCostUsd) || this.maxCostUsd <= 0 || this.maxCostUsd > 5) {
      throw new Error("Atomic model pilot budget cap must be greater than zero and at most $5");
    }
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs < 60_000 || this.approvalTtlMs > 24 * 60 * 60_000) {
      throw new Error("Atomic model pilot approval TTL is invalid");
    }
  }

  isPilotRun(run: Run): boolean {
    return run.rootRuntime === "atomic" && run.workflow === ATOMIC_MODEL_PILOT_WORKFLOW;
  }

  validateStart(input: StartRunInput): number {
    if (input.projectId !== ATOMIC_FIXTURE_PROJECT_ID || input.taskId !== ATOMIC_MODEL_PILOT_TASK_ID) {
      throw new Error("Atomic model pilot requires the fixed disposable project and model task");
    }
    if (input.runtime !== "atomic" || input.workflow !== ATOMIC_MODEL_PILOT_WORKFLOW) {
      throw new Error("Atomic model pilot requires runtime=atomic and workflow=atomic-fixture-model-pilot");
    }
    if (input.objective !== ATOMIC_FIXTURE_MODEL_REQUEST) {
      throw new Error("Atomic model pilot objective must match the reviewed literal contract");
    }
    const budget = input.maxCostUsd ?? this.maxCostUsd;
    if (!Number.isFinite(budget) || budget <= 0 || budget > this.maxCostUsd) {
      throw new Error("Atomic model pilot budget exceeds the configured cap");
    }
    return budget;
  }

  preflight(): Promise<AtomicModelPilotPreflight> { return this.executor.preflight(); }

  async bootstrap(): Promise<{ project: Project; task: Task }> {
    const project = await this.store.getProject(ATOMIC_FIXTURE_PROJECT_ID);
    if (!project) throw new Error("Atomic model pilot requires the reviewed M5 fixture project bootstrap");
    const createdAt = this.clock().toISOString();
    const expected: Task = {
      id: ATOMIC_MODEL_PILOT_TASK_ID,
      projectId: project.id,
      source: "isolated-fake-linear-gateway",
      sourceId: "FIX-M5B-1",
      title: "Run the model-backed disposable Atomic fixture",
      objective: ATOMIC_FIXTURE_MODEL_REQUEST,
      status: "planned",
      priority: "normal",
      createdAt,
    };
    let task = await this.store.getTask(expected.id);
    if (!task) {
      await this.store.createTask(expected);
      task = expected;
    }
    if (canonicalJson({ ...task, createdAt: null }) !== canonicalJson({ ...expected, createdAt: null })) {
      throw new Error("Atomic model pilot task seed conflicts with the reviewed contract");
    }
    return { project, task };
  }

  schedule(runId: string): void {
    if (!SAFE_ID.test(runId)) throw new Error("Atomic model pilot run ID is invalid");
    if (this.shuttingDown || this.active.has(runId)) return;
    const abort = new AbortController();
    this.failures.delete(runId);
    const operation = this.runQueued(runId, abort.signal)
      .catch(async (error) => {
        const failure = errorOf(error);
        if (this.shuttingDown && failure instanceof ModelPilotShutdownWaitError) return;
        if (this.cancelling.has(runId)) return;
        if (failure instanceof ModelPilotApprovalRetryError) {
          this.failures.set(runId, failure);
          return;
        }
        this.failures.set(runId, failure);
        await this.recordFailure(runId, failure).catch((recordError) => {
          this.failures.set(runId, new AggregateError([failure, recordError], "Atomic model pilot failure persistence was incomplete"));
        });
      })
      .finally(async () => {
        try { await this.store.releaseRunClaim(runId, this.workerId); }
        catch (error) { this.failures.set(runId, errorOf(error)); }
        finally { this.active.delete(runId); }
      });
    this.active.set(runId, { operation, abort });
  }

  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.operation;
    const failure = this.failures.get(runId);
    if (failure && !(failure instanceof ModelPilotApprovalRetryError)) throw failure;
  }

  async cancel(run: Run, resolvedBy = "authenticated-control-plane-client"): Promise<void> {
    if (!this.isPilotRun(run)) throw new Error("Run is not an Atomic model pilot");
    this.cancelling.add(run.id);
    try {
      const active = this.active.get(run.id);
      active?.abort.abort(new Error("Atomic model pilot cancelled by an authenticated control-plane client"));
      if (active) await active.operation;
      const current = await this.store.getRun(run.id);
      if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
      if (current.status === "awaiting_approval") {
        const approvals = (await this.store.listApprovals("pending")).filter((candidate) =>
          candidate.runId === current.id && candidate.action === ATOMIC_MODEL_PILOT_APPROVAL_ACTION);
        if (approvals.length !== 1) throw new Error("Atomic model cancellation requires exactly one pending approval");
        const binding = approvalBindingOf(approvals[0]);
        if (!binding) throw new Error("Atomic model cancellation approval lost its binding");
        const at = this.clock().toISOString();
        await this.store.resolveApprovalTransaction({
          approvalId: approvals[0].id,
          state: "denied",
          decision: "cancelled",
          resolvedBy,
          resolvedAt: at,
          expectedBinding: binding,
          runPatch: {
            status: "cancelled",
            stage: "cancelled",
            completedAt: at,
            nextActionAt: null,
            metadata: { ...current.metadata, approvalDecision: "cancelled", externalActionPerformed: false, memoryPromoted: false },
          },
          event: {
            id: `event_atomic_model_cancel_${sha(current.id).slice(0, 32)}`,
            runId: current.id,
            type: "run.cancelled",
            message: "Atomic model pilot and its bound safe-mock gate were cancelled after cleanup",
            payload: { approvalId: approvals[0].id, resolvedBy, externalActionPerformed: false },
            createdAt: at,
          },
        });
        return;
      }
      const cleaned = await this.cleanupProven(current);
      if (!cleaned && current.status !== "queued") return;
      const at = this.clock().toISOString();
      await this.store.updateRun(current.id, {
        status: "cancelled",
        stage: "cancelled",
        completedAt: at,
        nextActionAt: null,
        metadata: { ...current.metadata, cancelledBy: resolvedBy, externalActionPerformed: false },
      });
      await this.store.appendEvent({
        id: `event_atomic_model_cancel_${sha(current.id).slice(0, 32)}`,
        runId: current.id,
        type: "run.cancelled",
        message: "Atomic model pilot was cancelled without an external action",
        payload: { resolvedBy, cleanupProven: cleaned, externalActionPerformed: false },
        createdAt: at,
      });
    } finally {
      this.cancelling.delete(run.id);
    }
  }

  async resolveApproval(approval: Approval, decision: "approve" | "deny" | "request_changes", resolvedBy: string): Promise<void> {
    const currentApproval = await this.store.getApproval(approval.id);
    if (!currentApproval) throw new Error("Atomic model approval was not found");
    if (currentApproval.action !== ATOMIC_MODEL_PILOT_APPROVAL_ACTION
        || currentApproval.exactEffect !== ATOMIC_MODEL_PILOT_APPROVAL_EFFECT) {
      throw new Error("Approval is not the exact Atomic model safe-mock gate");
    }
    const run = await this.store.getRun(currentApproval.runId);
    if (!run || !this.isPilotRun(run)) throw new Error("Atomic model approval does not own a model pilot run");
    const binding = approvalBindingOf(currentApproval);
    if (!binding) throw new Error("Atomic model approval lost its evidence binding");
    if (currentApproval.state === "pending") await this.validatePendingApproval(run, currentApproval);
    const resolvedAt = this.clock().toISOString();
    const approved = decision === "approve";
    const state = approved ? "approved" : decision === "request_changes" ? "changes_requested" : "denied";
    const costMicros = Number(run.metadata.nativeCostMicros ?? 0);
    await this.store.resolveApprovalTransaction({
      approvalId: currentApproval.id,
      state,
      decision,
      resolvedBy,
      resolvedAt,
      expectedBinding: binding,
      runPatch: {
        status: approved ? "completed" : "failed",
        stage: approved ? "accepted_mock_final_action" : decision === "request_changes" ? "changes_requested" : "approval_denied",
        completedAt: resolvedAt,
        nextActionAt: null,
        costUsd: Number.isSafeInteger(costMicros) && costMicros >= 0 ? costMicros / 1_000_000 : run.costUsd,
        metadata: {
          ...run.metadata,
          approvalDecision: decision,
          safeMockAcceptanceReceipt: approved,
          externalActionPerformed: false,
          memoryPromoted: false,
        },
      },
      event: {
        id: `event_atomic_model_approval_${sha(`${currentApproval.id}\0${decision}`).slice(0, 32)}`,
        runId: run.id,
        type: approved ? "atomic.model_fixture.accepted" : "atomic.model_fixture.rejected",
        message: approved
          ? "Authenticated approval client accepted the model-pilot evidence; the control plane recorded a safe mock receipt only"
          : "Authenticated approval client did not accept the model-pilot evidence; no external action was performed",
        payload: {
          approvalId: currentApproval.id,
          decision,
          resolvedBy,
          evidenceDigest: binding.evidenceDigest,
          policyHash: binding.policyHash,
          externalActionPerformed: false,
          memoryPromoted: false,
        },
        createdAt: resolvedAt,
      },
    });
  }

  async readApprovalArtifact(runId: string, artifactId: string) {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(artifactId)) throw new AtomicModelPilotArtifactReviewError("Atomic model artifact ID is invalid");
    try {
      const run = await this.store.getRun(runId);
      if (!run || !this.isPilotRun(run)) throw new Error("Run is not an Atomic model pilot");
      const approvals = (await this.store.listApprovals("pending")).filter((candidate) =>
        candidate.runId === run.id && candidate.action === ATOMIC_MODEL_PILOT_APPROVAL_ACTION);
      if (approvals.length !== 1) throw new Error("Atomic model artifact review requires exactly one pending approval");
      const validated = await this.validatePendingApproval(run, approvals[0]);
      const artifact = validated.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) throw new Error("Artifact is outside the approval evidence");
      const snapshot = validated.snapshot.find((candidate) => candidate.kind === artifact.kind);
      if (!snapshot || snapshot.mediaType !== artifact.mediaType || snapshot.checksum !== artifact.checksum) {
        throw new Error("Artifact changed after evidence binding");
      }
      const read = this.boundary.readGovernedArtifact(run.id, snapshot);
      return {
        runId: run.id,
        approvalId: approvals[0].id,
        artifactId: artifact.id,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        checksum: artifact.checksum,
        sizeBytes: read.sizeBytes,
        evidenceDigest: approvals[0].evidenceDigest,
        content: read.content,
      };
    } catch {
      throw new AtomicModelPilotArtifactReviewError(
        "Atomic model artifact evidence is unavailable or no longer matches the pending approval",
      );
    }
  }

  async reconcileStartup(): Promise<{
    sandbox: Awaited<ReturnType<WriterSandboxBoundary["reconcileStartup"]>>;
    queuedScheduled: number;
    approvalsRecovered: number;
    expiredApprovals: number;
    capabilitiesExpired: number;
  }> {
    const sandbox = await this.boundary.reconcileStartup();
    const observedAt = this.clock().toISOString();
    const [candidates, instances, pending] = await Promise.all([
      this.store.listReconciliationCandidates(observedAt),
      this.store.listSandboxInstances(["cleaned", "quarantined"]),
      this.store.listApprovals("pending"),
    ]);
    let queuedScheduled = 0;
    let approvalsRecovered = 0;
    for (const candidate of candidates.queuedRuns) {
      if (!this.isPilotRun(candidate)) continue;
      const [workspace, instance] = await Promise.all([
        this.store.getWorkspaceForRun(candidate.id),
        this.store.getSandboxInstance(candidate.id),
      ]);
      if (workspace || instance) {
        await this.failQueuedOwnedState(candidate, workspace, instance);
        continue;
      }
      this.schedule(candidate.id);
      queuedScheduled += 1;
    }
    for (const instance of instances) {
      const run = await this.store.getRun(instance.runId);
      if (!run || !this.isPilotRun(run)) continue;
      await this.revokeRecordedCapability(run);
      this.executor.cleanupContext(run.id);
      if (instance.state === "quarantined") continue;
      if (run.status === "awaiting_approval") {
        const approvals = pending.filter((candidate) => candidate.runId === run.id
          && candidate.action === ATOMIC_MODEL_PILOT_APPROVAL_ACTION);
        if (approvals.length !== 1) throw new Error("Atomic model restart requires exactly one pending approval");
        await this.validatePendingApproval(run, approvals[0]);
        continue;
      }
      if (run.status !== "running") continue;
      const validated = await this.validateEvidenceSnapshot(run);
      if (run.stage !== "evidence_ready") {
        await this.store.updateRun(run.id, {
          status: "running",
          stage: "evidence_ready",
          completedAt: null,
          nextActionAt: null,
          metadata: { ...run.metadata, atomicModelCleanedRecovery: true, artifactCount: validated.artifacts.length },
        });
      }
      await this.ensureEvidenceApproval((await this.store.getRun(run.id))!, validated.artifacts);
      approvalsRecovered += 1;
    }
    const maintenance = await this.maintain();
    return { sandbox, queuedScheduled, approvalsRecovered, ...maintenance };
  }

  async tick(): Promise<{ expiredApprovals: number; capabilitiesExpired: number; approvalsRecovered: number }> {
    const maintenance = await this.maintain();
    let approvalsRecovered = 0;
    const cleaned = await this.store.listSandboxInstances(["cleaned"]);
    for (const instance of cleaned) {
      const run = await this.store.getRun(instance.runId);
      if (!run || !this.isPilotRun(run) || run.status !== "running" || run.stage !== "evidence_ready") continue;
      try {
        await this.ensureEvidenceApproval(run);
        approvalsRecovered += 1;
      } catch (error) {
        this.failures.set(run.id, errorOf(error));
      }
    }
    return { ...maintenance, approvalsRecovered };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.active.values()];
    for (const item of active) item.abort.abort(new Error("Control plane is shutting down"));
    await Promise.allSettled(active.map((item) => item.operation));
  }

  private async runQueued(runId: string, signal: AbortSignal): Promise<void> {
    let backoff = 100;
    let run: Run | null = null;
    while (!run) {
      if (signal.aborted) {
        if (this.shuttingDown) throw new ModelPilotShutdownWaitError();
        throw errorOf(signal.reason ?? new Error("Atomic model queued claim was aborted"));
      }
      const claimUntil = new Date(this.clock().getTime() + 6 * 60_000).toISOString();
      run = await this.store.claimQueuedRunForStart(runId, this.workerId, claimUntil);
      const observed = await this.store.getRun(runId);
      if (!observed || observed.status !== "queued") return;
      if (!this.isPilotRun(observed)) throw new Error("Queued claim observed a non-model-pilot run");
      try { await delay(backoff, undefined, { signal }); }
      catch (error) {
        if (signal.aborted && this.shuttingDown) throw new ModelPilotShutdownWaitError();
        throw errorOf(signal.reason ?? error);
      }
      backoff = Math.min(backoff * 2, 1_000);
    }
    if (!this.isPilotRun(run) || run.taskId !== ATOMIC_MODEL_PILOT_TASK_ID) {
      throw new Error("Queued claim did not return the fixed Atomic model pilot");
    }
    const [project, task, workspace, instance] = await Promise.all([
      this.store.getProject(run.projectId),
      this.store.getTask(ATOMIC_MODEL_PILOT_TASK_ID),
      this.store.getWorkspaceForRun(run.id),
      this.store.getSandboxInstance(run.id),
    ]);
    if (!project || !task || task.projectId !== project.id || task.objective !== ATOMIC_FIXTURE_MODEL_REQUEST) {
      throw new Error("Atomic model pilot lost its fixed project/task contract");
    }
    if (workspace || instance) throw new Error("Queued Atomic model pilot retained unexpected writer ownership");
    this.executor.cleanupContext(run.id);
    const contextPack = this.brain.buildContextPack(project, ATOMIC_FIXTURE_MODEL_REQUEST, {
      runId: run.id,
      taskId: task.id,
    });
    const result = await this.executor.run({
      run,
      project,
      taskId: task.id,
      contextPack: JSON.parse(JSON.stringify(contextPack)) as Record<string, unknown>,
      signal,
    });
    try {
      await this.ensureEvidenceApproval((await this.store.getRun(run.id))!, result.boundary.artifacts);
    } catch (error) {
      const current = await this.store.getRun(run.id);
      if (current?.status === "running" && current.stage === "evidence_ready") {
        await this.store.updateRun(run.id, { metadata: {
          ...current.metadata,
          approvalReconciliationRequired: true,
          approvalReconciliationReason: errorOf(error).message.slice(0, 500),
        } });
        throw new ModelPilotApprovalRetryError("Atomic model evidence is clean but approval creation needs reconciliation");
      }
      throw error;
    }
  }

  private async validateEvidenceSnapshot(run: Run, supplied?: readonly Artifact[]) {
    const artifacts = [...(supplied ?? await this.store.listArtifacts(run.id))]
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.uri.localeCompare(right.uri) || left.id.localeCompare(right.id));
    if (artifacts.length !== ATOMIC_MODEL_PILOT_ARTIFACTS.length) throw new Error("Atomic model evidence set is incomplete");
    const workspaceSnapshot = parseSnapshot(run.metadata.atomicModelValidatedWorkspaceArtifacts, "Atomic model workspace snapshot");
    const frozenSnapshot = parseSnapshot(run.metadata.atomicModelFrozenExportArtifacts, "Atomic model frozen snapshot");
    if (run.metadata.atomicModelFrozenExportsValidated !== true
        || canonicalJson(workspaceSnapshot) !== canonicalJson(frozenSnapshot)) {
      throw new Error("Atomic model stopped-export snapshots do not match");
    }
    const governed = new Map(ATOMIC_MODEL_PILOT_ARTIFACTS.map((item) => [item.relativePath, item]));
    for (const snapshot of frozenSnapshot) {
      const expected = governed.get(snapshot.relativePath);
      if (!expected || expected.kind !== snapshot.kind || expected.mediaType !== snapshot.mediaType) {
        throw new Error("Atomic model frozen artifact identity changed");
      }
      const uri = `artifact://runs/${encodeURIComponent(run.id)}/${snapshot.relativePath.split("/").map(encodeURIComponent).join("/")}`;
      const artifact = artifacts.find((candidate) => candidate.kind === snapshot.kind && candidate.uri === uri);
      if (!artifact || artifact.checksum !== snapshot.checksum || artifact.mediaType !== snapshot.mediaType) {
        throw new Error("Atomic model persisted artifact changed after frozen validation");
      }
    }
    if (canonicalJson(this.boundary.verifyGovernedArtifacts(run.id, frozenSnapshot)) !== canonicalJson(frozenSnapshot)) {
      throw new Error("Atomic model governed artifact bytes changed after export");
    }
    const instance = await this.store.getSandboxInstance(run.id);
    if (!instance || instance.state !== "cleaned" || run.workspaceId !== instance.workspaceId) {
      throw new Error("Atomic model sandbox cleanup evidence is incomplete");
    }
    const [lease, workspace] = await Promise.all([
      this.store.getWorkspaceLease(instance.workspaceId),
      this.store.getWorkspaceForRun(run.id),
    ]);
    if (lease || !workspace || workspace.id !== instance.workspaceId || existsSync(workspace.path)) {
      throw new Error("Atomic model writer workspace is not durably released");
    }
    const capabilityId = run.metadata.atomicModelCapabilityId;
    if (typeof capabilityId !== "string" || !SAFE_ID.test(capabilityId)) throw new Error("Atomic model capability binding is missing");
    const capability = await this.store.getInferenceCapability(capabilityId);
    if (!capability || capability.runId !== run.id || capability.projectId !== run.projectId
        || capability.workflow !== ATOMIC_MODEL_PILOT_WORKFLOW
        || !["revoked", "exhausted", "expired"].includes(capability.state)
        || capability.policyHash !== run.metadata.atomicModelPolicySha256) {
      throw new Error("Atomic model capability is not durably stopped and bound to this evidence");
    }
    const repairCount = run.metadata.repairCount;
    if (repairCount !== 0 && repairCount !== 1) throw new Error("Atomic model repair count is invalid");
    const requests = await this.store.listInferenceRequests(run.id);
    const expectedRoles = repairCount === 1
      ? ["implementer", "repair", "verifier_final", "verifier_initial"]
      : ["implementer", "verifier_final", "verifier_initial"];
    const actualRoles = requests.map((request) => request.role).sort();
    const inputTokens = requests.reduce((sum, request) => sum + request.inputTokens, 0);
    const outputTokens = requests.reduce((sum, request) => sum + request.outputTokens, 0);
    const costMicros = requests.reduce((sum, request) => sum + request.costMicros, 0);
    const liveProviderExpected = run.metadata.liveProviderExpected === true;
    if (typeof run.metadata.liveProviderVerified !== "boolean"
        || run.metadata.liveProviderVerified !== liveProviderExpected
        || canonicalJson(actualRoles) !== canonicalJson(expectedRoles)
        || requests.some((request) => request.state !== "completed" || !request.responseHash || !SHA256.test(request.responseHash))
        || inputTokens !== run.metadata.nativeInputTokens || outputTokens !== run.metadata.nativeOutputTokens
        || costMicros !== run.metadata.nativeCostMicros) {
      throw new Error("Atomic model durable provider usage no longer matches the approval evidence");
    }
    return { artifacts, instance, snapshot: frozenSnapshot, capability };
  }

  private async validatePendingApproval(run: Run, approval: Approval) {
    if (run.status !== "awaiting_approval" || run.stage !== "approval" || approval.state !== "pending"
        || approval.runId !== run.id || approval.action !== ATOMIC_MODEL_PILOT_APPROVAL_ACTION
        || approval.exactEffect !== ATOMIC_MODEL_PILOT_APPROVAL_EFFECT) {
      throw new Error("Atomic model approval is not the exact pending safe-mock gate");
    }
    const binding = approvalBindingOf(approval);
    if (!binding || binding.projectId !== run.projectId || binding.workflow !== ATOMIC_MODEL_PILOT_WORKFLOW) {
      throw new Error("Atomic model pending approval lost its fixed binding");
    }
    const validated = await this.validateEvidenceSnapshot(run);
    const digest = artifactDigest(validated.artifacts);
    const evidence = validated.artifacts.map((artifact) => `${artifact.kind}:${artifact.uri}#sha256=${artifact.checksum}`);
    if (binding.evidenceDigest !== digest || binding.policyHash !== validated.instance.policyHash
        || canonicalJson(approval.evidence) !== canonicalJson(evidence)) {
      throw new Error("Atomic model approval no longer matches governed evidence bytes");
    }
    return validated;
  }

  private async ensureEvidenceApproval(run: Run, supplied?: readonly Artifact[]): Promise<void> {
    if (!run || !this.isPilotRun(run) || run.status !== "running" || run.stage !== "evidence_ready") {
      throw new Error("Atomic model approval requires a cleaned evidence-ready run");
    }
    if (this.executor.contextExists(run.id)) throw new Error("Atomic model approval requires private-context cleanup");
    const validated = await this.validateEvidenceSnapshot(run, supplied);
    const evidenceDigest = artifactDigest(validated.artifacts);
    const evidence = validated.artifacts.map((artifact) => `${artifact.kind}:${artifact.uri}#sha256=${artifact.checksum}`);
    const proposalId = `memory_atomic_model_${sha(`${run.id}\0${evidenceDigest}`).slice(0, 32)}`;
    const proposal: MemoryProposal = {
      id: proposalId,
      projectId: run.projectId,
      runId: run.id,
      claim: "The disposable Atomic model pilot completed its bounded implementation, deterministic checks, and fresh final model verifier under the governed inference boundary.",
      evidence,
      state: "proposed",
      createdAt: validated.artifacts[0]!.createdAt,
    };
    const existingProposal = await this.store.getMemoryProposal(proposalId);
    if (!existingProposal) await this.store.createMemoryProposal(proposal);
    else if (canonicalJson(existingProposal) !== canonicalJson(proposal)) throw new Error("Atomic model memory proposal replay changed content");

    const approvalId = `approval_atomic_model_${sha(`${run.id}\0${evidenceDigest}`).slice(0, 32)}`;
    const existing = await this.store.getApproval(approvalId);
    if (existing) {
      const binding = approvalBindingOf(existing);
      if (!binding || binding.evidenceDigest !== evidenceDigest || binding.policyHash !== validated.instance.policyHash
          || binding.projectId !== run.projectId || binding.workflow !== ATOMIC_MODEL_PILOT_WORKFLOW
          || existing.action !== ATOMIC_MODEL_PILOT_APPROVAL_ACTION || existing.exactEffect !== ATOMIC_MODEL_PILOT_APPROVAL_EFFECT
          || canonicalJson(existing.evidence) !== canonicalJson(evidence)) {
        throw new Error("Atomic model approval replay changed evidence or policy");
      }
      return;
    }
    const requestedAt = this.clock().toISOString();
    const expiresAt = new Date(this.clock().getTime() + this.approvalTtlMs).toISOString();
    await this.store.requestApprovalTransaction({
      approval: {
        id: approvalId,
        runId: run.id,
        action: ATOMIC_MODEL_PILOT_APPROVAL_ACTION,
        exactEffect: ATOMIC_MODEL_PILOT_APPROVAL_EFFECT,
        state: "pending",
        evidence,
        requestedAt,
        projectId: run.projectId,
        workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
        evidenceDigest,
        policyHash: validated.instance.policyHash,
        expiresAt,
      },
      event: {
        id: `event_atomic_model_approval_requested_${sha(approvalId).slice(0, 32)}`,
        runId: run.id,
        type: "approval.requested",
        message: "Atomic model evidence is cleaned and ready for an authenticated operator-intended safe-mock decision",
        payload: { approvalId, evidenceDigest, policyHash: validated.instance.policyHash, expiresAt, externalActionPerformed: false },
        createdAt: requestedAt,
      },
    });
  }

  private async maintain() {
    let expiredApprovals = 0;
    const now = this.clock();
    for (let batch = 0; batch < 10; batch += 1) {
      const pending = await this.store.listExpiredApprovals(
        ATOMIC_FIXTURE_PROJECT_ID,
        ATOMIC_MODEL_PILOT_WORKFLOW,
        now.toISOString(),
        100,
      );
      for (const approval of pending) {
        const run = await this.store.getRun(approval.runId);
        if (!run || !this.isPilotRun(run) || run.status !== "awaiting_approval") continue;
        const binding = approvalBindingOf(approval);
        if (!binding) throw new Error("Expired Atomic model approval lost its binding");
        const at = now.toISOString();
        await this.store.expireApprovalTransaction({
          approvalId: approval.id,
          runPatch: {
            status: "failed",
            stage: "approval_expired",
            completedAt: at,
            nextActionAt: null,
            metadata: { ...run.metadata, approvalExpired: true, externalActionPerformed: false },
          },
          event: {
            id: `event_atomic_model_approval_expired_${sha(approval.id).slice(0, 32)}`,
            runId: run.id,
            type: "approval.expired",
            message: "Atomic model approval expired without an external action",
            payload: { approvalId: approval.id, evidenceDigest: binding.evidenceDigest },
            createdAt: at,
          },
        });
        expiredApprovals += 1;
      }
      if (pending.length < 100) break;
      if (batch === 9) throw new Error("Atomic model approval expiry backlog exceeded the bounded maintenance pass");
    }
    let capabilitiesExpired = 0;
    for (let batch = 0; batch < 10; batch += 1) {
      const expired = await this.store.expireInferenceCapabilities(now.toISOString(), 100);
      capabilitiesExpired += expired.length;
      if (expired.length < 100) break;
      if (batch === 9) throw new Error("Inference capability expiry backlog exceeded the bounded maintenance pass");
    }
    return { expiredApprovals, capabilitiesExpired };
  }

  private async cleanupProven(run: Run): Promise<boolean> {
    const instance = await this.store.getSandboxInstance(run.id);
    if (!instance || instance.state !== "cleaned") return false;
    const workspace = await this.store.getWorkspaceForRun(run.id);
    if (!workspace || workspace.id !== instance.workspaceId || existsSync(workspace.path)) return false;
    return !(await this.store.getWorkspaceLease(instance.workspaceId));
  }

  private async revokeRecordedCapability(run: Run): Promise<void> {
    const capabilityId = run.metadata.atomicModelCapabilityId;
    if (typeof capabilityId === "string" && SAFE_ID.test(capabilityId)) {
      await this.store.revokeInferenceCapability(capabilityId, this.clock().toISOString());
    }
  }

  private async failQueuedOwnedState(run: Run, workspace: WorkspaceRecord | null, instance: SandboxInstance | null): Promise<void> {
    let quarantined = false;
    if (workspace) {
      const lease = await this.store.getWorkspaceLease(workspace.id);
      if (lease?.state === "active" && lease.runId === run.id) {
        quarantined = Boolean(await this.store.quarantineWorkspaceLease({
          workspaceId: lease.workspaceId,
          runId: lease.runId,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          quarantinedAt: this.clock().toISOString(),
          reason: "queued_atomic_model_owned_state_requires_operator_reconciliation",
        }));
      }
    }
    await this.revokeRecordedCapability(run);
    this.executor.cleanupContext(run.id);
    const at = this.clock().toISOString();
    await this.store.updateRun(run.id, {
      status: "failed",
      stage: quarantined ? "workspace_quarantined" : "atomic_model_failed",
      completedAt: at,
      nextActionAt: null,
      metadata: { ...run.metadata, reconciliationReason: "queued_model_run_retained_writer_state", externalActionPerformed: false },
    });
    await this.store.appendEvent({
      id: `event_atomic_model_queued_state_${sha(run.id).slice(0, 32)}`,
      runId: run.id,
      type: "run.reconciliation_failed",
      message: "Queued Atomic model run retained durable writer state and was failed closed",
      payload: { workspaceId: workspace?.id ?? null, sandboxState: instance?.state ?? null, leaseQuarantined: quarantined },
      createdAt: at,
    });
  }

  private async recordFailure(runId: string, error: unknown): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || ["completed", "failed", "cancelled", "awaiting_approval"].includes(run.status)) return;
    await this.revokeRecordedCapability(run);
    const at = this.clock().toISOString();
    await this.store.updateRun(run.id, {
      status: "failed",
      stage: run.stage === "workspace_quarantined" ? "workspace_quarantined" : "atomic_model_failed",
      completedAt: at,
      nextActionAt: null,
      metadata: { ...run.metadata, atomicModelFailure: errorOf(error).message.slice(0, 500), externalActionPerformed: false },
    });
    await this.store.appendEvent({
      id: `event_atomic_model_failed_${sha(`${run.id}\0${errorOf(error).message}`).slice(0, 32)}`,
      runId: run.id,
      type: "run.failed",
      message: "Atomic model pilot failed closed before any external final action",
      payload: { reason: errorOf(error).message.slice(0, 500), externalActionPerformed: false },
      createdAt: at,
    });
  }
}
