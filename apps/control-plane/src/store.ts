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

export interface WorkspaceLease {
  workspaceId: string;
  runId: string;
  mode: string;
  expiresAt: string;
  heartbeatAt: string;
}

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
  lease?: WorkspaceLease;
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
  createLease(lease: WorkspaceLease): Promise<void>;
  createWorkspaceLease(workspace: WorkspaceRecord, lease: WorkspaceLease): Promise<WorkspaceLeaseResult>;
  heartbeatLease(workspaceId: string, runId: string, heartbeatAt: string, expiresAt: string): Promise<boolean>;
  releaseLease(workspaceId: string): Promise<void>;
  releaseWorkspaceLease(workspaceId: string, runId: string): Promise<boolean>;
  listLeases(): Promise<WorkspaceLease[]>;

  requestApprovalTransaction(input: ApprovalRequestInput): Promise<ApprovalRequestResult>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(state?: string): Promise<Approval[]>;
  resolveApproval(id: string, state: string, decision: string, resolvedBy: string): Promise<void>;
  resolveApprovalTransaction(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult>;

  createArtifact(artifact: Artifact): Promise<void>;
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
