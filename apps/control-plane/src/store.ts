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

/**
 * A narrow binding between a local control-plane object and the current
 * identity/revision observed at an external authority.  This is deliberately
 * not a provider payload snapshot or a roadmap replica.
 */
export interface AuthorityBinding {
  provider: string;
  localKind: string;
  localId: string;
  externalKind?: string | null;
  externalId: string;
  revision: string;
  observedAt: string;
  payloadHash: string;
  freshUntil: string;
}

/**
 * An explicit, compare-and-set authority refresh.  A changed external
 * identity/revision is never accepted by the ordinary binding operation.
 */
export interface AuthorityBindingRefreshInput extends AuthorityBinding {
  expectedExternalKind?: string | null;
  expectedExternalId: string;
  expectedRevision: string;
  expectedPayloadHash: string;
}

export interface ProviderReceipt {
  externalId: string;
  externalRevision: string;
  payloadHash: string;
  observedAt: string;
}

export type OutboxDeliveryState = "pending" | "claimed" | "delivered" | "dead";

export interface OutboxDeliveryAttemptEvidence {
  kind: "failure" | "claim_expired" | "replay";
  attempt: number;
  observedAt: string;
  errorCode?: string;
  errorFingerprint?: string;
  operatorId?: string;
}

export interface OutboxDelivery {
  outboxId: string;
  consumerId: string;
  state: OutboxDeliveryState;
  claimOwnerId: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  lastErrorCode: string | null;
  lastErrorFingerprint: string | null;
  providerReceipt: ProviderReceipt | null;
  attemptHistory: OutboxDeliveryAttemptEvidence[];
  /** The immutable source event is returned with the delivery for dispatch. */
  outbox: OutboxEvent;
  /** Convenience copies of the immutable source event fields. */
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  availableAt: string;
}

export interface OutboxDeliveryClaimInput {
  consumerId: string;
  ownerId: string;
  claimUntil: string;
  /** Exact allowlisted topics this consumer is authorized to receive. */
  topics: string[];
  limit?: number;
}

export interface OutboxDeliveryAckInput {
  outboxId: string;
  consumerId: string;
  ownerId: string;
  claimToken: string;
  providerReceipt?: ProviderReceipt;
  /** Optional first binding or exact-evidence refresh, committed with ack. */
  authorityBinding?: AuthorityBinding | AuthorityBindingRefreshInput;
}

export interface OutboxDeliveryFailureInput {
  outboxId: string;
  consumerId: string;
  ownerId: string;
  claimToken: string;
  errorCode: string;
  errorFingerprint: string;
  /** Caller may select a bounded retry time; the store validates it. */
  nextAttemptAt?: string;
}

export interface OutboxDeliveryReplayInput {
  outboxId: string;
  consumerId: string;
  operatorId: string;
  nextAttemptAt?: string;
}

export interface OutboxDeliveryPruneInput {
  before: string;
  limit?: number;
}

export type ExternalActionKind =
  | "linear_create_issue"
  | "linear_evidence_comment"
  | "github_create_draft_pr";
export type ExternalActionProvider = "linear" | "github";
export type ExternalActionPlanState =
  | "pending_approval"
  | "authorized"
  | "executing"
  | "ambiguous"
  | "succeeded"
  | "denied"
  | "expired"
  | "failed"
  | "quarantined";

export interface ExternalActionProviderReceipt extends ProviderReceipt {
  marker: string;
  targetHash: string;
}

export type ExternalActionReconciliationOutcome = "zero" | "one" | "multiple";

export interface ExternalActionReconciliationEvidence {
  outcome: ExternalActionReconciliationOutcome;
  marker: string;
  targetHash: string;
  operatorId: string;
  observedAt: string;
  matchCount: number;
  externalId?: string | null;
  externalRevision?: string | null;
  payloadHash?: string | null;
}

