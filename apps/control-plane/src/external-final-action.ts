import { createHash } from "node:crypto";
import {
  canonicalJson,
  externalActionTargetHash,
  type ApprovalBinding,
  type BeginExternalActionAttemptInput,
  type ControlPlaneStore,
  type ExternalActionApprovalResult,
  type ExternalActionDeliveryFence,
  type ExternalActionKind,
  type ExternalActionPlan,
  type ExternalActionPlanListInput,
  type ExternalActionPlanRequestResult,
  type ExternalActionProviderReceipt,
  type ExternalActionReconciliationEvidence,
  type ExternalActionProvider,
  type OutboxDelivery,
  type ReconcileExternalActionPlanInput,
} from "./store.ts";
import { MAX_OUTBOX_DELIVERY_LIMIT } from "./store.ts";
import type { Artifact, Approval, Run, RunEvent } from "./types.ts";

/**
 * A deliberately small evidence authority boundary.  A pilot may implement
 * this with a method (for example `validateExternalActionEvidence`) or the
 * coordinator may be given a plain resolver function.  The coordinator does
 * not reach into a pilot's private workflow state.
 */
export interface ExternalActionEvidence {
  readonly runId?: string;
  readonly projectId: string;
  readonly workflow: string;
  readonly status?: "completed";
  readonly run?: Pick<Run, "id" | "projectId" | "workflow" | "status">;
  readonly evidenceDigest: string;
  readonly policyHash: string;
  readonly artifacts: readonly Artifact[];
  /** Optional boundary facts supplied by a writer/evidence authority. */
  readonly workspaceClean?: boolean;
  readonly writerLeaseActive?: boolean;
}

export type EvidenceAuthorityResolver =
  | ((runId: string) => Promise<ExternalActionEvidence> | ExternalActionEvidence)
  | {
      resolve?: (runId: string) => Promise<ExternalActionEvidence> | ExternalActionEvidence;
      validateExternalActionEvidence?: (runId: string) => Promise<ExternalActionEvidence> | ExternalActionEvidence;
      get?: (runId: string) => Promise<ExternalActionEvidence> | ExternalActionEvidence;
    };

export interface ExternalFinalActionProjectPolicy {
  readonly projectId: string;
  /** Exact digest of the accepted connector-policy file. */
  readonly connectorPolicyDigest: string;
  readonly workflow?: string;
  readonly repositoryIdentity?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  /** The one issue permitted for an evidence comment. */
  readonly linearIssueId?: string;
  readonly evidenceIssueId?: string;
  /** External Linear identities when the local project maps to another ID. */
  readonly linearProjectId?: string;
  readonly linearTeamId?: string;
  readonly policyVersion?: string;
}

export type ProjectPolicyResolver =
  | ExternalFinalActionProjectPolicy
  | ((projectId: string) => Promise<ExternalFinalActionProjectPolicy> | ExternalFinalActionProjectPolicy);

export interface ExternalFinalActionCoordinatorOptions {
  readonly store: ControlPlaneStore;
  readonly evidenceAuthority: EvidenceAuthorityResolver;
  readonly projectPolicy?: ProjectPolicyResolver;
  readonly projectPolicyResolver?: ProjectPolicyResolver;
  readonly gitAuthority?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  readonly gitAuthorityResolver?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  readonly githubGateway?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  readonly githubGatewayResolver?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  readonly linearGateway?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  readonly linearGatewayResolver?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  readonly now?: () => Date;
  readonly deliveryConsumerId?: string;
  readonly defaultOwnerId?: string;
  readonly claimTtlMs?: number;
  readonly retryDelayMs?: number;
}

export interface PrepareGithubDraftPrInput {
  readonly runId: string;
  readonly projectId?: string;
  readonly workflow?: string;
  readonly title: string;
  readonly body: string;
  readonly expiresAt?: string;
  /** Stable caller action ID.  Reusing it with changed content conflicts. */
  readonly actionId?: string;
  readonly planId?: string;
  readonly idempotencyKey?: string;
  /** These are accepted only for validation; target values come from policy/gateways. */
  readonly repositoryIdentity?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly baseRef?: string;
  readonly headRef?: string;
}

export interface PrepareLinearEvidenceCommentInput {
  readonly runId: string;
  readonly projectId?: string;
  readonly workflow?: string;
  readonly body: string;
  readonly issueId?: string;
  readonly expiresAt?: string;
  readonly actionId?: string;
  readonly planId?: string;
  readonly idempotencyKey?: string;
}

export interface PrepareLinearIssueInput {
  readonly runId: string;
  readonly projectId?: string;
  readonly workflow?: string;
  readonly title: string;
  readonly description: string;
  readonly expiresAt?: string;
  readonly actionId?: string;
  readonly planId?: string;
  readonly idempotencyKey?: string;
}

export interface PreparedExternalAction extends ExternalActionPlan {
  /** Store-shaped result is also exposed for callers that prefer it. */
  readonly plan: ExternalActionPlan;
  readonly approval: Approval;
  readonly event: RunEvent;
  readonly replayed: boolean;
}

export interface ResolveExternalActionApprovalInput {
  readonly planId: string;
  readonly state: "approved" | "denied" | "changes_requested";
  readonly decision: string;
  readonly resolvedBy: string;
  readonly idempotencyKey?: string;
}

export interface ExpireExternalActionApprovalInput {
  readonly planId: string;
  readonly idempotencyKey?: string;
}

export interface ProcessAuthorizedDeliveryInput {
  readonly consumerId?: string;
  readonly ownerId?: string;
  readonly claimUntil?: string;
  readonly delivery?: ExternalActionDeliveryFence;
}

export interface ReconcileExternalActionInput {
  readonly planId: string;
  readonly operatorId: string;
  readonly outcome?: "zero" | "one" | "multiple";
  readonly matchCount?: number;
  readonly externalId?: string;
  readonly externalRevision?: string;
  readonly payloadHash?: string;
  readonly observedAt?: string;
  readonly evidence?: ExternalActionReconciliationEvidence;
}

export type ExternalFinalActionErrorCode =
  | "EXTERNAL_ACTION_INVALID"
  | "EXTERNAL_ACTION_EVIDENCE_INVALID"
  | "EXTERNAL_ACTION_EVIDENCE_DRIFT"
  | "EXTERNAL_ACTION_POLICY_MISMATCH"
  | "EXTERNAL_ACTION_PREFLIGHT_FAILED"
  | "EXTERNAL_ACTION_GIT_DRIFT"
  | "EXTERNAL_ACTION_REMOTE_DRIFT"
  | "EXTERNAL_ACTION_REMOTE_HEAD_MISSING"
  | "EXTERNAL_ACTION_DELIVERY_INVALID"
  | "EXTERNAL_ACTION_PROVIDER_FAILED"
  | "EXTERNAL_ACTION_AMBIGUOUS"
  | "EXTERNAL_ACTION_RECONCILIATION_REQUIRED";

export class ExternalFinalActionError extends Error {
  readonly code: ExternalFinalActionErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(
    code: ExternalFinalActionErrorCode,
    message: string,
    options: { retryable?: boolean; ambiguous?: boolean } = {},
  ) {
    super(message);
    this.name = "ExternalFinalActionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f\r]*$/u;
const DEFAULT_CONSUMER = "external-final-action";
const DEFAULT_OWNER = "external-final-action-worker";
const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 15_000;
const MAX_CLAIM_TTL_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const MAX_PLAN_BODY_BYTES = 4 * 1024;
const MAX_ARTIFACTS = 256;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function connectorPolicyDigest(policy: ExternalFinalActionProjectPolicy | undefined): string {
  if (!policy) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "An accepted connector policy is required");
  return safeDigest(policy.connectorPolicyDigest, "Connector policy digest");
}

function actionPolicyHash(input: {
  evidencePolicyHash: string;
  connectorPolicyDigest: string;
  provider: ExternalActionProvider;
  kind: ExternalActionKind;
  target: Record<string, unknown>;
}): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    evidencePolicyHash: input.evidencePolicyHash,
    connectorPolicyDigest: input.connectorPolicyDigest,
    provider: input.provider,
    kind: input.kind,
    targetHash: externalActionTargetHash(input.target),
  }));
}

