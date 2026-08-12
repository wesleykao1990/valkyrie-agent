import { createHash } from "node:crypto";
import type { Approval, Artifact, MemoryProposal, Project, Run, RunEvent, Task } from "./types.ts";

export interface WorkspaceRecord {
  id: string;
  runId: string;
  path: string;
  provider: string;
  status: string;
  createdAt: string;
}

export interface WriterLeaseRequest {
  workspaceId: string;
  runId: string;
  ownerId: string;
  mode: "writer";
  expiresAt: string;
  heartbeatAt: string;
}

export type WorkspaceLeaseState = "active" | "quarantined";

export interface WorkspaceLease extends WriterLeaseRequest {
  fencingToken: number;
  state: WorkspaceLeaseState;
  acquiredAt: string;
  quarantinedAt: string | null;
  quarantineReason: string | null;
}

export interface WorkspaceLeaseFence {
  workspaceId: string;
  runId: string;
  ownerId: string;
  fencingToken: number;
}

export interface WorkspaceLeaseRenewal extends WorkspaceLeaseFence {
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkspaceLeaseQuarantine extends WorkspaceLeaseFence {
  quarantinedAt: string;
  reason: string;
}

export type SandboxInstanceState =
  | "provisioning"
  | "ready"
  | "running"
  | "freezing"
  | "exporting"
  | "cleaned"
  | "quarantined";

export interface SandboxInstance {
  runId: string;
  workspaceId: string;
  leaseOwnerId: string;
  fencingToken: number;
  provider: "docker-compatible";
  engineId: string | null;
  imageRef: string;
  policyHash: string;
  workspaceDigest: string;
  contextDigest: string;
  contextContentHash: string;
  workdirDigest: string;
  state: SandboxInstanceState;
  cleanupAttempts: number;
  lastCleanupAt: string | null;
  quarantineReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SandboxInstanceCreateInput = Omit<SandboxInstance,
  "engineId" | "state" | "cleanupAttempts" | "lastCleanupAt" | "quarantineReason"
>;

export interface SandboxInstanceTransitionInput extends WorkspaceLeaseFence {
  expectedState: SandboxInstanceState;
  state: SandboxInstanceState;
  updatedAt: string;
  engineId?: string;
  cleanupAttemptedAt?: string;
  quarantineReason?: string;
}

export type StoreClock = () => Date;
export const MAX_WRITER_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface OutboxEvent {
  id: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  availableAt: string;
  publishedAt?: string | null;
  attempts: number;
  lastError?: string | null;
}

export interface IdempotencyInput {
  scope: string;
  key: string;
  requestHash: string;
  expiresAt?: string | null;
}

export interface StoredIdempotencyRecord extends IdempotencyInput {
  resourceType: string;
  resourceId: string;
  response: Record<string, unknown>;
  createdAt: string;
}

export interface MigrationResult {
  version: number;
  name: string;
  checksum: string;
  status: "applied" | "already_applied";
}

export interface StoreHealth {
  ok: boolean;
  backend: "sqlite" | "postgres";
  migrationsCurrent: boolean;
}

export interface RunBundleInput {
  run: Run;
  workspace?: WorkspaceRecord;
  lease?: WriterLeaseRequest;
  idempotency?: IdempotencyInput;
  /** Transactional, cross-process admission for one workflow's nonterminal runs. */
  admission?: {
    workflow: string;
    maxNonterminal: number;
  };
}

export interface RunBundleResult {
  run: Run;
  workspace?: WorkspaceRecord;
  lease?: WorkspaceLease;
  replayed: boolean;
}

export type MutableRunPatch = Partial<Pick<Run,
  | "status"
  | "stage"
  | "stageIndex"
  | "costUsd"
  | "nativeRunId"
  | "nextActionAt"
  | "startedAt"
  | "completedAt"
  | "metadata"
>>;

export interface WorkspaceLeaseResult {
  workspace: WorkspaceRecord;
  lease: WorkspaceLease;
  replayed: boolean;
}

export interface ArtifactBatchResult {
  artifacts: Artifact[];
  replayed: boolean;
}

export interface ApprovalBinding {
  action: string;
  exactEffect: string;
  projectId: string;
  workflow: string;
  evidenceDigest: string;
  policyHash: string;
  expiresAt: string;
}

export interface ApprovalResolutionInput {
  approvalId: string;
  state: string;
  decision: string;
  resolvedBy: string;
  resolvedAt?: string;
  /** Exact evidence/policy binding the caller intends to authorize. */
  expectedBinding?: ApprovalBinding;
  runPatch?: MutableRunPatch;
  event?: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
}

export interface ApprovalExpiryInput {
  approvalId: string;
  /** Expiry must leave the owning run in a terminal state. */
  runPatch: MutableRunPatch & { status: "completed" | "failed" | "cancelled" };
  event: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
}

export type InferenceRole = "implementer" | "verifier_initial" | "repair" | "verifier_final";
export type InferenceCapabilityState = "active" | "revoked" | "exhausted" | "expired";
export type InferenceRequestState = "reserved" | "completed" | "failed";

export interface InferenceCapability {
  id: string;
  runId: string;
  projectId: string;
  workflow: string;
  tokenHash: string;
  provider: string;
  model: string;
  api: "openai-completions";
  roles: InferenceRole[];
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxElapsedMs: number;
  issuedAt: string;
  expiresAt: string;
  state: InferenceCapabilityState;
  policyHash: string;
}

export interface InferenceRequest {
  id: string;
  capabilityId: string;
  runId: string;
  role: InferenceRole;
  requestHash: string;
  state: InferenceRequestState;
  providerRequestId: string | null;
  responseHash: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  reservedAt: string;
  completedAt: string | null;
  failureCode: string | null;
}

export interface ReserveInferenceRequestInput {
  id: string;
  tokenHash: string;
  runId: string;
  role: InferenceRole;
  requestHash: string;
  reservedAt?: string;
}

export interface CompleteInferenceRequestInput {
  id: string;
  state: "completed" | "failed";
  responseHash?: string | null;
  providerRequestId?: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  failureCode?: string | null;
  completedAt?: string;
}

export interface ApprovalRequestInput {
  approval: Approval;
  event: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
}

export interface ApprovalRequestResult {
  approval: Approval;
  run: Run;
  event: RunEvent;
  replayed: boolean;
}

export interface ApprovalResolutionResult {
  approval: Approval;
  run: Run;
  event?: RunEvent;
  replayed: boolean;
}

export interface StrandedApproval {
  approval: Approval;
  run: Run;
}

export interface ReconciliationCandidates {
  queuedRuns: Run[];
  strandedApprovals: StrandedApproval[];
  terminalLeases: WorkspaceLease[];
  expiredLeases: WorkspaceLease[];
  quarantinedLeases: WorkspaceLease[];
  pendingOutbox: OutboxEvent[];
}

/**
 * Storage boundary for control-plane state.
 *
 * Every operation is asynchronous even when backed by node:sqlite. This keeps
 * callers independent of a driver's execution model and lets PostgreSQL use a
 * normal connection pool without blocking tricks.
 */
export interface ControlPlaneStore {
  readonly backend: "sqlite" | "postgres";