export interface ExternalActionPlan {
  id: string;
  runId: string;
  projectId: string;
  workflow: string;
  kind: ExternalActionKind;
  provider: ExternalActionProvider;
  marker: string;
  target: Record<string, unknown>;
  spec: Record<string, unknown>;
  requestHash: string;
  evidenceDigest: string;
  policyHash: string;
  approvalId: string;
  approvalAction: string;
  exactEffect: string;
  expiresAt: string;
  state: ExternalActionPlanState;
  attempts: number;
  providerReceipt: ExternalActionProviderReceipt | null;
  result: Record<string, unknown> | null;
  lastErrorCode: string | null;
  lastErrorFingerprint: string | null;
  reconciliation: ExternalActionReconciliationEvidence | null;
  authorizedOutboxId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalActionPlanRequestInput {
  plan: ExternalActionPlan;
  approval: Approval;
  event: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
}

export interface ExternalActionPlanRequestResult {
  plan: ExternalActionPlan;
  approval: Approval;
  event: RunEvent;
  replayed: boolean;
}

export interface ExternalActionApprovalInput {
  planId: string;
  state: "approved" | "denied" | "changes_requested";
  decision: string;
  resolvedBy: string;
  expectedBinding: ApprovalBinding;
  event?: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
}

export interface ExternalActionApprovalResult {
  plan: ExternalActionPlan;
  approval: Approval;
  event?: RunEvent;
  replayed: boolean;
}

export interface ExternalActionPlanExpiryInput {
  planId: string;
  event: Omit<RunEvent, "seq">;
  idempotency?: IdempotencyInput;
}

export interface ExternalActionDeliveryFence {
  outboxId: string;
  consumerId: string;
  ownerId: string;
  claimToken: string;
}

export interface BeginExternalActionAttemptInput {
  planId: string;
  delivery: ExternalActionDeliveryFence;
}

export interface CompleteExternalActionAttemptInput {
  planId: string;
  delivery: ExternalActionDeliveryFence;
  providerReceipt: ExternalActionProviderReceipt;
  result: Record<string, unknown>;
}

export interface FailExternalActionAttemptInput {
  planId: string;
  delivery: ExternalActionDeliveryFence;
  errorCode: string;
  errorFingerprint: string;
  ambiguous?: boolean;
  nextAttemptAt?: string;
}

export interface ReconcileExternalActionPlanInput {
  planId: string;
  deliveryConsumerId: string;
  operatorId: string;
  evidence: ExternalActionReconciliationEvidence;
}

export interface ExternalActionPlanListInput {
  projectId?: string;
  state?: ExternalActionPlanState;
  limit?: number;
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
  providerSessionId: string | null;
  providerSessionReused: boolean;
}

export type ComparisonStatus = "running" | "complete" | "failed";
export type ComparisonCandidateStatus = "running" | "evidence_ready" | "accepted" | "rejected" | "failed";

export interface ComparisonRecord {
  id: string;
  projectId: string;
  taskId: string;
  objective: string;
  contractHash: string;
  status: ComparisonStatus;
  selectionPolicy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ComparisonMetrics {
  correctness: "passed" | "failed";
  defectsCaught: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  elapsedMs: number;
  humanReviewArtifacts: number;
  eventCount: number;
  recoveryReliability: "not_exercised" | "recovered" | "failed";
  resumability: "none" | "control_plane_only" | "native";
  integrationComplexity: number;
}

export interface ComparisonCandidate {
  comparisonId: string;
  runId: string;
  runtime: string;
  workflow: string;
  ordinal: number;
  status: ComparisonCandidateStatus;
  metrics: ComparisonMetrics | null;
  evidenceDigest: string | null;
  createdAt: string;
  updatedAt: string;
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
  /** Provider session lineage is audit evidence, not a resume capability. */
  providerSessionId?: string | null;
  providerSessionReused?: boolean;
}

export type EngineeringRoutingScore = 0 | 1 | 2;
export type EngineeringRoutingPreference = "auto" | "direct" | "atomic-lite" | "atomic-full";
export type EngineeringRoutingShape = Exclude<EngineeringRoutingPreference, "auto">;
export type EngineeringRoutingStatus = "assessed" | "unsupported" | "expired";
export type EngineeringFinalActionIntent = "analysis_only" | "prepare_reviewable_result";

export interface EngineeringRoutingDimensions {
  structure: EngineeringRoutingScore;
  verifiability: EngineeringRoutingScore;
  iteration: EngineeringRoutingScore;
  risk: EngineeringRoutingScore;
  duration: EngineeringRoutingScore;
  isolation: EngineeringRoutingScore;
}

export interface EngineeringRoutingHardSignals {
  explicitLoop: boolean;
  durableBackground: boolean;
  approvalOrEvidenceGate: boolean;
  multipleCandidates: boolean;
}

/**
 * Context provenance is intentionally structured but provider-specific details
 * remain opaque to storage. The three named authorities are required; each
 * source may be a short status string or a bounded status/details object.
 */
export type EngineeringRoutingContextSource = string | {
  status: string;
  [key: string]: unknown;
};

export interface EngineeringRoutingContextSources {
  linear: EngineeringRoutingContextSource;
  git: EngineeringRoutingContextSource;
  projectBrain: EngineeringRoutingContextSource;
  [key: string]: EngineeringRoutingContextSource;
}

export interface EngineeringRoutingAssessmentRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  literalRequest: string;
  requestHash: string;
  contextDigest: string;
  contextSources: EngineeringRoutingContextSources;
  dimensions: EngineeringRoutingDimensions;
  hardSignals: EngineeringRoutingHardSignals;
  preference: EngineeringRoutingPreference;
  finalAction: EngineeringFinalActionIntent;
  baselineShape: EngineeringRoutingShape;
  selectedShape: EngineeringRoutingShape;
  score: number;
  reasons: string[];
  policyVersion: string;
  executionSupported: boolean;
  unsupportedReasons: string[];
  status: EngineeringRoutingStatus;
  /** Reserved for a later explicit run-binding operation; create currently requires null. */
  runId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CreateEngineeringRoutingAssessmentInput {
  assessment?: EngineeringRoutingAssessmentRecord;
  /** Alias accepted for callers that use the word "record" in their transport shape. */
  record?: EngineeringRoutingAssessmentRecord;
  idempotency?: IdempotencyInput;
}

export interface CreateEngineeringRoutingAssessmentResult {
  assessment: EngineeringRoutingAssessmentRecord;
  replayed: boolean;
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

  createEngineeringRoutingAssessment(
    input: CreateEngineeringRoutingAssessmentInput,
  ): Promise<CreateEngineeringRoutingAssessmentResult>;
  createEngineeringRoutingAssessment(
    assessment: EngineeringRoutingAssessmentRecord,
    idempotency?: IdempotencyInput,
  ): Promise<CreateEngineeringRoutingAssessmentResult>;
  getEngineeringRoutingAssessment(id: string): Promise<EngineeringRoutingAssessmentRecord | null>;
  listEngineeringRoutingAssessments(projectId?: string, limit?: number): Promise<EngineeringRoutingAssessmentRecord[]>;