function fail(code: ExternalFinalActionErrorCode, message: string, options: { retryable?: boolean; ambiguous?: boolean } = {}): never {
  throw new ExternalFinalActionError(code, message, options);
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("EXTERNAL_ACTION_INVALID", `${field} is invalid`);
  return value;
}

function safeText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value !== value.trim() || !SAFE_TEXT.test(value)) {
    fail("EXTERNAL_ACTION_INVALID", `${field} is invalid`);
  }
  if (Buffer.byteLength(value, "utf8") > maximum) fail("EXTERNAL_ACTION_INVALID", `${field} exceeds its bound`);
  return value;
}

function safeDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", `${field} is not a SHA-256 digest`);
  return value;
}

function safeOid(value: unknown, field: string): string {
  if (typeof value !== "string" || !OID.test(value)) fail("EXTERNAL_ACTION_PREFLIGHT_FAILED", `${field} is not a Git object ID`);
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("EXTERNAL_ACTION_INVALID", `${field} is malformed`);
  return value as Record<string, unknown>;
}

function getString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail("EXTERNAL_ACTION_INVALID", `${field} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("EXTERNAL_ACTION_INVALID", `${field} is invalid`);
  const result = new Date(Date.parse(value)).toISOString();
  if (result !== value) fail("EXTERNAL_ACTION_INVALID", `${field} must be canonical UTC ISO`);
  return result;
}

function nowIso(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("EXTERNAL_ACTION_INVALID", "Coordinator clock is invalid");
  return value.toISOString();
}

function artifactSummaries(artifacts: readonly Artifact[]): Array<Record<string, string>> {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence artifacts exceed the bound");
  const result = artifacts.map((artifact) => {
    const item = asRecord(artifact, "Evidence artifact");
    const id = safeId(item.id, "Evidence artifact ID");
    const runId = safeId(item.runId, "Evidence artifact run ID");
    const kind = safeText(item.kind, "Evidence artifact kind", 256);
    const uri = safeText(item.uri, "Evidence artifact URI", 2_048);
    const checksum = safeDigest(item.checksum, "Evidence artifact checksum");
    const mediaType = safeText(item.mediaType, "Evidence artifact media type", 256);
    canonicalTimestamp(item.createdAt, "Evidence artifact createdAt");
    return { id, runId, kind, uri, checksum, mediaType };
  });
  result.sort((left, right) => left.kind.localeCompare(right.kind) || left.uri.localeCompare(right.uri) || left.id.localeCompare(right.id));
  return result;
}

function evidenceDigest(artifacts: readonly Artifact[]): string {
  return sha256(canonicalJson(artifactSummaries(artifacts).map(({ id, kind, uri, checksum, mediaType }) => ({ id, kind, uri, checksum, mediaType }))));
}

function markerFor(planId: string): string {
  return `<!-- valkyrie-action:${safeId(planId, "External action plan ID")} -->`;
}

function idFrom(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function method(value: unknown, names: readonly string[]): ((...args: readonly unknown[]) => Promise<unknown>) | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const candidate = record[name];
    if (typeof candidate === "function") return candidate.bind(value) as (...args: readonly unknown[]) => Promise<unknown>;
  }
  return undefined;
}

async function resolveDependency(value: unknown, projectId: string): Promise<unknown> {
  if (typeof value === "function") return await (value as (id: string) => Promise<unknown> | unknown)(projectId);
  return value;
}

async function resolveEvidence(value: EvidenceAuthorityResolver, runId: string): Promise<ExternalActionEvidence> {
  let result: unknown;
  if (typeof value === "function") result = await value(runId);
  else {
    const resolver = method(value, ["resolve", "validateExternalActionEvidence", "get"]);
    if (!resolver) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence authority resolver is unavailable");
    result = await resolver(runId);
  }
  const root = asRecord(result, "Evidence authority result");
  const nestedRun = root.run && typeof root.run === "object" && !Array.isArray(root.run) ? asRecord(root.run, "Evidence run") : undefined;
  const resolvedRunId = getString(root.runId, "Evidence run ID") ?? getString(nestedRun?.id, "Evidence run ID");
  if (resolvedRunId !== runId) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence authority returned a different run");
  const projectId = getString(root.projectId, "Evidence project ID") ?? getString(nestedRun?.projectId, "Evidence project ID");
  const workflow = getString(root.workflow, "Evidence workflow") ?? getString(nestedRun?.workflow, "Evidence workflow");
  if (!projectId || !workflow) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence authority omitted run identity");
  if (nestedRun && (nestedRun.id !== runId || nestedRun.projectId !== projectId || nestedRun.workflow !== workflow)) {
    fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence run identity fields disagree");
  }
  const nestedStatus = nestedRun?.status;
  if (nestedStatus !== undefined && nestedStatus !== "completed") fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence run is not completed");
  if (root.status !== undefined && root.status !== "completed") fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence run is not completed");
  const digest = safeDigest(root.evidenceDigest, "Evidence digest");
  const policyHash = safeDigest(root.policyHash, "Evidence policy hash");
  if (!Array.isArray(root.artifacts)) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence artifacts are missing");
  const artifacts = root.artifacts as Artifact[];
  if (artifacts.some((artifact) => !artifact || artifact.runId !== runId)) {
    fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence artifact belongs to a different run");
  }
  const computed = evidenceDigest(artifacts);
  if (computed !== digest) fail("EXTERNAL_ACTION_EVIDENCE_DRIFT", "Evidence digest does not match the reverified artifacts");
  if (root.workspaceClean !== undefined && root.workspaceClean !== true) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence workspace is not clean");
  if (root.writerLeaseActive === true) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Evidence still has an active writer lease");
  return {
    runId,
    projectId,
    workflow,
    ...(root.status === "completed" || nestedStatus === "completed" ? { status: "completed" as const } : {}),
    ...(nestedRun ? { run: nestedRun as Pick<Run, "id" | "projectId" | "workflow" | "status"> } : {}),
    evidenceDigest: digest,
    policyHash,
    artifacts,
    ...(root.workspaceClean === undefined ? {} : { workspaceClean: root.workspaceClean as boolean }),
    ...(root.writerLeaseActive === undefined ? {} : { writerLeaseActive: root.writerLeaseActive as boolean }),
  };
}

function readPolicy(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const policy = (value as Record<string, unknown>).policy;
  return policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : undefined;
}

function assertPolicyMatches(policy: ExternalFinalActionProjectPolicy | undefined, evidence: ExternalActionEvidence, fields: Record<string, unknown>): void {
  if (!policy) return;
  if (policy.projectId !== evidence.projectId) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Project policy belongs to another project");
  if (policy.workflow !== undefined && policy.workflow !== evidence.workflow) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Project policy workflow does not match evidence");
  for (const [name, expected] of Object.entries(fields)) {
    if (expected !== undefined && policy[name as keyof ExternalFinalActionProjectPolicy] !== undefined
        && policy[name as keyof ExternalFinalActionProjectPolicy] !== expected) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", `Project policy ${name} does not match the fixed gateway policy`);
    }
  }
}

function assertNoTargetOverride(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const field of ["repositoryIdentity", "owner", "repo", "baseRef", "headRef", "baseOid", "headOid"]) {
    if (field in input && !allowed.includes(field)) fail("EXTERNAL_ACTION_POLICY_MISMATCH", `Caller cannot override fixed ${field}`);
  }
}

function providerFailure(error: unknown): { code: string; retryable: boolean; ambiguous: boolean } {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const rawCode = typeof record.code === "string" ? record.code : "PROVIDER_FAILED";
    const code = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(rawCode) ? rawCode : "PROVIDER_FAILED";
    return {
      code,
      retryable: record.retryable === true,
      ambiguous: record.ambiguous === true || rawCode.includes("AMBIGUOUS") || rawCode.includes("TIMEOUT")
        || rawCode.includes("OPERATOR_REVIEW") || rawCode.includes("RECONCILIATION"),
    };
  }
  return { code: "PROVIDER_FAILED", retryable: false, ambiguous: false };
}

function fingerprint(code: string): string {
  return sha256(`external-final-action\0${code}`);
}

function asPrepared(result: ExternalActionPlanRequestResult): PreparedExternalAction {
  return {
    ...result.plan,
    plan: result.plan,
    approval: result.approval,
    event: result.event,
    replayed: result.replayed,
  };
}

function asApprovalResult(result: ExternalActionApprovalResult): ExternalActionApprovalResult & { readonly plan: ExternalActionPlan } {
  return { ...result, plan: result.plan };
}

/**
 * Generic M7 final-action coordinator.  All provider targets come from
 * construction-fixed gateway policies and current authority snapshots; the
 * request only supplies the human-readable title/body or evidence comment.
 */
export class ExternalFinalActionCoordinator {
  private readonly store: ControlPlaneStore;
  private readonly evidenceAuthority: EvidenceAuthorityResolver;
  private readonly projectPolicy?: ProjectPolicyResolver;
  private readonly gitAuthority?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  private readonly githubGateway?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  private readonly linearGateway?: unknown | ((projectId: string) => Promise<unknown> | unknown);
  private readonly clock: () => Date;
  private readonly consumerId: string;
  private readonly defaultOwnerId: string;
  private readonly claimTtlMs: number;
  private readonly retryDelayMs: number;

  constructor(options: ExternalFinalActionCoordinatorOptions) {
    if (!options || !options.store || !options.evidenceAuthority) fail("EXTERNAL_ACTION_INVALID", "Coordinator store and evidence authority are required");
    this.store = options.store;
    this.evidenceAuthority = options.evidenceAuthority;
    this.projectPolicy = options.projectPolicy ?? options.projectPolicyResolver;
    this.gitAuthority = options.gitAuthority ?? options.gitAuthorityResolver;
    this.githubGateway = options.githubGateway ?? options.githubGatewayResolver;
    this.linearGateway = options.linearGateway ?? options.linearGatewayResolver;
    this.clock = options.now ?? (() => new Date());
    this.consumerId = safeId(options.deliveryConsumerId ?? DEFAULT_CONSUMER, "External action delivery consumer ID");
    this.defaultOwnerId = safeId(options.defaultOwnerId ?? DEFAULT_OWNER, "External action worker ID");
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.claimTtlMs) || this.claimTtlMs < 1_000 || this.claimTtlMs > MAX_CLAIM_TTL_MS
        || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > MAX_RETRY_DELAY_MS) {
      fail("EXTERNAL_ACTION_INVALID", "Coordinator timing bounds are invalid");
    }
  }

  async prepareGithubDraftPr(input: PrepareGithubDraftPrInput): Promise<PreparedExternalAction> {
    return this.prepareGithub(input);
  }

  prepareGitHubDraftPr(input: PrepareGithubDraftPrInput): Promise<PreparedExternalAction> {
    return this.prepareGithubDraftPr(input);
  }

  prepareGitHubDraftPullRequest(input: PrepareGithubDraftPrInput): Promise<PreparedExternalAction> {
    return this.prepareGithubDraftPr(input);
  }

  async prepareLinearEvidenceComment(input: PrepareLinearEvidenceCommentInput): Promise<PreparedExternalAction> {
    return this.prepareLinear(input);
  }

  async prepareLinearIssue(input: PrepareLinearIssueInput): Promise<PreparedExternalAction> {
    return this.prepareLinearIssuePlan(input);
  }

  prepareLinearIdea(input: PrepareLinearIssueInput): Promise<PreparedExternalAction> {
    return this.prepareLinearIssue(input);
  }

  prepareLinearComment(input: PrepareLinearEvidenceCommentInput): Promise<PreparedExternalAction> {
    return this.prepareLinearEvidenceComment(input);
  }

  async getPlan(id: string): Promise<ExternalActionPlan | null> {
    return this.store.getExternalActionPlan(safeId(id, "External action plan ID"));
  }

  getExternalActionPlan(id: string): Promise<ExternalActionPlan | null> {
    return this.getPlan(id);
  }

  async listPlans(input: ExternalActionPlanListInput = {}): Promise<ExternalActionPlan[]> {
    return this.store.listExternalActionPlans(input);
  }

  listExternalActionPlans(input: ExternalActionPlanListInput = {}): Promise<ExternalActionPlan[]> {
    return this.listPlans(input);
  }

  async deliveryStatus() {
    const [pending, claimed, delivered, dead] = await Promise.all([
      this.store.listOutboxDeliveries(this.consumerId, "pending", MAX_OUTBOX_DELIVERY_LIMIT),
      this.store.listOutboxDeliveries(this.consumerId, "claimed", MAX_OUTBOX_DELIVERY_LIMIT),
      this.store.listOutboxDeliveries(this.consumerId, "delivered", MAX_OUTBOX_DELIVERY_LIMIT),
      this.store.listOutboxDeliveries(this.consumerId, "dead", MAX_OUTBOX_DELIVERY_LIMIT),
    ]);
    return {
      consumerId: this.consumerId,
      counts: { pending: pending.length, claimed: claimed.length, delivered: delivered.length, dead: dead.length },
    };
  }

  listDeadDeliveries(limit = 100): Promise<OutboxDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTBOX_DELIVERY_LIMIT) {
      fail("EXTERNAL_ACTION_INVALID", `Dead-letter limit must be between 1 and ${MAX_OUTBOX_DELIVERY_LIMIT}`);
    }
    return this.store.listOutboxDeliveries(this.consumerId, "dead", limit);
  }

  async replayDeadDelivery(outboxId: string, operatorId: string): Promise<OutboxDelivery> {
    const delivery = await this.store.getOutboxDelivery(
      safeId(outboxId, "External action outbox ID"),
      this.consumerId,
    );
    if (!delivery || delivery.state !== "dead" || delivery.topic !== "external.action.authorized") {
      fail("EXTERNAL_ACTION_DELIVERY_INVALID", "External action dead letter was not found");
    }
    const payload = asRecord(delivery.payload, "External action dead-letter payload");
    const plan = await this.requirePlan(safeId(payload.planId, "External action plan ID"));
    if (plan.authorizedOutboxId !== delivery.outboxId || plan.state !== "failed") {
      fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "Only a non-ambiguous failed action may be replayed");
    }
    return this.store.replayOutboxDelivery({
      outboxId: delivery.outboxId,
      consumerId: this.consumerId,
      operatorId: safeId(operatorId, "External action replay operator ID"),
    });
  }

  async resolveApproval(input: ResolveExternalActionApprovalInput): Promise<ExternalActionApprovalResult & { readonly plan: ExternalActionPlan }> {
    const plan = await this.requirePlan(input.planId);
    const binding: ApprovalBinding = {
      action: plan.approvalAction,
      exactEffect: plan.exactEffect,
      projectId: plan.projectId,
      workflow: plan.workflow,
      evidenceDigest: plan.evidenceDigest,
      policyHash: plan.policyHash,
      expiresAt: plan.expiresAt,
    };
    const at = nowIso(this.clock);
    const event: Omit<RunEvent, "seq"> = {
      id: idFrom("event_external_approval", `${plan.id}\0${input.state}\0${input.decision}`),
      runId: plan.runId,
      type: `external.action.${input.state}`,
      message: `External action approval ${input.state}`,
      payload: { planId: plan.id, approvalId: plan.approvalId, state: input.state, decision: input.decision },
      createdAt: at,
    };
    const requestHash = sha256(canonicalJson({ planId: plan.id, state: input.state, decision: input.decision, binding }));
    const resolved = await this.store.resolveExternalActionPlanApproval({
      planId: plan.id,
      state: input.state,
      decision: safeText(input.decision, "Approval decision", 2_048),
      resolvedBy: safeId(input.resolvedBy, "Approval resolver ID"),
      expectedBinding: binding,
      event,
      ...(input.idempotencyKey ? { idempotency: { scope: "external-final-action.resolve", key: safeId(input.idempotencyKey, "Approval idempotency key"), requestHash } } : {}),
    });
    return asApprovalResult(resolved);
  }

  resolveExternalActionPlanApproval(input: ResolveExternalActionApprovalInput): Promise<ExternalActionApprovalResult & { readonly plan: ExternalActionPlan }> {
    return this.resolveApproval(input);
  }

  async expireApproval(input: ExpireExternalActionApprovalInput): Promise<ExternalActionApprovalResult & { readonly plan: ExternalActionPlan }> {
    const plan = await this.requirePlan(input.planId);
    const at = nowIso(this.clock);
    const event: Omit<RunEvent, "seq"> = {
      id: idFrom("event_external_expiry", plan.id),
      runId: plan.runId,
      type: "external.action.expired",
      message: "External action approval expired",
      payload: { planId: plan.id, approvalId: plan.approvalId },
      createdAt: at,
    };
    const requestHash = sha256(canonicalJson({ planId: plan.id, expiresAt: plan.expiresAt }));
    const expired = await this.store.expireExternalActionPlanApproval({
      planId: plan.id,
      event,
      ...(input.idempotencyKey ? { idempotency: { scope: "external-final-action.expire", key: safeId(input.idempotencyKey, "Expiry idempotency key"), requestHash } } : {}),
    });
    return asApprovalResult(expired);
  }

  expireExternalActionPlanApproval(input: ExpireExternalActionApprovalInput): Promise<ExternalActionApprovalResult & { readonly plan: ExternalActionPlan }> {
    return this.expireApproval(input);
  }

  /** Claim and process at most one authorized delivery. */
  async processOneAuthorizedDelivery(input: ProcessAuthorizedDeliveryInput = {}): Promise<ExternalActionPlan | null> {
    const consumerId = safeId(input.consumerId ?? this.consumerId, "External action delivery consumer ID");
    const ownerId = safeId(input.ownerId ?? this.defaultOwnerId, "External action delivery owner ID");
    let delivery: ExternalActionDeliveryFence;
    if (input.delivery) {
      delivery = input.delivery;
    } else {
      const at = Date.parse(nowIso(this.clock));
      const claimUntil = input.claimUntil ?? new Date(at + this.claimTtlMs).toISOString();
      const claimed = await this.store.claimOutboxDeliveries({ consumerId, ownerId, claimUntil, topics: ["external.action.authorized"], limit: 1 });
      if (claimed.length === 0) return null;
      const item = claimed[0]!;
      if (!item.claimToken) fail("EXTERNAL_ACTION_DELIVERY_INVALID", "Authorized delivery did not return a claim fence");
      delivery = { outboxId: item.outboxId, consumerId: item.consumerId, ownerId, claimToken: item.claimToken };
    }
    return this.processClaimedDelivery(delivery);
  }

  processAuthorizedDelivery(input: ProcessAuthorizedDeliveryInput = {}): Promise<ExternalActionPlan | null> {
    return this.processOneAuthorizedDelivery(input);
  }

  processOne(input: ProcessAuthorizedDeliveryInput = {}): Promise<ExternalActionPlan | null> {
    return this.processOneAuthorizedDelivery(input);
  }

  async reconcileAmbiguousPlan(input: ReconcileExternalActionInput): Promise<ExternalActionPlan> {
    const plan = await this.requirePlan(input.planId);
    const targetHash = externalActionTargetHash(plan.target);
    let evidence = input.evidence;
    if (!evidence && input.outcome !== undefined) {
      const outcome = input.outcome;
      if (outcome !== "zero" && outcome !== "one" && outcome !== "multiple") fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "Reconciliation outcome is invalid");
      if (outcome === "one" && (!input.externalId || !input.externalRevision || !input.payloadHash)) {
        fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "One-match reconciliation requires complete provider identity");
      }
      evidence = {
        outcome,
        marker: plan.marker,
        targetHash,
        operatorId: input.operatorId,
        observedAt: input.observedAt ?? nowIso(this.clock),
        matchCount: input.matchCount ?? (outcome === "zero" ? 0 : outcome === "one" ? 1 : 2),
        ...(outcome === "one" ? {
          externalId: input.externalId,
          externalRevision: input.externalRevision,
          payloadHash: input.payloadHash,
        } : {}),
      };
    } else if (!evidence) {
      const gateway = await this.gatewayFor(plan);
      const reconcile = method(gateway, ["reconcile", "reconcileExternalAction", "reconcileDraftPullRequest", "reconcileEvidenceComment", "findMatching"]);
      if (!reconcile) fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "Provider reconciliation requires exact operator evidence");
      const found = await reconcile({ plan, marker: plan.marker, targetHash });
      const record = asRecord(found, "Provider reconciliation result");
      const outcome = record.outcome;
      if (outcome !== "zero" && outcome !== "one" && outcome !== "multiple") fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "Provider reconciliation outcome is invalid");
      evidence = {
        outcome,
        marker: plan.marker,
        targetHash,
        operatorId: input.operatorId,
        observedAt: getString(record.observedAt, "Reconciliation observedAt") ?? nowIso(this.clock),
        matchCount: typeof record.matchCount === "number" ? record.matchCount : outcome === "zero" ? 0 : outcome === "one" ? 1 : 2,
        ...(outcome === "one" ? {
          externalId: getString(record.externalId, "Reconciled external ID"),
          externalRevision: getString(record.externalRevision, "Reconciled external revision"),
          payloadHash: getString(record.payloadHash, "Reconciled payload hash"),
        } : {}),
      } as ExternalActionReconciliationEvidence;
    } else {
      if (evidence.operatorId !== input.operatorId) fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "Reconciliation operator identity does not match evidence");
      if (evidence.marker !== plan.marker || evidence.targetHash !== targetHash) fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "Reconciliation evidence is not bound to the plan");
    }
    const normalized: ExternalActionReconciliationEvidence = {
      ...evidence,
      operatorId: input.operatorId,
      marker: plan.marker,
      targetHash,
      observedAt: canonicalTimestamp(evidence.observedAt, "Reconciliation observedAt"),
    };
    if (normalized.outcome === "one") {
      if (!normalized.externalId || !normalized.externalRevision || !normalized.payloadHash || !SHA256.test(normalized.payloadHash)) {
        fail("EXTERNAL_ACTION_RECONCILIATION_REQUIRED", "One-match reconciliation requires complete provider identity");
      }
    }
    return this.store.reconcileExternalActionPlan({
      planId: plan.id,
      deliveryConsumerId: this.consumerId,
      operatorId: safeId(input.operatorId, "Reconciliation operator ID"),
      evidence: normalized,
    });
  }

  reconcile(input: ReconcileExternalActionInput): Promise<ExternalActionPlan> {
    return this.reconcileAmbiguousPlan(input);
  }

  private async prepareGithub(input: PrepareGithubDraftPrInput): Promise<PreparedExternalAction> {
    const runId = safeId(input.runId, "Evidence run ID");
    assertNoTargetOverride(input as unknown as Record<string, unknown>, []);
    const title = safeText(input.title, "GitHub draft PR title", 4_096);
    const body = safeText(input.body, "GitHub draft PR body", MAX_PLAN_BODY_BYTES);
    const evidence = await this.loadEvidence(runId, input.projectId, input.workflow);
    const policy = await this.loadProjectPolicy(evidence.projectId);
    const acceptedConnectorPolicyDigest = connectorPolicyDigest(policy);
    const git = await this.requireDependency(this.gitAuthority, evidence.projectId, "Git authority");
    const github = await this.requireDependency(this.githubGateway, evidence.projectId, "GitHub gateway");
    const preflight = await this.githubPreflight(evidence, policy, git, github);
    return this.requestPlan({
      kind: "github_create_draft_pr",
      provider: "github",
      runId,
      evidence,
      title,
      body,
      expiresAt: input.expiresAt,
      actionId: input.planId ?? input.actionId,
      idempotencyKey: input.idempotencyKey,
      target: {
        repositoryIdentity: preflight.remote.repositoryIdentity,
        owner: preflight.remote.owner,
        repo: preflight.remote.repo,
        baseRef: preflight.remote.baseRef,
        baseOid: preflight.remote.baseOid,
        headRef: preflight.remote.headRef,
        headOid: preflight.remote.headOid,
      },
      spec: {
        title,
        titleHash: sha256(title),
        body,
        bodyHash: sha256(`${body}\n\n${markerFor(this.planId(input.planId ?? input.actionId, runId, "github_create_draft_pr", evidence, acceptedConnectorPolicyDigest))}`),
        marker: markerFor(this.planId(input.planId ?? input.actionId, runId, "github_create_draft_pr", evidence, acceptedConnectorPolicyDigest)),
        evidenceDigest: evidence.evidenceDigest,
        evidencePolicyHash: evidence.policyHash,
        connectorPolicyDigest: acceptedConnectorPolicyDigest,
        gitPolicyDigest: preflight.git.policyDigest,
        artifacts: artifactSummaries(evidence.artifacts),
      },
      gitSnapshot: preflight.git,
      remoteSnapshot: preflight.remote,
      policy,
      connectorPolicyDigest: acceptedConnectorPolicyDigest,
    });
  }

  private async prepareLinear(input: PrepareLinearEvidenceCommentInput): Promise<PreparedExternalAction> {
    const runId = safeId(input.runId, "Evidence run ID");
    const body = safeText(input.body, "Linear evidence comment body", MAX_PLAN_BODY_BYTES);
    const evidence = await this.loadEvidence(runId, input.projectId, input.workflow);
    const policy = await this.loadProjectPolicy(evidence.projectId);
    const acceptedConnectorPolicyDigest = connectorPolicyDigest(policy);
    const gateway = await this.requireDependency(this.linearGateway, evidence.projectId, "Linear gateway");
    const issueId = this.fixedIssueId(input.issueId, policy, gateway);
    await this.linearPreflight(evidence, policy, gateway, issueId);
    const stablePlanId = this.planId(
      input.planId ?? input.actionId,
      runId,
      "linear_evidence_comment",
      evidence,
      acceptedConnectorPolicyDigest,
    );
    const marker = markerFor(stablePlanId);
    return this.requestPlan({
      kind: "linear_evidence_comment",
      provider: "linear",
      runId,
      evidence,
      body,
      expiresAt: input.expiresAt,
      actionId: stablePlanId,
      idempotencyKey: input.idempotencyKey,
      target: { issueId },
      spec: {
        issueId,
        body,
        bodyHash: sha256(`${body}\n\n${markerFor(stablePlanId)}`),
        marker,
        evidenceDigest: evidence.evidenceDigest,
        evidencePolicyHash: evidence.policyHash,
        connectorPolicyDigest: acceptedConnectorPolicyDigest,
        artifacts: artifactSummaries(evidence.artifacts),
      },
      policy,
      connectorPolicyDigest: acceptedConnectorPolicyDigest,
    });
  }

  private async prepareLinearIssuePlan(input: PrepareLinearIssueInput): Promise<PreparedExternalAction> {
    const runId = safeId(input.runId, "Evidence run ID");
    const title = safeText(input.title, "Linear issue title", 4_096);
    const description = safeText(input.description, "Linear issue description", MAX_PLAN_BODY_BYTES);
    const evidence = await this.loadEvidence(runId, input.projectId, input.workflow);
    const policy = await this.loadProjectPolicy(evidence.projectId);
    const acceptedConnectorPolicyDigest = connectorPolicyDigest(policy);
    const gateway = await this.requireDependency(this.linearGateway, evidence.projectId, "Linear gateway");
    const target = await this.linearProjectPreflight(evidence, policy, gateway);
    const stablePlanId = this.planId(
      input.planId ?? input.actionId,
      runId,
      "linear_create_issue",
      evidence,
      acceptedConnectorPolicyDigest,
    );
    return this.requestPlan({
      kind: "linear_create_issue",
      provider: "linear",
      runId,
      evidence,
      title,
      body: description,
      expiresAt: input.expiresAt,
      actionId: stablePlanId,
      idempotencyKey: input.idempotencyKey,
      target,
      spec: {
        title,
        titleHash: sha256(title),
        description,
        descriptionHash: sha256(description),
        marker: markerFor(stablePlanId),
        evidenceDigest: evidence.evidenceDigest,
        evidencePolicyHash: evidence.policyHash,
        connectorPolicyDigest: acceptedConnectorPolicyDigest,
        artifacts: artifactSummaries(evidence.artifacts),
      },
      policy,
      connectorPolicyDigest: acceptedConnectorPolicyDigest,
    });
  }

  private planId(
    explicit: string | undefined,
    runId: string,
    kind: ExternalActionKind,
    evidence: ExternalActionEvidence,
    acceptedConnectorPolicyDigest: string,
  ): string {
    if (explicit !== undefined) return safeId(explicit, "External action plan ID");
    return idFrom(
      "external_action",
      `${runId}\0${kind}\0${evidence.evidenceDigest}\0${evidence.policyHash}\0${acceptedConnectorPolicyDigest}`,
    );
  }

  private async requestPlan(input: {
    kind: ExternalActionKind;
    provider: ExternalActionProvider;
    runId: string;
    evidence: ExternalActionEvidence;
    title?: string;
    body: string;
    expiresAt?: string;
    actionId?: string;
    idempotencyKey?: string;
    target: Record<string, unknown>;
    spec: Record<string, unknown>;
    gitSnapshot?: Record<string, unknown>;
    remoteSnapshot?: Record<string, unknown>;
    policy?: ExternalFinalActionProjectPolicy;
    connectorPolicyDigest: string;
  }): Promise<PreparedExternalAction> {
    const stablePlanId = this.planId(
      input.actionId,
      input.runId,
      input.kind,
      input.evidence,
      input.connectorPolicyDigest,
    );
    const existing = await this.store.getExternalActionPlan(stablePlanId);
    const createdAt = existing?.createdAt ?? nowIso(this.clock);
    const expiresAt = existing?.expiresAt ?? canonicalTimestamp(input.expiresAt ?? new Date(Date.parse(createdAt) + 15 * 60_000).toISOString(), "External action expiresAt");
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail("EXTERNAL_ACTION_INVALID", "External action expiry must be in the future");
    const marker = markerFor(stablePlanId);
    const spec = { ...input.spec, marker };
    const target = input.target;
    const boundPolicyHash = actionPolicyHash({
      evidencePolicyHash: input.evidence.policyHash,
      connectorPolicyDigest: input.connectorPolicyDigest,
      provider: input.provider,
      kind: input.kind,
      target,
    });
    const requestHash = sha256(canonicalJson({
      schemaVersion: 2,
      kind: input.kind,
      provider: input.provider,
      runId: input.runId,
      target,
      spec,
      evidenceDigest: input.evidence.evidenceDigest,
      evidencePolicyHash: input.evidence.policyHash,
      connectorPolicyDigest: input.connectorPolicyDigest,
      boundPolicyHash,
    }));
    const approvalId = existing?.approvalId ?? idFrom("approval_external", stablePlanId);
    const approvalAction = input.kind === "github_create_draft_pr"
      ? "external_action.github_create_draft_pr"
      : input.kind === "linear_create_issue"
        ? "external_action.linear_create_issue"
        : "external_action.linear_evidence_comment";
    const exactEffect = input.kind === "github_create_draft_pr"
      ? `Create exactly one draft pull request in ${String(target.repositoryIdentity)} from ${String(target.headRef)}@${String(target.headOid)} to ${String(target.baseRef)}@${String(target.baseOid)} with the approved title/body; do not publish, merge, deploy, or delete.`
      : input.kind === "linear_create_issue"
        ? `Create exactly one Linear issue in fixed team ${String(target.teamId)} and project ${String(target.projectId)} with the approved title/description; do not create another issue or change roadmap status.`
        : `Create exactly one evidence comment on fixed Linear issue ${String(target.issueId)} containing the approved evidence-bound body; do not create another issue or comment.`;
    const approval: Approval = {
      id: approvalId,
      runId: input.runId,
      action: approvalAction,
      exactEffect,
      state: "pending",
      evidence: [
        `evidenceDigest=${input.evidence.evidenceDigest}`,
        `evidencePolicyHash=${input.evidence.policyHash}`,
        `connectorPolicyDigest=${input.connectorPolicyDigest}`,
        `policyHash=${boundPolicyHash}`,
        `artifactCount=${input.evidence.artifacts.length}`,
      ],
      requestedAt: createdAt,
      projectId: input.evidence.projectId,
      workflow: input.evidence.workflow,
      evidenceDigest: input.evidence.evidenceDigest,
      policyHash: boundPolicyHash,
      expiresAt,
    };
    const plan: ExternalActionPlan = {
      id: stablePlanId,
      runId: input.runId,
      projectId: input.evidence.projectId,
      workflow: input.evidence.workflow,
      kind: input.kind,
      provider: input.provider,
      marker,
      target,
      spec,
      requestHash,
      evidenceDigest: input.evidence.evidenceDigest,
      policyHash: boundPolicyHash,
      approvalId,
      approvalAction,
      exactEffect,
      expiresAt,
      state: "pending_approval",
      attempts: 0,
      providerReceipt: null,
      result: null,
      lastErrorCode: null,
      lastErrorFingerprint: null,
      reconciliation: null,
      authorizedOutboxId: null,
      createdAt,
      updatedAt: createdAt,
    };
    const event: Omit<RunEvent, "seq"> = {
      id: idFrom("event_external_requested", stablePlanId),
      runId: input.runId,
      type: "external.action.requested",
      message: "Evidence-bound external action requested",
      payload: { planId: stablePlanId, projectId: input.evidence.projectId, provider: input.provider, kind: input.kind, marker },
      createdAt,
    };
    const result = await this.store.requestExternalActionPlan({
      plan,
      approval,
      event,
      idempotency: {
        scope: "external-final-action.prepare",
        key: safeId(input.idempotencyKey ?? stablePlanId, "External action preparation idempotency key"),
        requestHash,
      },
    });
    return asPrepared(result);
  }

  private async loadProjectPolicy(projectId: string): Promise<ExternalFinalActionProjectPolicy | undefined> {
    if (!this.projectPolicy) return undefined;
    const result = typeof this.projectPolicy === "function" ? await this.projectPolicy(projectId) : this.projectPolicy;
    const policy = asRecord(result, "Project policy");
    if (policy.projectId !== projectId) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Project policy belongs to another project");
    safeDigest(policy.connectorPolicyDigest, "Connector policy digest");
    return result;
  }

  private async loadEvidence(runId: string, requestedProjectId?: string, requestedWorkflow?: string): Promise<ExternalActionEvidence> {
    const evidence = await resolveEvidence(this.evidenceAuthority, runId);
    if (requestedProjectId !== undefined && requestedProjectId !== evidence.projectId) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Requested project does not match evidence");
    if (requestedWorkflow !== undefined && requestedWorkflow !== evidence.workflow) fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Requested workflow does not match evidence");
    const run = await this.store.getRun(runId);
    if (run) {
      if (run.status !== "completed" || run.projectId !== evidence.projectId || run.workflow !== evidence.workflow) {
        fail("EXTERNAL_ACTION_EVIDENCE_INVALID", "Stored run identity is not completed or does not match evidence");
      }
    }
    return evidence;
  }

  private async requirePlan(planId: string): Promise<ExternalActionPlan> {
    const plan = await this.store.getExternalActionPlan(safeId(planId, "External action plan ID"));
    if (!plan) fail("EXTERNAL_ACTION_INVALID", "External action plan was not found");
    return plan;
  }

  private async requireDependency(value: unknown, projectId: string, field: string): Promise<unknown> {
    const resolved = await resolveDependency(value, projectId);
    if (!resolved) fail("EXTERNAL_ACTION_PREFLIGHT_FAILED", `${field} is unavailable`);
    return resolved;
  }

  private async githubPreflight(
    evidence: ExternalActionEvidence,
    projectPolicy: ExternalFinalActionProjectPolicy | undefined,
    git: unknown,
    github: unknown,
  ): Promise<{ git: Record<string, unknown>; remote: Record<string, unknown> }> {
    try {
      const reader = method(git, ["read", "inspect", "snapshot"]);
      const remoteReader = method(github, ["inspectRefs", "readRefs", "inspect"]);
      if (!reader || !remoteReader) fail("EXTERNAL_ACTION_PREFLIGHT_FAILED", "Git/GitHub authority readers are unavailable");
      const gitResult = asRecord(await reader(), "Git authority snapshot");
      const remoteResult = asRecord(await remoteReader(), "GitHub remote refs");
      if (gitResult.provider !== "git" || gitResult.projectId !== evidence.projectId || gitResult.clean !== true) {
        fail("EXTERNAL_ACTION_GIT_DRIFT", "Local Git authority is not clean or project-bound");
      }
      if (remoteResult.provider !== "github" || typeof remoteResult.repositoryIdentity !== "string"
          || typeof remoteResult.baseRef !== "string" || typeof remoteResult.headRef !== "string"
          || !remoteResult.baseOid || !remoteResult.headOid) {
        fail("EXTERNAL_ACTION_REMOTE_HEAD_MISSING", "GitHub remote refs are incomplete");
      }
      const gitPolicy = readPolicy(git);
      const githubPolicy = readPolicy(github);
      const expectedRepository = typeof gitResult.repositoryIdentity === "string" ? gitResult.repositoryIdentity : undefined;
      const remoteRepository = String(remoteResult.repositoryIdentity);
      if (!expectedRepository || expectedRepository !== remoteRepository || gitResult.remoteUrlIdentity !== remoteRepository) {
        fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Local Git and GitHub repository identities do not match");
      }
      if (gitResult.baseRef !== remoteResult.baseRef || gitResult.headRef !== remoteResult.headRef
          || gitResult.baseCommit !== remoteResult.baseOid || gitResult.headCommit !== remoteResult.headOid) {
        fail("EXTERNAL_ACTION_REMOTE_DRIFT", "Local Git and remote GitHub refs do not match");
      }
      if (gitPolicy) {
        if (gitPolicy.projectId !== evidence.projectId || gitPolicy.repositoryIdentity !== remoteRepository
            || gitPolicy.baseRef !== remoteResult.baseRef || gitPolicy.headRef !== remoteResult.headRef) {
          fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Git authority policy does not match the remote policy");
        }
      }
      if (githubPolicy) {
        if (githubPolicy.owner && githubPolicy.repo && remoteRepository !== `github.com/${String(githubPolicy.owner)}/${String(githubPolicy.repo)}`) {
          fail("EXTERNAL_ACTION_POLICY_MISMATCH", "GitHub gateway repository policy does not match the remote");
        }
        if (githubPolicy.baseRef !== remoteResult.baseRef || githubPolicy.headRef !== remoteResult.headRef
            || githubPolicy.approvedBaseOid !== remoteResult.baseOid || githubPolicy.approvedHeadOid !== remoteResult.headOid) {
          fail("EXTERNAL_ACTION_REMOTE_DRIFT", "GitHub refs differ from the approved gateway OIDs");
        }
      }
      assertPolicyMatches(projectPolicy, evidence, {
        repositoryIdentity: remoteRepository,
        owner: githubPolicy?.owner,
        repo: githubPolicy?.repo,
        baseRef: remoteResult.baseRef,
        headRef: remoteResult.headRef,
      });
      return { git: gitResult, remote: remoteResult };
    } catch (error) {
      if (error instanceof ExternalFinalActionError) throw error;
      const provider = providerFailure(error);
      if (provider.code === "GITHUB_REF_NOT_FOUND" || provider.code === "GIT_REF_NOT_FOUND") {
        fail("EXTERNAL_ACTION_REMOTE_HEAD_MISSING", "An approved Git/GitHub head ref is unavailable");
      }
      fail(provider.ambiguous ? "EXTERNAL_ACTION_REMOTE_DRIFT" : "EXTERNAL_ACTION_PREFLIGHT_FAILED", "Git/GitHub preflight failed", { retryable: provider.retryable, ambiguous: provider.ambiguous });
    }
  }

  private fixedIssueId(inputIssueId: string | undefined, policy: ExternalFinalActionProjectPolicy | undefined, gateway: unknown): string {
    const gatewayPolicy = readPolicy(gateway);
    const fixed = policy?.linearIssueId ?? policy?.evidenceIssueId ?? getString(gatewayPolicy?.issueId, "Linear policy issue ID");
    if (fixed) {
      if (inputIssueId !== undefined && inputIssueId !== fixed) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Caller issue is not the fixed policy issue");
      return safeId(fixed, "Linear evidence issue ID");
    }
    if (!inputIssueId) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear evidence comment requires a fixed issue policy");
    return safeId(inputIssueId, "Linear evidence issue ID");
  }

  private async linearPreflight(evidence: ExternalActionEvidence, policy: ExternalFinalActionProjectPolicy | undefined, gateway: unknown, issueId: string): Promise<void> {
    const gatewayPolicy = readPolicy(gateway);
    const linearProjectId = policy?.linearProjectId ?? getString(gatewayPolicy?.projectId, "Linear gateway project ID");
    const linearTeamId = policy?.linearTeamId ?? getString(gatewayPolicy?.teamId, "Linear gateway team ID");
    if (policy?.linearProjectId !== undefined && gatewayPolicy?.projectId !== undefined && gatewayPolicy.projectId !== policy.linearProjectId) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear gateway project identity does not match the accepted local mapping");
    }
    if (policy?.linearTeamId !== undefined && gatewayPolicy?.teamId !== undefined && gatewayPolicy.teamId !== policy.linearTeamId) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear gateway team identity does not match the accepted local mapping");
    }
    assertPolicyMatches(policy, evidence, {});
    const fixedIssue = this.fixedIssueId(undefined, policy, gateway);
    if (issueId !== fixedIssue) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear issue target changed after approval binding");
    }
    const reader = method(gateway, ["readIssue", "getIssue", "inspectIssue"]);
    if (reader) {
      const snapshot = asRecord(await reader(issueId), "Linear issue snapshot");
      const payload = snapshot.payload && typeof snapshot.payload === "object" ? asRecord(snapshot.payload, "Linear issue payload") : snapshot;
      const project = payload.project && typeof payload.project === "object" ? asRecord(payload.project, "Linear issue project") : undefined;
      const team = payload.team && typeof payload.team === "object" ? asRecord(payload.team, "Linear issue team") : undefined;
      if (linearProjectId === undefined || linearTeamId === undefined || !project || project.id !== linearProjectId || !team || team.id !== linearTeamId) {
        fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear issue is outside the fixed gateway team/project");
      }
    }
  }

  private async linearProjectPreflight(
    evidence: ExternalActionEvidence,
    policy: ExternalFinalActionProjectPolicy | undefined,
    gateway: unknown,
  ): Promise<{ teamId: string; projectId: string }> {
    const gatewayPolicy = readPolicy(gateway);
    const projectId = policy?.linearProjectId ?? getString(gatewayPolicy?.projectId, "Linear gateway project ID");
    const teamId = policy?.linearTeamId ?? getString(gatewayPolicy?.teamId, "Linear gateway team ID");
    if (!projectId || !teamId) fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear issue creation requires fixed team/project policy");
    if (policy?.linearProjectId !== undefined && gatewayPolicy?.projectId !== undefined
        && gatewayPolicy.projectId !== policy.linearProjectId) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear gateway project identity does not match the accepted local mapping");
    }
    if (policy?.linearTeamId !== undefined && gatewayPolicy?.teamId !== undefined
        && gatewayPolicy.teamId !== policy.linearTeamId) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear gateway team identity does not match the accepted local mapping");
    }
    assertPolicyMatches(policy, evidence, {});
    const reader = method(gateway, ["readProject", "getProject", "inspectProject"]);
    if (!reader) fail("EXTERNAL_ACTION_PREFLIGHT_FAILED", "Linear project authority reader is unavailable");
    const snapshot = asRecord(await reader(projectId), "Linear project snapshot");
    const payload = snapshot.payload && typeof snapshot.payload === "object"
      ? asRecord(snapshot.payload, "Linear project payload")
      : snapshot;
    const team = payload.team && typeof payload.team === "object"
      ? asRecord(payload.team, "Linear project team")
      : undefined;
    if (payload.id !== projectId || !team || team.id !== teamId) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear project is outside the fixed team/project mapping");
    }
    return { teamId: safeId(teamId, "Linear team ID"), projectId: safeId(projectId, "Linear project ID") };
  }

  private async gatewayFor(plan: ExternalActionPlan): Promise<unknown> {
    const value = plan.provider === "github" ? this.githubGateway : this.linearGateway;
    return this.requireDependency(value, plan.projectId, `${plan.provider} gateway`);
  }

  private async processClaimedDelivery(delivery: ExternalActionDeliveryFence): Promise<ExternalActionPlan> {
    const outbox = await this.store.getOutboxDelivery(delivery.outboxId, delivery.consumerId);
    if (!outbox || outbox.state !== "claimed" || outbox.claimOwnerId !== delivery.ownerId || outbox.claimToken !== delivery.claimToken
        || outbox.topic !== "external.action.authorized") {
      fail("EXTERNAL_ACTION_DELIVERY_INVALID", "Authorized delivery fence is invalid");
    }
    const payload = asRecord(outbox.payload, "Authorized external action payload");
    const planId = safeId(payload.planId, "Authorized external action plan ID");
    const plan = await this.requirePlan(planId);
    if (payload.provider !== plan.provider || payload.kind !== plan.kind || payload.marker !== plan.marker) {
      fail("EXTERNAL_ACTION_DELIVERY_INVALID", "Authorized delivery does not match its immutable plan");
    }
    const fence: ExternalActionDeliveryFence = { ...delivery, outboxId: outbox.outboxId, consumerId: outbox.consumerId };
    // `executing` with a newly acquired delivery fence means a prior process
    // crossed the durable begin boundary but disappeared before recording a
    // receipt.  Reissuing the provider mutation could duplicate the external
    // effect, so convert it to durable ambiguity without another provider call.
    if (plan.state === "executing") {
      await this.store.failExternalActionAttempt({
        planId: plan.id,
        delivery: fence,
        errorCode: "EXTERNAL_ACTION_RESTART_UNCERTAIN",
        errorFingerprint: fingerprint("EXTERNAL_ACTION_RESTART_UNCERTAIN"),
        ambiguous: true,
      });
      fail("EXTERNAL_ACTION_AMBIGUOUS", "An interrupted external action requires reconciliation before any retry", { ambiguous: true });
    }
    let evidence: ExternalActionEvidence;
    try {
      evidence = await this.loadEvidence(plan.runId, plan.projectId, plan.workflow);
      await this.preflightPlan(plan, evidence);
    } catch (error) {
      await this.failClaimBeforeBegin(fence, error);
      throw error;
    }
    let executing: ExternalActionPlan;
    try {
      executing = await this.store.beginExternalActionAttempt({ planId: plan.id, delivery: fence });
    } catch (error) {
      throw error;
    }
    try {
      // This second complete verification is intentionally adjacent to the
      // provider call; the first check only establishes admission.
      evidence = await this.loadEvidence(executing.runId, executing.projectId, executing.workflow);
      await this.preflightPlan(executing, evidence);
    } catch (error) {
      await this.failExecuting(fence, executing, error, false);
      throw error;
    }
    try {
      const receipt = await this.invokeProvider(executing);
      const storedReceipt = this.toProviderReceipt(executing, receipt);
      return await this.store.completeExternalActionAttempt({
        planId: executing.id,
        delivery: fence,
        providerReceipt: storedReceipt,
        result: this.providerResult(executing, receipt, storedReceipt),
      });
    } catch (error) {
      const details = providerFailure(error);
      const ambiguous = details.ambiguous || (error instanceof ExternalFinalActionError && error.ambiguous);
      await this.failExecuting(fence, executing, error, ambiguous);
      if (ambiguous) fail("EXTERNAL_ACTION_AMBIGUOUS", "External provider outcome is ambiguous; reconciliation is required", { ambiguous: true });
      throw error;
    }
  }

  private async preflightPlan(plan: ExternalActionPlan, evidence: ExternalActionEvidence): Promise<void> {
    const evidencePolicyHash = safeDigest(plan.spec.evidencePolicyHash, "Planned evidence policy hash");
    const plannedConnectorPolicyDigest = safeDigest(
      plan.spec.connectorPolicyDigest,
      "Planned connector policy digest",
    );
    if (evidence.evidenceDigest !== plan.evidenceDigest || evidence.policyHash !== evidencePolicyHash) {
      fail("EXTERNAL_ACTION_EVIDENCE_DRIFT", "Evidence changed after approval binding");
    }
    const summaries = artifactSummaries(evidence.artifacts);
    const expectedArtifacts = plan.spec.artifacts;
    if (canonicalJson(expectedArtifacts) !== canonicalJson(summaries)) fail("EXTERNAL_ACTION_EVIDENCE_DRIFT", "Governed artifacts changed after approval binding");
    const policy = await this.loadProjectPolicy(plan.projectId);
    const currentConnectorPolicyDigest = connectorPolicyDigest(policy);
    if (currentConnectorPolicyDigest !== plannedConnectorPolicyDigest) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Accepted connector policy changed after approval binding");
    }
    const expectedBoundPolicyHash = actionPolicyHash({
      evidencePolicyHash,
      connectorPolicyDigest: currentConnectorPolicyDigest,
      provider: plan.provider,
      kind: plan.kind,
      target: plan.target,
    });
    if (plan.policyHash !== expectedBoundPolicyHash) {
      fail("EXTERNAL_ACTION_POLICY_MISMATCH", "External action policy binding is invalid");
    }
    const gateway = await this.gatewayFor(plan);
    if (plan.provider === "github") {
      const git = await this.requireDependency(this.gitAuthority, plan.projectId, "Git authority");
      const current = await this.githubPreflight(evidence, policy, git, gateway);
      const target = plan.target;
      if (current.remote.repositoryIdentity !== target.repositoryIdentity || current.remote.baseRef !== target.baseRef
          || current.remote.baseOid !== target.baseOid || current.remote.headRef !== target.headRef || current.remote.headOid !== target.headOid) {
        fail("EXTERNAL_ACTION_REMOTE_DRIFT", "GitHub refs changed after approval binding");
      }
      const gitPolicyDigest = plan.spec.gitPolicyDigest;
      if (gitPolicyDigest !== undefined && current.git.policyDigest !== gitPolicyDigest) fail("EXTERNAL_ACTION_GIT_DRIFT", "Git policy changed after approval binding");
    } else if (plan.kind === "linear_evidence_comment") {
      const issueId = safeId(plan.target.issueId, "Linear evidence issue ID");
      await this.linearPreflight(evidence, policy, gateway, issueId);
    } else if (plan.kind === "linear_create_issue") {
      const current = await this.linearProjectPreflight(evidence, policy, gateway);
      if (current.teamId !== plan.target.teamId || current.projectId !== plan.target.projectId) {
        fail("EXTERNAL_ACTION_POLICY_MISMATCH", "Linear issue project target changed after approval binding");
      }
    } else {
      fail("EXTERNAL_ACTION_INVALID", "External action kind is unsupported");
    }
  }

  private async invokeProvider(plan: ExternalActionPlan): Promise<Record<string, unknown>> {
    const gateway = await this.gatewayFor(plan);
    if (plan.provider === "github") {
      const creator = method(gateway, ["createDraftPullRequest", "createDraftPr"]);
      if (!creator) fail("EXTERNAL_ACTION_PROVIDER_FAILED", "GitHub draft PR gateway is unavailable");
      const result = await creator({ actionId: plan.id, title: plan.spec.title, body: plan.spec.body });
      return asRecord(result, "GitHub provider receipt");
    }
    if (plan.kind === "linear_create_issue") {
      const creator = method(gateway, ["createIssue"]);
      if (!creator) fail("EXTERNAL_ACTION_PROVIDER_FAILED", "Linear issue gateway is unavailable");
      const result = await creator({
        actionId: plan.id,
        title: plan.spec.title,
        description: plan.spec.description,
      });
      return asRecord(result, "Linear provider receipt");
    }
    const creator = method(gateway, ["createEvidenceComment", "createComment"]);
    if (!creator) fail("EXTERNAL_ACTION_PROVIDER_FAILED", "Linear evidence-comment gateway is unavailable");
    const result = await creator({ actionId: plan.id, issueId: plan.target.issueId, body: plan.spec.body });
    return asRecord(result, "Linear provider receipt");
  }

  private toProviderReceipt(plan: ExternalActionPlan, receipt: Record<string, unknown>): ExternalActionProviderReceipt {
    const marker = getString(receipt.stableMarker, "Provider stable marker");
    if (marker !== markerFor(plan.id)) fail("EXTERNAL_ACTION_PROVIDER_FAILED", "Provider receipt marker does not match the plan");
    const externalId = getString(receipt.externalId, "Provider external ID");
    const externalRevision = getString(receipt.externalRevision, "Provider external revision");
    const payloadHash = getString(receipt.payloadHash, "Provider payload hash");
    const observedAt = canonicalTimestamp(receipt.observedAt, "Provider observedAt");
    if (!externalId || !externalRevision || !payloadHash || !SHA256.test(payloadHash)) fail("EXTERNAL_ACTION_PROVIDER_FAILED", "Provider receipt identity is invalid");
    return { externalId, externalRevision, payloadHash, observedAt, marker: plan.marker, targetHash: externalActionTargetHash(plan.target) };
  }

  private providerResult(plan: ExternalActionPlan, receipt: Record<string, unknown>, storedReceipt: ExternalActionProviderReceipt): Record<string, unknown> {
    return {
      provider: plan.provider,
      kind: plan.kind,
      externalId: storedReceipt.externalId,
      externalRevision: storedReceipt.externalRevision,
      payloadHash: storedReceipt.payloadHash,
      marker: plan.marker,
      targetHash: storedReceipt.targetHash,
      reconciled: receipt.reconciled === true,
      ...(typeof receipt.number === "number" ? { number: receipt.number } : {}),
      ...(typeof receipt.htmlUrl === "string" ? { htmlUrl: receipt.htmlUrl } : {}),
    };
  }

  private async failClaimBeforeBegin(fence: ExternalActionDeliveryFence, error: unknown): Promise<void> {
    const details = error instanceof ExternalFinalActionError ? { code: error.code, retryable: error.retryable } : providerFailure(error);
    try {
      await this.store.failOutboxDelivery({
        outboxId: fence.outboxId,
        consumerId: fence.consumerId,
        ownerId: fence.ownerId,
        claimToken: fence.claimToken,
        errorCode: details.code,
        errorFingerprint: fingerprint(details.code),
        ...(details.retryable || details.code.includes("DRIFT") ? { nextAttemptAt: new Date(Date.parse(nowIso(this.clock)) + this.retryDelayMs).toISOString() } : {}),
      });
    } catch {
      // Preserve the original preflight failure.  A lost claim is itself
      // durable store evidence and must not trigger a provider call.
    }
  }

  private async failExecuting(fence: ExternalActionDeliveryFence, plan: ExternalActionPlan, error: unknown, ambiguous: boolean): Promise<void> {
    const details = error instanceof ExternalFinalActionError ? { code: error.code, retryable: error.retryable } : providerFailure(error);
    try {
      await this.store.failExternalActionAttempt({
        planId: plan.id,
        delivery: fence,
        errorCode: details.code,
        errorFingerprint: fingerprint(details.code),
        ambiguous,
        ...(!ambiguous && (details.retryable || details.code.includes("DRIFT")) ? { nextAttemptAt: new Date(Date.parse(nowIso(this.clock)) + this.retryDelayMs).toISOString() } : {}),
      });
    } catch {
      // A lost fence after a provider attempt is intentionally not retried.
    }
  }
}

export {
  ExternalFinalActionCoordinator as ExternalFinalActions,
  ExternalFinalActionCoordinator as ExternalFinalActionService,
};

export function createExternalFinalActionCoordinator(options: ExternalFinalActionCoordinatorOptions): ExternalFinalActionCoordinator {
  return new ExternalFinalActionCoordinator(options);
}