  close(): Promise<void>;
  migrate(): Promise<MigrationResult[]>;
  healthCheck(): Promise<StoreHealth>;

  resetOperationalData(): Promise<void>;
  seedProjects(items: Array<Record<string, unknown>>): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;

  createTask(task: Task): Promise<void>;
  listTasks(projectId?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  findTaskBySimilarTitle(projectId: string, title: string): Promise<Task | null>;

  createRun(run: Run): Promise<void>;
  createRunBundle(input: RunBundleInput): Promise<RunBundleResult>;
  updateRun(id: string, patch: MutableRunPatch): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  listRuns(limit?: number): Promise<Run[]>;
  listRunnableRuns(now: string): Promise<Run[]>;
  claimRunnableRuns(now: string, claimUntil: string, workerId: string, limit?: number): Promise<Run[]>;
  /** Claims one still-queued run without changing its lifecycle state. */
  claimQueuedRunForStart(runId: string, workerId: string, claimUntil: string): Promise<Run | null>;
  releaseRunClaim(runId: string, workerId: string): Promise<void>;

  appendEvent(event: Omit<RunEvent, "seq">): Promise<RunEvent>;
  listEvents(runId: string, afterSeq?: number): Promise<RunEvent[]>;

  createWorkspace(workspace: WorkspaceRecord): Promise<void>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  getWorkspaceForRun(runId: string): Promise<WorkspaceRecord | null>;
  updateWorkspaceStatus(id: string, status: string): Promise<void>;
  createLease(lease: WriterLeaseRequest): Promise<WorkspaceLease>;
  createWorkspaceLease(workspace: WorkspaceRecord, lease: WriterLeaseRequest): Promise<WorkspaceLeaseResult>;
  rotateWorkspaceLease(lease: WriterLeaseRequest): Promise<WorkspaceLease>;
  renewWorkspaceLease(input: WorkspaceLeaseRenewal): Promise<WorkspaceLease | null>;
  quarantineWorkspaceLease(input: WorkspaceLeaseQuarantine): Promise<WorkspaceLease | null>;
  releaseWorkspaceLease(fence: WorkspaceLeaseFence): Promise<boolean>;
  /** Returns active or quarantined state for one workspace. */
  getWorkspaceLease(workspaceId: string): Promise<WorkspaceLease | null>;
  /** Returns active leases only; quarantine evidence is exposed by reconciliation/getWorkspaceLease. */
  listLeases(): Promise<WorkspaceLease[]>;

  createSandboxInstance(input: SandboxInstanceCreateInput): Promise<SandboxInstance>;
  getSandboxInstance(runId: string): Promise<SandboxInstance | null>;
  listSandboxInstances(states?: SandboxInstanceState[]): Promise<SandboxInstance[]>;
  transitionSandboxInstance(input: SandboxInstanceTransitionInput): Promise<SandboxInstance | null>;

  requestApprovalTransaction(input: ApprovalRequestInput): Promise<ApprovalRequestResult>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(state?: string): Promise<Approval[]>;
  /** Uses the project/workflow/state/expiry index and returns a bounded oldest-first page. */
  listExpiredApprovals(projectId: string, workflow: string, observedAt: string, limit?: number): Promise<Approval[]>;
  resolveApproval(id: string, state: string, decision: string, resolvedBy: string): Promise<void>;
  resolveApprovalTransaction(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult>;
  /** Closes an expired, evidence-bound pending approval without human authority. */
  expireApprovalTransaction(input: ApprovalExpiryInput): Promise<ApprovalResolutionResult>;

  /** Stores only a capability digest; plaintext run credentials never enter durable storage. */
  createInferenceCapability(capability: InferenceCapability): Promise<InferenceCapability>;
  getInferenceCapability(id: string): Promise<InferenceCapability | null>;
  getInferenceCapabilityByTokenHash(tokenHash: string): Promise<InferenceCapability | null>;
  reserveInferenceRequest(input: ReserveInferenceRequestInput): Promise<{ capability: InferenceCapability; request: InferenceRequest; replayed: boolean }>;
  completeInferenceRequest(input: CompleteInferenceRequestInput): Promise<{ capability: InferenceCapability; request: InferenceRequest; replayed: boolean }>;
  revokeInferenceCapability(id: string, observedAt?: string): Promise<InferenceCapability | null>;
  /** Atomically closes a bounded page of active capabilities past authoritative expiry. */
  expireInferenceCapabilities(observedAt: string, limit?: number): Promise<InferenceCapability[]>;
  listInferenceRequests(runId: string): Promise<InferenceRequest[]>;

  createArtifact(artifact: Artifact): Promise<void>;
  /** Persists one run's bounded artifact set and all matching outbox records atomically. */
  createArtifactBatch(artifacts: Artifact[]): Promise<ArtifactBatchResult>;
  listArtifacts(runId: string): Promise<Artifact[]>;

  createMemoryProposal(item: MemoryProposal): Promise<void>;
  getMemoryProposal(id: string): Promise<MemoryProposal | null>;
  listMemoryProposals(state?: string): Promise<MemoryProposal[]>;
  resolveMemoryProposal(id: string, state: string, reviewer: string, targetNote?: string): Promise<void>;

  getIdempotencyRecord(scope: string, key: string): Promise<StoredIdempotencyRecord | null>;
  listPendingOutbox(limit?: number): Promise<OutboxEvent[]>;
  markOutboxPublished(id: string, publishedAt: string): Promise<boolean>;
  markOutboxFailed(id: string, error: string, availableAt: string): Promise<boolean>;
  listReconciliationCandidates(now: string, outboxLimit?: number): Promise<ReconciliationCandidates>;
}

export class StorageConflictError extends Error {
  readonly code: string = "STORAGE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "StorageConflictError";
  }
}

export class IdempotencyConflictError extends StorageConflictError {
  readonly code: string = "IDEMPOTENCY_CONFLICT";
  constructor(message = "Idempotency key was already used for a different request") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

const maximumFencingToken = Number.MAX_SAFE_INTEGER;
const sha256Hex = /^[a-f0-9]{64}$/;
const safeInferenceId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const inferenceRoles = new Set<InferenceRole>(["implementer", "verifier_initial", "repair", "verifier_final"]);
const immutableImageRef = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const sandboxTransitions: Record<SandboxInstanceState, ReadonlySet<SandboxInstanceState>> = {
  provisioning: new Set(["ready", "quarantined"]),
  ready: new Set(["running", "quarantined"]),
  running: new Set(["freezing", "quarantined"]),
  freezing: new Set(["exporting", "quarantined"]),
  exporting: new Set(["cleaned", "quarantined"]),
  cleaned: new Set(),
  quarantined: new Set(),
};

function boundedInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StorageConflictError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

export function validateInferenceCapability(capability: InferenceCapability, observedAt: string): void {
  for (const [label, value] of [["capability ID", capability.id], ["run ID", capability.runId],
    ["project ID", capability.projectId], ["workflow", capability.workflow], ["provider", capability.provider],
    ["model", capability.model]] as const) {
    if (!safeInferenceId.test(value)) throw new StorageConflictError(`Inference ${label} is invalid`);
  }
  if (!sha256Hex.test(capability.tokenHash) || !sha256Hex.test(capability.policyHash)) {
    throw new StorageConflictError("Inference capability digests must be lowercase SHA-256 values");
  }
  if (capability.api !== "openai-completions" || capability.state !== "active") {
    throw new StorageConflictError("A new inference capability must use the reviewed API and active state");
  }
  const roles = [...new Set(capability.roles)];
  if (roles.length === 0 || roles.length !== capability.roles.length || roles.some((role) => !inferenceRoles.has(role))) {
    throw new StorageConflictError("Inference capability roles must be unique reviewed roles");
  }
  boundedInteger(capability.maxRequests, "Inference maxRequests", 1, 8);
  boundedInteger(capability.maxInputTokens, "Inference maxInputTokens", 1, 128_000);
  boundedInteger(capability.maxOutputTokens, "Inference maxOutputTokens", 1, 32_768);
  boundedInteger(capability.maxCostMicros, "Inference maxCostMicros", 0, 100_000_000);
  boundedInteger(capability.maxElapsedMs, "Inference maxElapsedMs", 100, 10 * 60 * 1_000);
  const issued = timestampMillis(capability.issuedAt, "Inference capability issuedAt");
  const expires = timestampMillis(capability.expiresAt, "Inference capability expiresAt");
  const observed = timestampMillis(observedAt, "Observed storage time");
  if (issued > observed + 30_000 || expires <= observed || expires - issued > 30 * 60 * 1_000) {
    throw new StorageConflictError("Inference capability validity window is invalid");
  }
}

export function validateInferenceReservation(input: ReserveInferenceRequestInput): void {
  if (!safeInferenceId.test(input.id) || !safeInferenceId.test(input.runId)) {
    throw new StorageConflictError("Inference request identity is invalid");
  }
  if (!sha256Hex.test(input.tokenHash) || !sha256Hex.test(input.requestHash)) {
    throw new StorageConflictError("Inference request digests must be lowercase SHA-256 values");
  }
  if (!inferenceRoles.has(input.role)) throw new StorageConflictError("Inference request role is invalid");
}

export function validateInferenceCompletion(input: CompleteInferenceRequestInput): void {
  if (!safeInferenceId.test(input.id)) throw new StorageConflictError("Inference request identity is invalid");
  if (input.state === "completed") {
    if (!input.responseHash || !sha256Hex.test(input.responseHash) || input.failureCode) {
      throw new StorageConflictError("Completed inference requests require a response digest and no failure code");
    }
  } else if (input.responseHash || !input.failureCode || !safeInferenceId.test(input.failureCode)) {
    throw new StorageConflictError("Failed inference requests require only a safe failure code");
  }
  if (input.providerRequestId !== undefined && input.providerRequestId !== null
      && (!safeInferenceId.test(input.providerRequestId))) {
    throw new StorageConflictError("Inference provider request ID is invalid");
  }
  boundedInteger(input.inputTokens, "Inference inputTokens", 0, 128_000);
  boundedInteger(input.outputTokens, "Inference outputTokens", 0, 32_768);
  boundedInteger(input.costMicros, "Inference costMicros", 0, 100_000_000);
}

function timestampMillis(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new StorageConflictError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return parsed;
}

function nullableApprovalBindingValue(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Returns a complete pilot binding, null for a legacy approval, and rejects
 * partial/corrupt bindings. Keeping this check in the shared contract makes
 * SQLite and PostgreSQL fail closed in the same way.
 */
export function approvalBindingOf(approval: Approval): ApprovalBinding | null {
  const values = {
    projectId: nullableApprovalBindingValue(approval.projectId),
    workflow: nullableApprovalBindingValue(approval.workflow),
    evidenceDigest: nullableApprovalBindingValue(approval.evidenceDigest),
    policyHash: nullableApprovalBindingValue(approval.policyHash),
    expiresAt: nullableApprovalBindingValue(approval.expiresAt),
  };
  const present = Object.values(values).filter((value) => value !== null).length;
  if (present === 0) return null;
  if (present !== 5) throw new StorageConflictError("Pilot approval binding must be complete or entirely null");
  const binding: ApprovalBinding = {
    action: approval.action,
    exactEffect: approval.exactEffect,
    projectId: values.projectId!,
    workflow: values.workflow!,
    evidenceDigest: values.evidenceDigest!,
    policyHash: values.policyHash!,
    expiresAt: values.expiresAt!,
  };
  if (!binding.projectId || binding.projectId !== binding.projectId.trim() || binding.projectId.length > 256) {
    throw new StorageConflictError("Pilot approval project ID must be 1-256 non-whitespace-edge characters");
  }
  if (!binding.action || binding.action !== binding.action.trim() || binding.action.length > 256) {
    throw new StorageConflictError("Pilot approval action must be 1-256 non-whitespace-edge characters");
  }
  if (!binding.exactEffect || binding.exactEffect !== binding.exactEffect.trim() || binding.exactEffect.length > 2_048) {
    throw new StorageConflictError("Pilot approval exact effect must be 1-2048 non-whitespace-edge characters");
  }
  if (!binding.workflow || binding.workflow !== binding.workflow.trim() || binding.workflow.length > 256) {
    throw new StorageConflictError("Pilot approval workflow must be 1-256 non-whitespace-edge characters");
  }
  if (!sha256Hex.test(binding.evidenceDigest)) {
    throw new StorageConflictError("Pilot approval evidence digest must be a SHA-256 digest");
  }
  if (!sha256Hex.test(binding.policyHash)) {
    throw new StorageConflictError("Pilot approval policy hash must be a SHA-256 digest");
  }
  timestampMillis(binding.expiresAt, "Pilot approval expiresAt");
  return binding;
}

function bindingsEqual(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return left.action === right.action
    && left.exactEffect === right.exactEffect
    && left.projectId === right.projectId
    && left.workflow === right.workflow
    && left.evidenceDigest === right.evidenceDigest
    && left.policyHash === right.policyHash
    && left.expiresAt === right.expiresAt;
}

export function validateApprovalRequestBinding(approval: Approval, run: Run, observedAt: string): void {
  const binding = approvalBindingOf(approval);
  if (!binding) return;
  if (binding.projectId !== run.projectId) {
    throw new StorageConflictError("Pilot approval project binding does not match its owning run");
  }
  if (binding.workflow !== run.workflow) {
    throw new StorageConflictError("Pilot approval workflow binding does not match its owning run");
  }
  if (timestampMillis(binding.expiresAt, "Pilot approval expiresAt") <= timestampMillis(observedAt, "Observed storage time")) {
    throw new StorageConflictError("Pilot approval must expire in the future");
  }
}

export function validateApprovalResolutionBinding(
  approval: Approval,
  expectedBinding: ApprovalBinding | undefined,
  observedAt: string,
): void {
  const stored = approvalBindingOf(approval);
  if (stored && !expectedBinding) {
    throw new StorageConflictError("A bound pilot approval requires its exact expected action, effect, evidence, and policy binding");
  }
  if (expectedBinding) {
    const expected = approvalBindingOf({
      id: approval.id,
      runId: approval.runId,
      state: approval.state,
      evidence: approval.evidence,
      requestedAt: approval.requestedAt,
      ...expectedBinding,
    });
    if (!stored || !expected || !bindingsEqual(stored, expected)) {
      throw new StorageConflictError("Pilot approval binding does not match the expected evidence and policy");
    }
  }
  // The deadline governs acquisition of new approval authority. Once the
  // decision is durably recorded, an exact replay must remain idempotent even
  // if transport recovery happens after the deadline.
  if (stored && approval.state === "pending"
      && timestampMillis(stored.expiresAt, "Pilot approval expiresAt") <= timestampMillis(observedAt, "Observed storage time")) {
    throw new StorageConflictError("Pilot approval has expired");
  }
}

export function validateApprovalExpiry(approval: Approval, observedAt: string): ApprovalBinding {
  const binding = approvalBindingOf(approval);
  if (!binding) throw new StorageConflictError("Only a complete bound pilot approval can expire automatically");
  if (timestampMillis(binding.expiresAt, "Pilot approval expiresAt") > timestampMillis(observedAt, "Observed storage time")) {
    throw new StorageConflictError("Pilot approval has not expired");
  }
  return binding;
}

export function validateApprovalExpiryRunPatch(patch: MutableRunPatch): void {
  if (!patch.status || !["completed", "failed", "cancelled"].includes(patch.status)) {
    throw new StorageConflictError("Approval expiry requires a terminal run patch");
  }
}

export function assertRunPatchApplied(run: Run, patch: MutableRunPatch): void {
  for (const [key, requested] of Object.entries(patch)) {
    const stored = run[key as keyof Run];
    const matches = key === "metadata"
      ? canonicalJson(stored ?? {}) === canonicalJson(requested ?? {})
      : (stored ?? null) === (requested ?? null);
    if (!matches) throw new StorageConflictError("Expired approval replay does not match the requested terminal run patch");
  }
}

export function validateQueuedRunClaim(workerId: string, claimUntil: string, observedAt: string): void {
  if (!workerId || workerId !== workerId.trim() || workerId.length > 256 || /[\u0000-\u001f\u007f]/.test(workerId)) {
    throw new StorageConflictError("Run claim worker ID must be 1-256 safe characters");
  }
  if (timestampMillis(claimUntil, "Run claimUntil") <= timestampMillis(observedAt, "Observed storage time")) {
    throw new StorageConflictError("Run claim expiry must be after observed storage time");
  }
}

export function validateWriterLeaseRequest(input: WriterLeaseRequest): void {
  if (input.mode !== "writer") throw new StorageConflictError("Writing candidates require a writer lease");
  if (!input.ownerId || input.ownerId !== input.ownerId.trim() || input.ownerId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.ownerId)) {
    throw new StorageConflictError("Writer lease owner ID must be 1-256 printable non-whitespace-edge characters");
  }
  const heartbeatAt = timestampMillis(input.heartbeatAt, "Writer lease heartbeatAt");
  const expiresAt = timestampMillis(input.expiresAt, "Writer lease expiresAt");
  if (expiresAt <= heartbeatAt) throw new StorageConflictError("Writer lease expiry must be after its heartbeat");
}

export function observeStoreClock(clock: StoreClock): string {
  const observed = clock();
  const timestamp = observed instanceof Date ? observed.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new StorageConflictError("Storage clock returned an invalid time");
  return new Date(timestamp).toISOString();
}

export function validateWriterLeaseWindow(input: WriterLeaseRequest | WorkspaceLeaseRenewal, observedAt: string): void {
  const observed = timestampMillis(observedAt, "Observed storage time");
  const expiresAt = timestampMillis(input.expiresAt, "Writer lease expiresAt");
  if (expiresAt <= observed) throw new StorageConflictError("Writer lease expiry must be after observed storage time");
  if (expiresAt - observed > MAX_WRITER_LEASE_TTL_MS) {
    throw new StorageConflictError("Writer lease expiry may not exceed 24 hours from observed storage time");
  }
}

export function validateWorkspaceLeaseFence(input: WorkspaceLeaseFence): void {
  if (!input.ownerId || input.ownerId !== input.ownerId.trim() || input.ownerId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.ownerId)) {
    throw new StorageConflictError("Writer lease owner ID must be 1-256 printable non-whitespace-edge characters");
  }
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1 || input.fencingToken > maximumFencingToken) {
    throw new StorageConflictError("Writer lease fencing token must be a positive safe integer");
  }
}

export function validateWorkspaceLeaseRenewal(input: WorkspaceLeaseRenewal): void {
  validateWorkspaceLeaseFence(input);
  const heartbeatAt = timestampMillis(input.heartbeatAt, "Writer lease heartbeatAt");
  const expiresAt = timestampMillis(input.expiresAt, "Writer lease expiresAt");
  if (expiresAt <= heartbeatAt) throw new StorageConflictError("Writer lease expiry must be after its heartbeat");
}

export function validateWorkspaceLeaseQuarantine(input: WorkspaceLeaseQuarantine): void {
  validateWorkspaceLeaseFence(input);
  timestampMillis(input.quarantinedAt, "Writer lease quarantinedAt");
  if (!input.reason || input.reason !== input.reason.trim() || input.reason.length > 1_000 || /[\u0000-\u001f\u007f]/.test(input.reason)) {
    throw new StorageConflictError("Writer lease quarantine reason must be 1-1000 safe characters");
  }
}

function validateSandboxIdentity(value: string, field: string, maximum = 256): void {
  if (!value || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new StorageConflictError(`${field} must be 1-${maximum} safe characters`);
  }
}

export function validateSandboxInstanceCreate(input: SandboxInstanceCreateInput): void {
  validateSandboxIdentity(input.runId, "Sandbox run ID", 128);
  validateSandboxIdentity(input.workspaceId, "Sandbox workspace ID", 128);
  validateWorkspaceLeaseFence({
    workspaceId: input.workspaceId,
    runId: input.runId,
    ownerId: input.leaseOwnerId,
    fencingToken: input.fencingToken,
  });
  if (input.provider !== "docker-compatible") throw new StorageConflictError("Sandbox provider is not supported");
  if (!immutableImageRef.test(input.imageRef)) throw new StorageConflictError("Sandbox image must be an immutable SHA-256 reference");
  for (const [field, value] of [
    ["policyHash", input.policyHash],
    ["workspaceDigest", input.workspaceDigest],
    ["contextDigest", input.contextDigest],
    ["contextContentHash", input.contextContentHash],
    ["workdirDigest", input.workdirDigest],
  ] as const) {
    if (!sha256Hex.test(value)) throw new StorageConflictError(`Sandbox ${field} must be a SHA-256 digest`);
  }
  const createdAt = timestampMillis(input.createdAt, "Sandbox createdAt");
  const updatedAt = timestampMillis(input.updatedAt, "Sandbox updatedAt");
  if (updatedAt < createdAt) throw new StorageConflictError("Sandbox updatedAt cannot precede createdAt");
}

export function validateSandboxInstanceTransition(input: SandboxInstanceTransitionInput): void {
  validateWorkspaceLeaseFence(input);
  validateSandboxIdentity(input.runId, "Sandbox run ID", 128);
  validateSandboxIdentity(input.workspaceId, "Sandbox workspace ID", 128);
  timestampMillis(input.updatedAt, "Sandbox updatedAt");
  if (!sandboxTransitions[input.expectedState].has(input.state)) {
    throw new StorageConflictError(`Sandbox transition ${input.expectedState} -> ${input.state} is not allowed`);
  }
  if (input.engineId !== undefined && !sha256Hex.test(input.engineId)) {
    throw new StorageConflictError("Sandbox engine ID must be a SHA-256 identifier");
  }
  if (input.cleanupAttemptedAt !== undefined) timestampMillis(input.cleanupAttemptedAt, "Sandbox cleanupAttemptedAt");
  if (input.state === "quarantined") {
    validateSandboxIdentity(input.quarantineReason ?? "", "Sandbox quarantine reason", 1_000);
  } else if (input.quarantineReason !== undefined) {
    throw new StorageConflictError("Only a quarantined sandbox may record a quarantine reason");
  }
}

export function validateArtifactBatchInput(artifacts: Artifact[]): string {
  if (artifacts.length < 1 || artifacts.length > 1_000) {
    throw new StorageConflictError("Artifact batches must contain between 1 and 1000 items");
  }
  const runId = artifacts[0].runId;
  if (!runId) throw new StorageConflictError("Artifact batch run ID must not be empty");
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.id) throw new StorageConflictError("Artifact ID must not be empty");
    if (artifact.runId !== runId) throw new StorageConflictError("Every artifact in a batch must belong to the same run");
    if (ids.has(artifact.id)) throw new StorageConflictError(`Artifact batch contains duplicate ID ${artifact.id}`);
    ids.add(artifact.id);
    timestampMillis(artifact.createdAt, "Artifact createdAt");
  }
  return runId;
}

export function artifactsEqual(stored: Artifact, requested: Artifact): boolean {
  return stored.id === requested.id
    && stored.runId === requested.runId
    && stored.kind === requested.kind
    && stored.uri === requested.uri
    && stored.checksum === requested.checksum
    && stored.mediaType === requested.mediaType
    && stored.createdAt === requested.createdAt;
}

export function decodeJson<T>(value: unknown, fallback: T): T {
  if (value !== null && typeof value === "object") return value as T;
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function nullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : isoString(value);
}

export function deterministicOutboxId(topic: string, aggregateId: string, discriminator = "state"): string {
  const digest = createHash("sha256").update(`${topic}\0${aggregateId}\0${discriminator}`).digest("hex").slice(0, 32);
  return `outbox_${digest}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
