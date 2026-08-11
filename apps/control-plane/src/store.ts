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

export interface ApprovalResolutionInput {
  approvalId: string;
  state: string;
  decision: string;
  resolvedBy: string;
  resolvedAt?: string;
  runPatch?: MutableRunPatch;
  event?: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
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

  requestApprovalTransaction(input: ApprovalRequestInput): Promise<ApprovalRequestResult>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(state?: string): Promise<Approval[]>;
  resolveApproval(id: string, state: string, decision: string, resolvedBy: string): Promise<void>;
  resolveApprovalTransaction(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult>;

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

function timestampMillis(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new StorageConflictError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return parsed;
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