  createComparison(comparison: ComparisonRecord): Promise<ComparisonRecord>;
  getComparison(id: string): Promise<ComparisonRecord | null>;
  completeComparison(id: string, status: "complete" | "failed", completedAt: string): Promise<ComparisonRecord>;
  attachComparisonCandidate(candidate: ComparisonCandidate): Promise<ComparisonCandidate>;
  finalizeComparisonCandidate(candidate: ComparisonCandidate): Promise<ComparisonCandidate>;
  listComparisonCandidates(comparisonId: string): Promise<ComparisonCandidate[]>;

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
  /** Create or replay an unchanged local-to-authority binding. */
  createAuthorityBinding(binding: AuthorityBinding): Promise<AuthorityBinding>;
  /** Alias for callers that use the domain term "bind". */
  bindAuthority(binding: AuthorityBinding): Promise<AuthorityBinding>;
  getAuthorityBinding(provider: string, localKind: string, localId: string): Promise<AuthorityBinding | null>;
  listAuthorityBindings(provider?: string, limit?: number): Promise<AuthorityBinding[]>;
  /** Explicit compare-and-set refresh for changed external identity/revision evidence. */
  refreshAuthorityBinding(input: AuthorityBindingRefreshInput): Promise<AuthorityBinding>;

  claimOutboxDeliveries(input: OutboxDeliveryClaimInput): Promise<OutboxDelivery[]>;
  getOutboxDelivery(outboxId: string, consumerId: string): Promise<OutboxDelivery | null>;
  listOutboxDeliveries(consumerId?: string, state?: OutboxDeliveryState, limit?: number): Promise<OutboxDelivery[]>;
  /** Ack is fenced by the exact unexpired claim and may atomically bind a receipt. */
  ackOutboxDelivery(input: OutboxDeliveryAckInput): Promise<OutboxDelivery>;
  failOutboxDelivery(input: OutboxDeliveryFailureInput): Promise<OutboxDelivery>;
  replayOutboxDelivery(input: OutboxDeliveryReplayInput): Promise<OutboxDelivery>;
  pruneOutboxDeliveries(input: OutboxDeliveryPruneInput): Promise<number>;
  pruneOutboxDeliveries(before: string, limit?: number): Promise<number>;
  requestExternalActionPlan(input: ExternalActionPlanRequestInput): Promise<ExternalActionPlanRequestResult>;
  getExternalActionPlan(id: string): Promise<ExternalActionPlan | null>;
  listExternalActionPlans(input?: ExternalActionPlanListInput): Promise<ExternalActionPlan[]>;
  resolveExternalActionPlanApproval(input: ExternalActionApprovalInput): Promise<ExternalActionApprovalResult>;
  expireExternalActionPlanApproval(input: ExternalActionPlanExpiryInput): Promise<ExternalActionApprovalResult>;
  beginExternalActionAttempt(input: BeginExternalActionAttemptInput): Promise<ExternalActionPlan>;
  completeExternalActionAttempt(input: CompleteExternalActionAttemptInput): Promise<ExternalActionPlan>;
  failExternalActionAttempt(input: FailExternalActionAttemptInput): Promise<ExternalActionPlan>;
  reconcileExternalActionPlan(input: ReconcileExternalActionPlanInput): Promise<ExternalActionPlan>;
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
const safeProviderSessionId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const safeRoutingPolicyVersion = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const safeAuthorityValue = /^[A-Za-z0-9][A-Za-z0-9_.:/@#-]{0,511}$/;
const safeDeliveryConsumer = /^[A-Za-z0-9][A-Za-z0-9_.:/@#-]{0,127}$/;
const safeDeliveryOwner = /^[A-Za-z0-9][A-Za-z0-9_.:/@#-]{0,255}$/;
const safeDeliveryToken = /^[a-f0-9]{64}$/;
const safeDeliveryErrorCode = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const safeOutboxTopic = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const safeExternalMarker = /^(?:[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}|<!-- valkyrie-action:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127} -->)$/;
const safeExternalActionId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const externalActionKinds = new Set<ExternalActionKind>([
  "linear_create_issue", "linear_evidence_comment", "github_create_draft_pr",
]);
const externalActionProviders = new Set<ExternalActionProvider>(["linear", "github"]);
const externalActionStates = new Set<ExternalActionPlanState>([
  "pending_approval", "authorized", "executing", "ambiguous", "succeeded", "denied", "expired", "failed", "quarantined",
]);
const externalActionForbiddenKey = /token|secret|password|authorization|credential|raw.?body|raw.?response|request.?body/i;
const inferenceRoles = new Set<InferenceRole>(["implementer", "verifier_initial", "repair", "verifier_final"]);
const immutableImageRef = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
export const MAX_OUTBOX_DELIVERY_ATTEMPTS = 8;
export const MAX_OUTBOX_DELIVERY_RETRY_DELAY_MS = 15 * 60 * 1000;
export const MAX_OUTBOX_DELIVERY_CLAIM_TTL_MS = 15 * 60 * 1000;
export const MAX_OUTBOX_DELIVERY_LIMIT = 1_000;
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

function validateSafeAuthorityText(value: unknown, field: string, maximum = 512): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/.test(value) || value !== value.trim()) {
    throw new StorageConflictError(`${field} must be 1-${maximum} safe non-whitespace-edge characters`);
  }
}

function validateAuthorityValue(value: unknown, field: string, maximum = 512): asserts value is string {
  validateSafeAuthorityText(value, field, maximum);
  if (!safeAuthorityValue.test(value)) throw new StorageConflictError(`${field} contains unsupported characters`);
}

export function validateDeliveryIdentity(value: unknown, field: string, maximum = 256): asserts value is string {
  validateSafeAuthorityText(value, field, maximum);
}

function validateDeliveryCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !safeDeliveryErrorCode.test(value)) {
    throw new StorageConflictError(`${field} must be a bounded safe error code`);
  }
}

function validateDeliveryFingerprint(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !sha256Hex.test(value)) {
    throw new StorageConflictError(`${field} must be a lowercase SHA-256 fingerprint`);
  }
}

export function validateAuthorityBinding(binding: AuthorityBinding): void {
  validateAuthorityValue(binding.provider, "Authority provider", 128);
  validateAuthorityValue(binding.localKind, "Authority local kind", 128);
  validateAuthorityValue(binding.localId, "Authority local ID", 256);
  if (binding.externalKind !== undefined && binding.externalKind !== null) {
    validateAuthorityValue(binding.externalKind, "Authority external kind", 128);
  }
  validateAuthorityValue(binding.externalId, "Authority external ID", 256);
  validateAuthorityValue(binding.revision, "Authority revision", 512);
  validateAuthorityValue(binding.payloadHash, "Authority payload hash", 128);
  if (!sha256Hex.test(binding.payloadHash)) throw new StorageConflictError("Authority payload hash must be a lowercase SHA-256 digest");
  const observed = timestampMillis(binding.observedAt, "Authority observedAt");
  const freshUntil = timestampMillis(binding.freshUntil, "Authority freshUntil");
  if (freshUntil <= observed) throw new StorageConflictError("Authority freshness must extend beyond observedAt");
  if (freshUntil - observed > 30 * 24 * 60 * 60 * 1000) {
    throw new StorageConflictError("Authority freshness may not exceed 30 days");
  }
}

export function validateAuthorityRefresh(input: AuthorityBindingRefreshInput): void {
  validateAuthorityBinding(input);
  if (input.expectedExternalKind !== undefined && input.expectedExternalKind !== null) {
    validateAuthorityValue(input.expectedExternalKind, "Expected authority external kind", 128);
  }
  validateAuthorityValue(input.expectedExternalId, "Expected authority external ID", 256);
  validateAuthorityValue(input.expectedRevision, "Expected authority revision", 512);
  validateDeliveryFingerprint(input.expectedPayloadHash, "Expected authority payload hash");
}

export function validateProviderReceipt(receipt: ProviderReceipt): void {
  validateAuthorityValue(receipt.externalId, "Provider receipt external ID", 256);
  validateAuthorityValue(receipt.externalRevision, "Provider receipt revision", 512);
  validateDeliveryFingerprint(receipt.payloadHash, "Provider receipt payload hash");
  timestampMillis(receipt.observedAt, "Provider receipt observedAt");
}

export function validateOutboxDeliveryClaim(input: OutboxDeliveryClaimInput, observedAt: string): void {
  validateDeliveryIdentity(input.consumerId, "Outbox consumer ID", 128);
  validateDeliveryIdentity(input.ownerId, "Outbox claim owner ID", 256);
  if (!Array.isArray(input.topics) || input.topics.length < 1 || input.topics.length > 64
      || new Set(input.topics).size !== input.topics.length) {
    throw new StorageConflictError("Outbox claim topics must contain 1-64 unique exact topics");
  }
  for (const topic of input.topics) {
    if (!safeOutboxTopic.test(topic)) throw new StorageConflictError("Outbox claim topics contain an invalid exact topic");
  }
  const observed = timestampMillis(observedAt, "Observed storage time");
  const claimUntil = timestampMillis(input.claimUntil, "Outbox claimUntil");
  if (claimUntil <= observed) throw new StorageConflictError("Outbox claim expiry must be after observed storage time");
  if (claimUntil - observed > MAX_OUTBOX_DELIVERY_CLAIM_TTL_MS) {
    throw new StorageConflictError("Outbox claim expiry exceeds the bounded claim TTL");
  }
  boundedInteger(input.limit ?? 100, "Outbox claim limit", 1, MAX_OUTBOX_DELIVERY_LIMIT);
}

export function validateOutboxDeliveryFence(input: Pick<OutboxDeliveryAckInput, "outboxId" | "consumerId" | "ownerId" | "claimToken">): void {
  validateDeliveryIdentity(input.outboxId, "Outbox ID", 256);
  validateDeliveryIdentity(input.consumerId, "Outbox consumer ID", 128);
  validateDeliveryIdentity(input.ownerId, "Outbox claim owner ID", 256);
  if (!safeDeliveryToken.test(input.claimToken)) throw new StorageConflictError("Outbox claim token is invalid");
}

export function validateOutboxDeliveryFailure(input: OutboxDeliveryFailureInput, observedAt: string): void {
  validateOutboxDeliveryFence(input);
  validateDeliveryCode(input.errorCode, "Outbox error code");
  validateDeliveryFingerprint(input.errorFingerprint, "Outbox error fingerprint");
  if (input.nextAttemptAt !== undefined) {
    const observed = timestampMillis(observedAt, "Observed storage time");
    const next = timestampMillis(input.nextAttemptAt, "Outbox nextAttemptAt");
    if (next < observed || next - observed > MAX_OUTBOX_DELIVERY_RETRY_DELAY_MS) {
      throw new StorageConflictError("Outbox retry time must be within the bounded retry delay");
    }
  }
}

export function validateOutboxDeliveryReplay(input: OutboxDeliveryReplayInput, observedAt: string): void {
  validateDeliveryIdentity(input.outboxId, "Outbox ID", 256);
  validateDeliveryIdentity(input.consumerId, "Outbox consumer ID", 128);
  validateDeliveryIdentity(input.operatorId, "Outbox replay operator ID", 256);
  if (input.nextAttemptAt !== undefined) {
    const observed = timestampMillis(observedAt, "Observed storage time");
    const next = timestampMillis(input.nextAttemptAt, "Outbox replay nextAttemptAt");
    if (next < observed || next - observed > MAX_OUTBOX_DELIVERY_RETRY_DELAY_MS) {
      throw new StorageConflictError("Outbox replay time must be within the bounded retry delay");
    }
  }
}

export function validateOutboxDeliveryPrune(input: OutboxDeliveryPruneInput): void {
  timestampMillis(input.before, "Outbox delivery prune cutoff");
  boundedInteger(input.limit ?? 100, "Outbox delivery prune limit", 1, MAX_OUTBOX_DELIVERY_LIMIT);
}

function validateExternalJson(value: unknown, field: string, depth = 0): void {
  if (depth > 8) throw new StorageConflictError(`${field} nesting exceeds the safe bound`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new StorageConflictError(`${field} contains unsafe text`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StorageConflictError(`${field} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new StorageConflictError(`${field} contains too many items`);
    for (const item of value) validateExternalJson(item, field, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new StorageConflictError(`${field} must be JSON data`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) || externalActionForbiddenKey.test(key)) {
      throw new StorageConflictError(`${field} contains a forbidden or unsafe field`);
    }
    validateExternalJson(item, `${field}.${key}`, depth + 1);
  }
}

function validateExternalJsonObject(value: unknown, field: string, maximum = 16_384): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageConflictError(`${field} must be a JSON object`);
  }
  validateExternalJson(value, field);
  let serialized: string;
  try { serialized = canonicalJson(value); } catch { throw new StorageConflictError(`${field} must be JSON serializable`); }
  if (new TextEncoder().encode(serialized).byteLength > maximum) {
    throw new StorageConflictError(`${field} exceeds ${maximum} UTF-8 bytes`);
  }
}

export function externalActionTargetHash(target: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(target)).digest("hex");
}

export function externalActionAuthorizedOutboxId(planId: string): string {
  return deterministicOutboxId("external.action.authorized", planId, "authorized");
}

export function validateExternalActionPlan(plan: ExternalActionPlan): void {
  for (const [field, value] of [["External action plan ID", plan.id], ["External action run ID", plan.runId],
    ["External action project ID", plan.projectId], ["External action workflow", plan.workflow],
    ["External action approval ID", plan.approvalId]] as const) {
    if (typeof value !== "string" || !safeExternalActionId.test(value)) throw new StorageConflictError(`${field} is invalid`);
  }
  if (!externalActionKinds.has(plan.kind)) throw new StorageConflictError("External action kind is invalid");
  if (!externalActionProviders.has(plan.provider)) throw new StorageConflictError("External action provider is invalid");
  if ((plan.kind.startsWith("linear_") && plan.provider !== "linear")
      || (plan.kind.startsWith("github_") && plan.provider !== "github")) {
    throw new StorageConflictError("External action kind/provider do not agree");
  }
  if (typeof plan.marker !== "string" || !safeExternalMarker.test(plan.marker)) {
    throw new StorageConflictError("External action marker is invalid");
  }
  validateExternalJsonObject(plan.target, "External action target");
  validateExternalJsonObject(plan.spec, "External action spec");
  for (const [field, value] of [["requestHash", plan.requestHash], ["evidenceDigest", plan.evidenceDigest], ["policyHash", plan.policyHash]] as const) {
    if (!sha256Hex.test(value)) throw new StorageConflictError(`External action ${field} must be a SHA-256 digest`);
  }
  validateDeliveryIdentity(plan.approvalAction, "External action approval action", 256);
  validateSafeAuthorityText(plan.exactEffect, "External action exact effect", 2_048);
  if (!externalActionStates.has(plan.state)) throw new StorageConflictError("External action plan state is invalid");
  boundedInteger(plan.attempts, "External action attempts", 0, MAX_OUTBOX_DELIVERY_ATTEMPTS);
  const createdAt = timestampMillis(plan.createdAt, "External action createdAt");
  const updatedAt = timestampMillis(plan.updatedAt, "External action updatedAt");
  const expiresAt = timestampMillis(plan.expiresAt, "External action expiresAt");
  if (updatedAt < createdAt || expiresAt <= createdAt || expiresAt - createdAt > 30 * 24 * 60 * 60 * 1000) {
    throw new StorageConflictError("External action plan validity window is invalid");
  }
  if (plan.providerReceipt) validateExternalActionReceipt(plan.providerReceipt, plan);
  if (plan.result) validateExternalJsonObject(plan.result, "External action result");
  if (plan.lastErrorCode !== null) validateDeliveryCode(plan.lastErrorCode, "External action error code");
  if (plan.lastErrorFingerprint !== null) validateDeliveryFingerprint(plan.lastErrorFingerprint, "External action error fingerprint");
  if ((plan.lastErrorCode === null) !== (plan.lastErrorFingerprint === null)) {
    throw new StorageConflictError("External action error code and fingerprint must be paired");
  }
  if (plan.reconciliation) validateExternalActionReconciliation(plan.reconciliation, plan);
  if (plan.authorizedOutboxId !== null) validateDeliveryIdentity(plan.authorizedOutboxId, "External action authorized outbox ID", 256);
}

export function validateExternalActionReceipt(
  receipt: ExternalActionProviderReceipt,
  plan: Pick<ExternalActionPlan, "marker" | "target">,
): void {
  validateProviderReceipt(receipt);
  if (!safeExternalMarker.test(receipt.marker) || receipt.marker !== plan.marker) {
    throw new StorageConflictError("External action receipt marker does not match the plan");
  }
  if (receipt.targetHash !== externalActionTargetHash(plan.target) || !sha256Hex.test(receipt.targetHash)) {
    throw new StorageConflictError("External action receipt target hash does not match the plan");
  }
}

export function validateExternalActionReconciliation(
  evidence: ExternalActionReconciliationEvidence,
  plan: Pick<ExternalActionPlan, "marker" | "target">,
): void {
  if (!['zero', 'one', 'multiple'].includes(evidence.outcome)) throw new StorageConflictError("External action reconciliation outcome is invalid");
  if (evidence.marker !== plan.marker || !safeExternalMarker.test(evidence.marker)) {
    throw new StorageConflictError("External action reconciliation marker does not match the plan");
  }
  if (evidence.targetHash !== externalActionTargetHash(plan.target) || !sha256Hex.test(evidence.targetHash)) {
    throw new StorageConflictError("External action reconciliation target hash does not match the plan");
  }
  validateDeliveryIdentity(evidence.operatorId, "External action reconciliation operator ID", 256);
  timestampMillis(evidence.observedAt, "External action reconciliation observedAt");
  boundedInteger(evidence.matchCount, "External action reconciliation matchCount", 0, 1_000);
  if (evidence.outcome === "zero" && evidence.matchCount !== 0) throw new StorageConflictError("Zero reconciliation must record zero matches");
  if (evidence.outcome === "one" && evidence.matchCount !== 1) throw new StorageConflictError("One reconciliation must record exactly one match");
  if (evidence.outcome === "multiple" && evidence.matchCount < 2) throw new StorageConflictError("Multiple reconciliation must record at least two matches");
  if (evidence.outcome === "one") {
    if (typeof evidence.externalId !== "string"
        || typeof evidence.externalRevision !== "string"
        || typeof evidence.payloadHash !== "string") {
      throw new StorageConflictError("One-match reconciliation must record a complete provider identity");
    }
    validateAuthorityValue(evidence.externalId, "External action reconciled external ID", 256);
    validateAuthorityValue(evidence.externalRevision, "External action reconciled revision", 512);
    validateDeliveryFingerprint(evidence.payloadHash, "External action reconciled payload hash");
  } else if (evidence.externalId !== undefined || evidence.externalRevision !== undefined || evidence.payloadHash !== undefined) {
    throw new StorageConflictError("Only one-match reconciliation may record a provider identity");
  }
}

export function validateExternalActionPlanRequest(
  plan: ExternalActionPlan,
  approval: Approval,
  run: Run,
  observedAt: string,
): void {
  validateExternalActionPlan(plan);
  if (plan.state !== "pending_approval" || plan.attempts !== 0 || plan.providerReceipt || plan.result
      || plan.lastErrorCode !== null || plan.lastErrorFingerprint !== null || plan.reconciliation || plan.authorizedOutboxId !== null) {
    throw new StorageConflictError("A new external action plan must be pending and have no execution evidence");
  }
  if (run.status !== "completed") throw new StorageConflictError("External action plans require a completed evidence run");
  if (plan.runId !== run.id || plan.projectId !== run.projectId || (plan.workflow ?? null) !== (run.workflow ?? null)) {
    throw new StorageConflictError("External action plan does not match its completed run");
  }
  if (approval.state !== "pending" || approval.id !== plan.approvalId || approval.runId !== plan.runId
      || approval.action !== plan.approvalAction || approval.exactEffect !== plan.exactEffect) {
    throw new StorageConflictError("External action approval does not match the plan");
  }
  const binding = approvalBindingOf(approval);
  if (!binding || binding.action !== plan.approvalAction || binding.exactEffect !== plan.exactEffect
      || binding.projectId !== plan.projectId || binding.workflow !== plan.workflow
      || binding.evidenceDigest !== plan.evidenceDigest || binding.policyHash !== plan.policyHash
      || binding.expiresAt !== plan.expiresAt) {
    throw new StorageConflictError("External action approval binding does not match the plan evidence and policy");
  }
  validateApprovalRequestBinding(approval, run, observedAt);
}

export function validateExternalActionDeliveryFence(input: ExternalActionDeliveryFence): void {
  validateOutboxDeliveryFence(input);
}

export function validateExternalActionError(input: FailExternalActionAttemptInput, observedAt: string): void {
  validateExternalActionDeliveryFence(input.delivery);
  validateDeliveryCode(input.errorCode, "External action error code");
  validateDeliveryFingerprint(input.errorFingerprint, "External action error fingerprint");
  if (input.nextAttemptAt !== undefined) {
    const observed = timestampMillis(observedAt, "Observed storage time");
    const next = timestampMillis(input.nextAttemptAt, "External action nextAttemptAt");
    if (next < observed || next - observed > MAX_OUTBOX_DELIVERY_RETRY_DELAY_MS) {
      throw new StorageConflictError("External action retry time is outside the bounded delay");
    }
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
  boundedInteger(capability.maxRequests, "Inference maxRequests", 1, 16);
  boundedInteger(capability.maxInputTokens, "Inference maxInputTokens", 1, 1_000_000);
  boundedInteger(capability.maxOutputTokens, "Inference maxOutputTokens", 1, 131_072);
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
  const hasProviderSessionId = input.providerSessionId !== undefined;
  const hasProviderSessionReused = input.providerSessionReused !== undefined;
  if (hasProviderSessionId !== hasProviderSessionReused) {
    throw new StorageConflictError("Provider session ID and reuse flag must be supplied together");
  }
  if (hasProviderSessionReused && typeof input.providerSessionReused !== "boolean") {
    throw new StorageConflictError("Provider session reuse flag must be boolean");
  }
  if (input.providerSessionId !== undefined && input.providerSessionId !== null
      && !safeProviderSessionId.test(input.providerSessionId)) {
    throw new StorageConflictError("Inference provider session ID is invalid");
  }
  const providerSessionId = input.providerSessionId ?? null;
  const providerSessionReused = input.providerSessionReused ?? false;
  if (providerSessionId === null && providerSessionReused) {
    throw new StorageConflictError("A reused provider session requires a provider session ID");
  }
  if (input.state === "failed" && providerSessionId !== null) {
    throw new StorageConflictError("Failed inference requests may not claim a provider session");
  }
  boundedInteger(input.inputTokens, "Inference inputTokens", 0, 1_000_000);
  boundedInteger(input.outputTokens, "Inference outputTokens", 0, 131_072);
  boundedInteger(input.costMicros, "Inference costMicros", 0, 100_000_000);
}

function validateRoutingText(value: unknown, field: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new StorageConflictError(`${field} must be 1-${maximum} safe characters`);
  }
}

function validateRoutingIdentity(value: unknown, field: string): asserts value is string {
  validateRoutingText(value, field, 128);
  if (value !== value.trim()) throw new StorageConflictError(`${field} must not have whitespace at its edges`);
}

function validateRoutingContextSource(value: unknown, field: string): void {
  if (typeof value === "string") {
    validateRoutingText(value, `${field} status`, 128);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageConflictError(`${field} must be a status string or object`);
  }
  const status = (value as Record<string, unknown>).status;
  validateRoutingText(status, `${field}.status`, 128);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new StorageConflictError(`${field} must be JSON serializable`); }
  if (serialized.length > 4_096) throw new StorageConflictError(`${field} details exceed 4096 bytes`);
}

function validateRoutingStringArray(value: unknown, field: string, maximumItems = 32, maximumLength = 512): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new StorageConflictError(`${field} must contain at most ${maximumItems} strings`);
  }
  for (const [index, item] of value.entries()) validateRoutingText(item, `${field}[${index}]`, maximumLength);
}

export function validateEngineeringRoutingAssessment(value: EngineeringRoutingAssessmentRecord): void {
  validateRoutingIdentity(value.id, "Routing assessment ID");
  validateRoutingIdentity(value.projectId, "Routing assessment project ID");
  if (value.taskId !== null) validateRoutingIdentity(value.taskId, "Routing assessment task ID");
  validateRoutingText(value.literalRequest, "Routing literal request", 16_384);
  if (!sha256Hex.test(value.requestHash)) throw new StorageConflictError("Routing request hash must be a lowercase SHA-256 digest");
  if (!sha256Hex.test(value.contextDigest)) throw new StorageConflictError("Routing context digest must be a lowercase SHA-256 digest");
  if (!value.contextSources || typeof value.contextSources !== "object" || Array.isArray(value.contextSources)) {
    throw new StorageConflictError("Routing context sources must be an object");
  }
  for (const name of ["linear", "git", "projectBrain"] as const) {
    validateRoutingContextSource(value.contextSources[name], `Routing context source ${name}`);
  }
  const dimensions = value.dimensions;
  if (!dimensions || typeof dimensions !== "object") throw new StorageConflictError("Routing dimensions are required");
  let score = 0;
  for (const name of ["structure", "verifiability", "iteration", "risk", "duration", "isolation"] as const) {
    boundedInteger(dimensions[name], `Routing ${name}`, 0, 2);
    score += dimensions[name];
  }
  if (!Number.isSafeInteger(value.score) || value.score < 0 || value.score > 12 || value.score !== score) {
    throw new StorageConflictError("Routing score must equal the six-dimension total between 0 and 12");
  }
  const hardSignals = value.hardSignals;
  if (!hardSignals || typeof hardSignals !== "object") throw new StorageConflictError("Routing hard signals are required");
  for (const name of ["explicitLoop", "durableBackground", "approvalOrEvidenceGate", "multipleCandidates"] as const) {
    if (typeof hardSignals[name] !== "boolean") throw new StorageConflictError(`Routing hard signal ${name} must be boolean`);
  }
  if (!["auto", "direct", "atomic-lite", "atomic-full"].includes(value.preference)) {
    throw new StorageConflictError("Routing preference is invalid");
  }
  if (!["analysis_only", "prepare_reviewable_result"].includes(value.finalAction)) {
    throw new StorageConflictError("Routing final-action intent is invalid");
  }
  if (!["direct", "atomic-lite", "atomic-full"].includes(value.baselineShape)
      || !["direct", "atomic-lite", "atomic-full"].includes(value.selectedShape)) {
    throw new StorageConflictError("Routing execution shape is invalid");
  }
  validateRoutingStringArray(value.reasons, "Routing reasons");
  validateRoutingIdentity(value.policyVersion, "Routing policy version");
  if (!safeRoutingPolicyVersion.test(value.policyVersion)) throw new StorageConflictError("Routing policy version is invalid");
  if (typeof value.executionSupported !== "boolean") throw new StorageConflictError("Routing executionSupported must be boolean");
  validateRoutingStringArray(value.unsupportedReasons, "Routing unsupported reasons");
  if (!["assessed", "unsupported", "expired"].includes(value.status)) {
    throw new StorageConflictError("Routing assessment status is invalid");
  }
  if (value.status === "unsupported" && value.executionSupported) {
    throw new StorageConflictError("Unsupported routing assessments cannot claim execution support");
  }
  if (value.status === "assessed" && !value.executionSupported) {
    throw new StorageConflictError("Assessed routing assessments must be execution-supported");
  }
  if (value.runId !== null) {
    throw new StorageConflictError("Routing assessment run binding is reserved for a future operation");
  }
  const createdAt = timestampMillis(value.createdAt, "Routing assessment createdAt");
  const expiresAt = timestampMillis(value.expiresAt, "Routing assessment expiresAt");
  if (expiresAt <= createdAt) throw new StorageConflictError("Routing assessment expiry must be after creation");
  let contextSerialized: string;
  try { contextSerialized = JSON.stringify(value.contextSources); } catch { throw new StorageConflictError("Routing context sources must be JSON serializable"); }
  if (contextSerialized.length > 12_288) throw new StorageConflictError("Routing context sources exceed 12288 bytes");
  let decisionMetadataSerialized: string;
  try {
    decisionMetadataSerialized = JSON.stringify({
      assessmentId: value.id, projectId: value.projectId, taskId: value.taskId,
      requestHash: value.requestHash, contextDigest: value.contextDigest,
      contextSources: value.contextSources, dimensions: value.dimensions, hardSignals: value.hardSignals,
      preference: value.preference, finalAction: value.finalAction,
      baselineShape: value.baselineShape, selectedShape: value.selectedShape,
      score: value.score, reasons: value.reasons, policyVersion: value.policyVersion,
      executionSupported: value.executionSupported, unsupportedReasons: value.unsupportedReasons,
      status: value.status, runId: value.runId,
    });
  } catch { throw new StorageConflictError("Routing decision metadata must be JSON serializable"); }
  if (decisionMetadataSerialized.length > 16_384) throw new StorageConflictError("Routing decision metadata exceeds 16384 bytes");
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

export function validateComparisonRecord(value: ComparisonRecord): void {
  for (const [field, item] of [["id", value.id], ["projectId", value.projectId], ["taskId", value.taskId]] as const) {
    if (!item || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item)) throw new StorageConflictError(`Comparison ${field} is invalid`);
  }
  if (!value.objective || value.objective.length > 4096 || !sha256Hex.test(value.contractHash)
      || !["running", "complete", "failed"].includes(value.status) || !value.selectionPolicy || value.selectionPolicy.length > 2000) {
    throw new StorageConflictError("Comparison record is outside its reviewed bounds");
  }
  timestampMillis(value.createdAt, "Comparison createdAt");
  if (value.completedAt !== null) timestampMillis(value.completedAt, "Comparison completedAt");
}

export function validateComparisonCandidate(value: ComparisonCandidate, finalizing = false): void {
  if (!value.comparisonId || !value.runId || !value.runtime || !value.workflow
      || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 8
      || !["running", "evidence_ready", "accepted", "rejected", "failed"].includes(value.status)) {
    throw new StorageConflictError("Comparison candidate identity is invalid");
  }
  timestampMillis(value.createdAt, "Comparison candidate createdAt");
  timestampMillis(value.updatedAt, "Comparison candidate updatedAt");
  if (!finalizing && (value.metrics !== null || value.evidenceDigest !== null || value.status !== "running")) {
    throw new StorageConflictError("New comparison candidate must start without a metrics snapshot");
  }
  if (finalizing) {
    if (!value.metrics || !value.evidenceDigest || !sha256Hex.test(value.evidenceDigest) || value.status === "running") {
      throw new StorageConflictError("Final comparison candidate requires evidence-bound metrics");
    }
    const metrics = value.metrics;
    if (!["passed", "failed"].includes(metrics.correctness)
        || !Number.isSafeInteger(metrics.defectsCaught) || metrics.defectsCaught < 0 || metrics.defectsCaught > 1000
        || !Number.isSafeInteger(metrics.inputTokens) || metrics.inputTokens < 0
        || !Number.isSafeInteger(metrics.outputTokens) || metrics.outputTokens < 0
        || !Number.isSafeInteger(metrics.costMicros) || metrics.costMicros < 0
        || !Number.isSafeInteger(metrics.elapsedMs) || metrics.elapsedMs < 0
        || !Number.isSafeInteger(metrics.humanReviewArtifacts) || metrics.humanReviewArtifacts < 0
        || !Number.isSafeInteger(metrics.eventCount) || metrics.eventCount < 0
        || !["not_exercised", "recovered", "failed"].includes(metrics.recoveryReliability)
        || !["none", "control_plane_only", "native"].includes(metrics.resumability)
        || !Number.isSafeInteger(metrics.integrationComplexity) || metrics.integrationComplexity < 1 || metrics.integrationComplexity > 10) {
      throw new StorageConflictError("Comparison metrics are outside their reviewed bounds");
    }
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
