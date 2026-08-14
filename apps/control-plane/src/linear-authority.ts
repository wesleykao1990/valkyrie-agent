import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

/** The only production Linear origin this boundary may contact. */
export const LINEAR_GRAPHQL_ORIGIN = "https://api.linear.app/graphql";
export const LINEAR_MAX_RESPONSE_BYTES = 256 * 1024;
export const LINEAR_MAX_TITLE_BYTES = 4 * 1024;
export const LINEAR_MAX_DESCRIPTION_BYTES = 16 * 1024;
export const LINEAR_MAX_COMMENT_BYTES = 8 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type LinearAuthorityErrorCode =
  | "LINEAR_CONNECTOR_DISABLED"
  | "LINEAR_POLICY_INVALID"
  | "LINEAR_TRANSPORT_ERROR"
  | "LINEAR_TIMEOUT"
  | "LINEAR_HTTP_ERROR"
  | "LINEAR_RESPONSE_TOO_LARGE"
  | "LINEAR_RESPONSE_MALFORMED"
  | "LINEAR_GRAPHQL_ERROR"
  | "LINEAR_NOT_FOUND"
  | "LINEAR_SCHEMA_INVALID"
  | "LINEAR_OWNERSHIP_MISMATCH"
  | "LINEAR_IDEMPOTENCY_CONFLICT"
  | "LINEAR_AMBIGUOUS_RESULT"
  | "LINEAR_RECONCILIATION_FAILED";

/**
 * Provider errors deliberately contain only a stable code and a bounded safe
 * explanation.  A Linear response body, request, URL, or credential is never
 * copied into one of these errors.
 */
export class LinearAuthorityError extends Error {
  readonly code: LinearAuthorityErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(
    code: LinearAuthorityErrorCode,
    message: string,
    options: { retryable?: boolean; ambiguous?: boolean } = {},
  ) {
    super(message);
    this.name = "LinearAuthorityError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? (code === "LINEAR_TIMEOUT" || code === "LINEAR_AMBIGUOUS_RESULT");
  }
}

export interface LinearAuthorityPolicy {
  readonly teamId: string;
  readonly projectId: string;
}

export interface LinearAuthorityGatewayOptions {
  /** The accepted project/team policy.  The flattened aliases are supported for adapters. */
  readonly policy?: LinearAuthorityPolicy;
  readonly teamId?: string;
  readonly projectId?: string;
  /** An injected transport is intended for deterministic fakes and tests. */
  readonly transport?: LinearTransport | LinearTransportFunction;
  readonly now?: () => Date;
  readonly maxResponseBytes?: number;
}

export interface LinearTransportRequest {
  readonly method: "POST";
  readonly url: typeof LINEAR_GRAPHQL_ORIGIN;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface LinearTransportResponse {
  readonly status: number;
  /** A fake may supply parsed JSON; a live transport supplies UTF-8 bytes. */
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LinearTransport {
  request(input: LinearTransportRequest): Promise<LinearTransportResponse>;
}

export type LinearTransportFunction =
  (input: LinearTransportRequest) => Promise<LinearTransportResponse>;

export interface LinearProjectView {
  readonly id: string;
  readonly identifier?: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly team: {
    readonly id: string;
    readonly key?: string;
    readonly name?: string;
  };
}

export interface LinearIssueView {
  readonly id: string;
  readonly identifier?: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: number;
  readonly state?: {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
  };
  readonly team: {
    readonly id: string;
    readonly key?: string;
    readonly name?: string;
  };
  readonly project: {
    readonly id: string;
    readonly identifier?: string;
    readonly name?: string;
  };
  readonly updatedAt: string;
}

export interface LinearAuthoritySnapshot<T extends LinearProjectView | LinearIssueView> {
  readonly provider: "linear";
  readonly kind: "project" | "issue";
  readonly providerId: string;
  readonly externalId: string;
  readonly revision: string;
  readonly updatedAt: string;
  readonly observedAt: string;
  readonly payloadHash: string;
  readonly payload: T;
}

export interface LinearIssueCreateInput {
  readonly actionId: string;
  readonly title: string;
  readonly description?: string;
}

export interface LinearEvidenceCommentInput {
  readonly actionId: string;
  readonly issueId: string;
  readonly body: string;
}

export interface LinearMutationReceipt {
  readonly provider: "linear";
  readonly kind: "issue" | "comment";
  readonly actionId: string;
  readonly stableId: string;
  readonly stableMarker: string;
  readonly externalId: string;
  readonly externalRevision: string;
  readonly observedAt: string;
  readonly payloadHash: string;
  readonly requestHash: string;
  readonly replayed: boolean;
  readonly reconciled: boolean;
  readonly payload: LinearIssueView | LinearCommentView;
}

export interface LinearCommentView {
  readonly id: string;
  readonly body: string;
  readonly issueId: string;
  readonly updatedAt: string;
}

interface LinearGraphQLResponse {
  readonly data?: unknown;
  readonly errors?: unknown;
}

interface LinearMutationRecord {
  readonly requestHash: string;
  readonly receipt: LinearMutationReceipt;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON used for all provider payload and request hashes. */
export function linearCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(linearCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${linearCanonicalJson(item)}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

function safeString(value: unknown, field: string, maximum: number, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value !== value.trim() || controls.test(value) || value.includes("\r")) {
    throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", `Linear ${field} is invalid`);
  }
  return value;
}

function boundedUtf8(value: string, field: string, maximum: number, multiline = false): string {
  safeString(value, field, maximum, multiline);
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", `Linear ${field} exceeds its bound`);
  }
  return value;
}

function safeProviderId(value: unknown, field: string): string {
  return safeString(value, field, 256);
}

function isoRevision(value: unknown, field: string): string {
  const text = safeString(value, field, 80);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) {
    throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", `Linear ${field} is not a timestamp`);
  }
  return new Date(millis).toISOString();
}

function observedTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear observation clock is invalid");
  }
  return value.toISOString();
}

function assertPolicy(policy: LinearAuthorityPolicy): LinearAuthorityPolicy {
  const teamId = safeProviderId(policy.teamId, "team ID");
  const projectId = safeProviderId(policy.projectId, "project ID");
  return Object.freeze({ teamId, projectId });
}

function mutationMarker(actionId: string): string {
  if (!SAFE_ID.test(actionId)) {
    throw new LinearAuthorityError("LINEAR_POLICY_INVALID", "Linear action ID is invalid");
  }
  return `<!-- valkyrie-action:${actionId} -->`;
}

/** A deterministic RFC 4122 UUIDv4 derived from the stable action/outbox ID. */
export function linearDeterministicUuid(actionId: string, kind: "issue" | "comment"): string {
  const marker = mutationMarker(actionId);
  const bytes = Buffer.from(sha256(`valkyrie-linear\0${kind}\0${actionId}\0${marker}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", `Linear ${field} is malformed`);
  }
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, field: string, maximum: number, multiline = false): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedUtf8(value as string, field, maximum, multiline);
}

function parseTeam(value: unknown): LinearProjectView["team"] {
  const team = asRecord(value, "team");
  const result: { id: string; key?: string; name?: string } = {
    id: safeProviderId(team.id, "team ID"),
  };
  const key = optionalText(team.key, "team key", 64);
  const name = optionalText(team.name, "team name", 256);
  if (key !== undefined) result.key = key;
  if (name !== undefined) result.name = name;
  return result;
}

function parseProject(value: unknown, expectedTeamId: string): LinearProjectView {
  const project = asRecord(value, "project");
  const teams = asRecord(project.teams, "project teams");
  if (!Array.isArray(teams.nodes) || teams.nodes.length < 1 || teams.nodes.length > 64) {
    throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear project teams are malformed");
  }
  const projectTeams = teams.nodes.map(parseTeam);
  const matchingTeams = projectTeams.filter((team) => team.id === expectedTeamId);
  if (matchingTeams.length !== 1) {
    throw new LinearAuthorityError("LINEAR_OWNERSHIP_MISMATCH", "Linear project is outside the accepted team policy");
  }
  const result: {
    id: string;
    identifier?: string;
    name: string;
    updatedAt: string;
    team: LinearProjectView["team"];
  } = {
    id: safeProviderId(project.id, "project ID"),
    name: boundedUtf8(project.name as string, "project name", 512),
    updatedAt: isoRevision(project.updatedAt, "project updatedAt"),
    team: matchingTeams[0],
  };
  const identifier = optionalText(project.identifier, "project identifier", 128);
  if (identifier !== undefined) result.identifier = identifier;
  return result;
}

function parseIssue(value: unknown): LinearIssueView {
  const issue = asRecord(value, "issue");
  const project = asRecord(issue.project, "issue project");
  const issueProject: { id: string; identifier?: string; name?: string } = {
    id: safeProviderId(project.id, "issue project ID"),
  };
  const result: {
    id: string;
    identifier?: string;
    title: string;
    description?: string;
    priority?: number;
    state?: LinearIssueView["state"];
    team: LinearIssueView["team"];
    project: { id: string; identifier?: string; name?: string };
    updatedAt: string;
  } = {
    id: safeProviderId(issue.id, "issue ID"),
    title: boundedUtf8(issue.title as string, "issue title", LINEAR_MAX_TITLE_BYTES),
    team: parseTeam(issue.team),
    project: issueProject,
    updatedAt: isoRevision(issue.updatedAt, "issue updatedAt"),
  };
  const identifier = optionalText(issue.identifier, "issue identifier", 128);
  const description = optionalText(issue.description, "issue description", LINEAR_MAX_DESCRIPTION_BYTES, true);
  if (identifier !== undefined) result.identifier = identifier;
  if (description !== undefined) result.description = description;
  if (issue.priority !== undefined && issue.priority !== null) {
    if (typeof issue.priority !== "number" || !Number.isSafeInteger(issue.priority) || issue.priority < 0 || issue.priority > 4) {
      throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear issue priority is invalid");
    }
    result.priority = issue.priority;
  }
  if (issue.state !== undefined && issue.state !== null) {
    const state = asRecord(issue.state, "issue state");
    const parsedState: { id: string; name: string; type?: string } = {
      id: safeProviderId(state.id, "issue state ID"),
      name: boundedUtf8(state.name as string, "issue state name", 256),
    };
    const type = optionalText(state.type, "issue state type", 64);
    if (type !== undefined) parsedState.type = type;
    result.state = parsedState;
  }
  const projectIdentifier = optionalText(project.identifier, "issue project identifier", 128);
  const projectName = optionalText(project.name, "issue project name", 512);
  if (projectIdentifier !== undefined) result.project.identifier = projectIdentifier;
  if (projectName !== undefined) result.project.name = projectName;
  return result;
}

function parseComment(value: unknown, fallbackIssueId?: string): LinearCommentView {
  const comment = asRecord(value, "comment");
  const issueValue = comment.issue;
  let issueId = fallbackIssueId;
  if (issueValue !== undefined && issueValue !== null) {
    const issue = asRecord(issueValue, "comment issue");
    issueId = safeProviderId(issue.id, "comment issue ID");
  }
  if (!issueId) throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear comment issue identity is missing");
  return {
    id: safeProviderId(comment.id, "comment ID"),
    body: boundedUtf8(comment.body as string, "comment body", LINEAR_MAX_COMMENT_BYTES, true),
    issueId,
    updatedAt: isoRevision(comment.updatedAt, "comment updatedAt"),
  };
}

function ensureIssueOwnership(issue: LinearIssueView, policy: LinearAuthorityPolicy): void {
  if (issue.team.id !== policy.teamId || issue.project.id !== policy.projectId) {
    throw new LinearAuthorityError("LINEAR_OWNERSHIP_MISMATCH", "Linear issue is outside the accepted team or project");
  }
}

function ensureProjectOwnership(project: LinearProjectView, policy: LinearAuthorityPolicy): void {
  if (project.team.id !== policy.teamId || project.id !== policy.projectId) {
    throw new LinearAuthorityError("LINEAR_OWNERSHIP_MISMATCH", "Linear project is outside the accepted team or project");
  }
}

function responseBytes(body: unknown): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  try {
    return new TextEncoder().encode(JSON.stringify(body));
  } catch {
    throw new LinearAuthorityError("LINEAR_RESPONSE_MALFORMED", "Linear response cannot be encoded");
  }
}

function parseResponseBody(body: unknown, maximum: number): LinearGraphQLResponse {
  const bytes = responseBytes(body);
  if (bytes.byteLength > maximum) {
    throw new LinearAuthorityError("LINEAR_RESPONSE_TOO_LARGE", "Linear response exceeded its byte bound");
  }
  let parsed: unknown = body;
  if (typeof body === "string" || body instanceof Uint8Array) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text);
    } catch {
      throw new LinearAuthorityError("LINEAR_RESPONSE_MALFORMED", "Linear response is not valid UTF-8 JSON");
    }
  }
  const result = asRecord(parsed, "response");
  if (result.errors !== undefined && !Array.isArray(result.errors)) {
    throw new LinearAuthorityError("LINEAR_RESPONSE_MALFORMED", "Linear GraphQL errors field is malformed");
  }
  if (result.errors !== undefined) {
    throw new LinearAuthorityError("LINEAR_GRAPHQL_ERROR", "Linear GraphQL response contained errors", { retryable: false });
  }
  if (result.data === undefined || result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new LinearAuthorityError("LINEAR_RESPONSE_MALFORMED", "Linear GraphQL data is missing");
  }
  return result as LinearGraphQLResponse;
}

function normalizeTransport(transport: LinearTransport | LinearTransportFunction): LinearTransport {
  return typeof transport === "function" ? { request: transport } : transport;
}

function requestHash(value: unknown): string {
  return sha256(linearCanonicalJson(value));
}

function cloneReceipt(receipt: LinearMutationReceipt, replayed: boolean): LinearMutationReceipt {
  return { ...receipt, replayed };
}

const PROJECT_QUERY = `query ValkyrieProject($id: String!) {
  project(id: $id) { id name updatedAt teams { nodes { id key name } } }
}`;
const ISSUE_QUERY = `query ValkyrieIssue($id: String!) {
  issue(id: $id) {
    id identifier title description priority updatedAt
    state { id name type }
    team { id key name }
    project { id identifier name }
  }
}`;
const COMMENT_QUERY = `query ValkyrieComment($id: String!) {
  comment(id: $id) { id body updatedAt issue { id } }
}`;
const ISSUE_MUTATION = `mutation ValkyrieIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id identifier title description priority updatedAt
      state { id name type }
      team { id key name }
      project { id identifier name }
    }
  }
}`;
const COMMENT_MUTATION = `mutation ValkyrieCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body updatedAt issue { id } } }
}`;

/**
 * Bounded Linear authority and mutation gateway.  Constructing this class
 * without an injected transport is inert; production callers must use the
 * explicit `createLiveLinearAuthorityGateway` factory.
 */
export class LinearAuthorityGateway {
  readonly policy: LinearAuthorityPolicy;
  private readonly transport?: LinearTransport;
  private readonly clock: () => Date;
  private readonly maxResponseBytes: number;
  private readonly mutations = new Map<string, LinearMutationRecord>();

  constructor(options: LinearAuthorityGatewayOptions) {
    const policy = options.policy ?? { teamId: options.teamId, projectId: options.projectId } as LinearAuthorityPolicy;
    if (!policy || typeof policy !== "object") {
      throw new LinearAuthorityError("LINEAR_POLICY_INVALID", "Linear authority policy is missing");
    }
    this.policy = assertPolicy(policy);
    this.transport = options.transport ? normalizeTransport(options.transport) : undefined;
    this.clock = options.now ?? (() => new Date());
    this.maxResponseBytes = options.maxResponseBytes ?? LINEAR_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > LINEAR_MAX_RESPONSE_BYTES) {
      throw new LinearAuthorityError("LINEAR_POLICY_INVALID", "Linear response bound is invalid");
    }
  }

  async readProject(projectId = this.policy.projectId): Promise<LinearAuthoritySnapshot<LinearProjectView>> {
    safeProviderId(projectId, "project ID");
    if (projectId !== this.policy.projectId) {
      throw new LinearAuthorityError("LINEAR_OWNERSHIP_MISMATCH", "Linear project is outside the accepted project policy");
    }
    const response = await this.execute(PROJECT_QUERY, { id: projectId }, "ValkyrieProject");
    const data = asRecord(response.data, "data");
    if (data.project === null || data.project === undefined) {
      throw new LinearAuthorityError("LINEAR_NOT_FOUND", "Linear project was not found");
    }
    const project = parseProject(data.project, this.policy.teamId);
    ensureProjectOwnership(project, this.policy);
    return this.snapshot("project", project, project.updatedAt);
  }

  getProject(projectId = this.policy.projectId): Promise<LinearAuthoritySnapshot<LinearProjectView>> {
    return this.readProject(projectId);
  }

  async readIssue(issueId: string): Promise<LinearAuthoritySnapshot<LinearIssueView>> {
    safeProviderId(issueId, "issue ID");
    const response = await this.execute(ISSUE_QUERY, { id: issueId }, "ValkyrieIssue");
    const data = asRecord(response.data, "data");
    if (data.issue === null || data.issue === undefined) {
      throw new LinearAuthorityError("LINEAR_NOT_FOUND", "Linear issue was not found");
    }
    const issue = parseIssue(data.issue);
    ensureIssueOwnership(issue, this.policy);
    return this.snapshot("issue", issue, issue.updatedAt);
  }

  getIssue(issueId: string): Promise<LinearAuthoritySnapshot<LinearIssueView>> {
    return this.readIssue(issueId);
  }

  async createIssue(input: LinearIssueCreateInput): Promise<LinearMutationReceipt> {
    const actionId = validateActionId(input.actionId);
    const marker = mutationMarker(actionId);
    const title = boundedUtf8(input.title, "issue title", LINEAR_MAX_TITLE_BYTES);
    const description = boundedUtf8(`${input.description ?? ""}${input.description ? "\n\n" : ""}${marker}`, "issue description", LINEAR_MAX_DESCRIPTION_BYTES, true);
    const stableId = linearDeterministicUuid(actionId, "issue");
    const request = {
      kind: "issue",
      actionId,
      stableId,
      marker,
      teamId: this.policy.teamId,
      projectId: this.policy.projectId,
      title,
      description,
    };
    return this.mutateIssue(request, stableId, marker);
  }

  async createEvidenceComment(input: LinearEvidenceCommentInput): Promise<LinearMutationReceipt> {
    const actionId = validateActionId(input.actionId);
    const issueId = safeProviderId(input.issueId, "issue ID");
    const marker = mutationMarker(actionId);
    const body = boundedUtf8(`${input.body}\n\n${marker}`, "comment body", LINEAR_MAX_COMMENT_BYTES, true);
    // Read the target immediately before the mutation.  This prevents a
    // caller from using a valid issue ID in another team/project as a write
    // capability.
    await this.readIssue(issueId);
    const stableId = linearDeterministicUuid(actionId, "comment");
    const request = { kind: "comment", actionId, stableId, marker, issueId, body };
    return this.mutateComment(request, stableId, marker, issueId);
  }

  createComment(input: LinearEvidenceCommentInput): Promise<LinearMutationReceipt> {
    return this.createEvidenceComment(input);
  }

  private snapshot<T extends LinearProjectView | LinearIssueView>(kind: "project" | "issue", payload: T, updatedAt: string): LinearAuthoritySnapshot<T> {
    const payloadHash = sha256(linearCanonicalJson(payload));
    const observedAt = observedTimestamp(this.clock);
    return Object.freeze({
      provider: "linear" as const,
      kind,
      providerId: payload.id,
      externalId: payload.id,
      revision: updatedAt,
      updatedAt,
      observedAt,
      payloadHash,
      payload,
    });
  }

  private async mutateIssue(request: Record<string, unknown>, stableId: string, marker: string): Promise<LinearMutationReceipt> {
    const hash = requestHash(request);
    const prior = this.mutations.get(String(request.actionId));
    if (prior) {
      if (prior.requestHash !== hash) throw new LinearAuthorityError("LINEAR_IDEMPOTENCY_CONFLICT", "Linear action ID was reused with different payload");
      return cloneReceipt(prior.receipt, true);
    }
    const variables = {
      input: {
        id: stableId,
        teamId: request.teamId,
        projectId: request.projectId,
        title: request.title,
        description: request.description,
      },
    };
    try {
      const response = await this.execute(ISSUE_MUTATION, variables, "ValkyrieIssueCreate");
      const data = asRecord(response.data, "data");
      const created = asRecord(data.issueCreate, "issueCreate");
      if (created.success !== true || created.issue === null || created.issue === undefined) {
        throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear issue mutation did not return a successful issue");
      }
      const issue = parseIssue(created.issue);
      if (issue.id !== stableId) throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear issue mutation returned an unexpected stable ID");
      ensureIssueOwnership(issue, this.policy);
      if (!(issue.title.includes(marker) || (issue.description ?? "").includes(marker))) {
        throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear issue mutation omitted its stable marker");
      }
      const receipt = this.makeReceipt("issue", String(request.actionId), stableId, marker, issue, hash, false);
      this.mutations.set(String(request.actionId), { requestHash: hash, receipt });
      return receipt;
    } catch (error) {
      if (!isAmbiguous(error)) throw error;
      const receipt = await this.reconcileIssue(String(request.actionId), stableId, marker, hash);
      this.mutations.set(String(request.actionId), { requestHash: hash, receipt });
      return receipt;
    }
  }

  private async mutateComment(request: Record<string, unknown>, stableId: string, marker: string, issueId: string): Promise<LinearMutationReceipt> {
    const hash = requestHash(request);
    const prior = this.mutations.get(String(request.actionId));
    if (prior) {
      if (prior.requestHash !== hash) throw new LinearAuthorityError("LINEAR_IDEMPOTENCY_CONFLICT", "Linear action ID was reused with different payload");
      return cloneReceipt(prior.receipt, true);
    }
    try {
      const response = await this.execute(COMMENT_MUTATION, {
        input: { id: stableId, issueId, body: request.body },
      }, "ValkyrieCommentCreate");
      const data = asRecord(response.data, "data");
      const created = asRecord(data.commentCreate, "commentCreate");
      if (created.success !== true || created.comment === null || created.comment === undefined) {
        throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear comment mutation did not return a successful comment");
      }
      const comment = parseComment(created.comment, issueId);
      if (comment.id !== stableId || comment.issueId !== issueId || !comment.body.includes(marker)) {
        throw new LinearAuthorityError("LINEAR_SCHEMA_INVALID", "Linear comment mutation did not bind its stable ID, issue, and marker");
      }
      const receipt = this.makeReceipt("comment", String(request.actionId), stableId, marker, comment, hash, false);
      this.mutations.set(String(request.actionId), { requestHash: hash, receipt });
      return receipt;
    } catch (error) {
      if (!isAmbiguous(error)) throw error;
      const receipt = await this.reconcileComment(String(request.actionId), stableId, marker, issueId, hash);
      this.mutations.set(String(request.actionId), { requestHash: hash, receipt });
      return receipt;
    }
  }

  private makeReceipt(
    kind: "issue" | "comment",
    actionId: string,
    stableId: string,
    marker: string,
    payload: LinearIssueView | LinearCommentView,
    requestHashValue: string,
    reconciled: boolean,
  ): LinearMutationReceipt {
    const externalRevision = payload.updatedAt;
    return Object.freeze({
      provider: "linear" as const,
      kind,
      actionId,
      stableId,
      stableMarker: marker,
      externalId: payload.id,
      externalRevision,
      observedAt: observedTimestamp(this.clock),
      payloadHash: sha256(linearCanonicalJson(payload)),
      requestHash: requestHashValue,
      replayed: false,
      reconciled,
      payload,
    });
  }

  private async reconcileIssue(actionId: string, stableId: string, marker: string, hash: string): Promise<LinearMutationReceipt> {
    try {
      const response = await this.execute(ISSUE_QUERY, { id: stableId }, "ValkyrieIssue");
      const data = asRecord(response.data, "data");
      if (data.issue === null || data.issue === undefined) throw new LinearAuthorityError("LINEAR_AMBIGUOUS_RESULT", "Linear mutation outcome remains ambiguous", { ambiguous: true });
      const issue = parseIssue(data.issue);
      if (issue.id !== stableId) throw new LinearAuthorityError("LINEAR_AMBIGUOUS_RESULT", "Linear reconciliation returned a different issue", { ambiguous: true });
      ensureIssueOwnership(issue, this.policy);
      if (!(issue.title.includes(marker) || (issue.description ?? "").includes(marker))) {
        throw new LinearAuthorityError("LINEAR_AMBIGUOUS_RESULT", "Linear reconciliation found no exact stable marker", { ambiguous: true });
      }
      return this.makeReceipt("issue", actionId, stableId, marker, issue, hash, true);
    } catch (error) {
      if (error instanceof LinearAuthorityError && error.code === "LINEAR_AMBIGUOUS_RESULT") throw error;
      throw new LinearAuthorityError("LINEAR_RECONCILIATION_FAILED", "Linear mutation reconciliation failed", { ambiguous: true });
    }
  }

  private async reconcileComment(actionId: string, stableId: string, marker: string, issueId: string, hash: string): Promise<LinearMutationReceipt> {
    try {
      const response = await this.execute(COMMENT_QUERY, { id: stableId }, "ValkyrieComment");
      const data = asRecord(response.data, "data");
      if (data.comment === null || data.comment === undefined) throw new LinearAuthorityError("LINEAR_AMBIGUOUS_RESULT", "Linear mutation outcome remains ambiguous", { ambiguous: true });
      const comment = parseComment(data.comment, issueId);
      if (comment.id !== stableId || comment.issueId !== issueId || !comment.body.includes(marker)) {
        throw new LinearAuthorityError("LINEAR_AMBIGUOUS_RESULT", "Linear reconciliation found no exact stable marker", { ambiguous: true });
      }
      // Re-check the issue ownership even though the write path checked it.
      await this.readIssue(issueId);
      return this.makeReceipt("comment", actionId, stableId, marker, comment, hash, true);
    } catch (error) {
      if (error instanceof LinearAuthorityError && error.code === "LINEAR_AMBIGUOUS_RESULT") throw error;
      throw new LinearAuthorityError("LINEAR_RECONCILIATION_FAILED", "Linear mutation reconciliation failed", { ambiguous: true });
    }
  }

  private async execute(query: string, variables: Record<string, unknown>, operationName: string): Promise<LinearGraphQLResponse> {
    if (!this.transport) throw new LinearAuthorityError("LINEAR_CONNECTOR_DISABLED", "Linear connector is disabled");
    const body = JSON.stringify({ query, variables, operationName });
    let response: LinearTransportResponse;
    try {
      response = await this.transport.request({
        method: "POST",
        url: LINEAR_GRAPHQL_ORIGIN,
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
      });
    } catch (error) {
      if (error instanceof LinearAuthorityError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LinearAuthorityError("LINEAR_TIMEOUT", "Linear request timed out", { retryable: true, ambiguous: true });
      }
      throw new LinearAuthorityError("LINEAR_TRANSPORT_ERROR", "Linear request failed", { retryable: true, ambiguous: true });
    }
    if (!response || !Number.isSafeInteger(response.status)) {
      throw new LinearAuthorityError("LINEAR_RESPONSE_MALFORMED", "Linear transport response is malformed");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new LinearAuthorityError("LINEAR_HTTP_ERROR", "Linear request returned an unsuccessful status", { retryable: response.status >= 500 });
    }
    return parseResponseBody(response.body, this.maxResponseBytes);
  }
}

function validateActionId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new LinearAuthorityError("LINEAR_POLICY_INVALID", "Linear action ID is invalid");
  }
  return value;
}

function isAmbiguous(error: unknown): boolean {
  return error instanceof LinearAuthorityError && error.ambiguous;
}

class LiveLinearTransport implements LinearTransport {
  private readonly token: string;
  private readonly authMode: "personal-api-key" | "oauth-bearer";
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    token: string,
    authMode: "personal-api-key" | "oauth-bearer",
    timeoutMs: number,
    maxResponseBytes: number,
  ) {
    this.token = token;
    this.authMode = authMode;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async request(input: LinearTransportRequest): Promise<LinearTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await fetch(LINEAR_GRAPHQL_ORIGIN, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: this.authMode === "personal-api-key" ? this.token : `Bearer ${this.token}`,
        },
        body: input.body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.body) {
        return { status: response.status, body: await response.text() };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > this.maxResponseBytes) {
          controller.abort();
          throw new LinearAuthorityError("LINEAR_RESPONSE_TOO_LARGE", "Linear response exceeded its byte bound");
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      return { status: response.status, body: bytes };
    } catch (error) {
      if (error instanceof LinearAuthorityError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new LinearAuthorityError("LINEAR_TIMEOUT", "Linear request timed out", { retryable: true, ambiguous: true });
      }
      throw new LinearAuthorityError("LINEAR_TRANSPORT_ERROR", "Linear request failed", { retryable: true, ambiguous: true });
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface LiveLinearAuthorityGatewayOptions {
  readonly policy: LinearAuthorityPolicy;
  readonly token: string;
  /** Linear personal API keys use the raw Authorization value; OAuth uses Bearer. */
  readonly authMode: "personal-api-key" | "oauth-bearer";
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly now?: () => Date;
}

/** Explicit opt-in constructor for the fixed-origin live Linear client. */
export function createLiveLinearAuthorityGateway(options: LiveLinearAuthorityGatewayOptions): LinearAuthorityGateway {
  if (typeof options.token !== "string" || options.token.length < 1 || /\s|[\u0000-\u001f\u007f]/u.test(options.token)) {
    throw new LinearAuthorityError("LINEAR_POLICY_INVALID", "Linear credential is invalid");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? LINEAR_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new LinearAuthorityError("LINEAR_POLICY_INVALID", "Linear timeout bound is invalid");
  }
  return new LinearAuthorityGateway({
    policy: options.policy,
    transport: new LiveLinearTransport(options.token, options.authMode, timeoutMs, maxResponseBytes),
    maxResponseBytes,
    now: options.now,
  });
}

export { createLiveLinearAuthorityGateway as createLiveLinearGateway };
export { createLiveLinearAuthorityGateway as createLinearAuthorityGateway };

/**
 * Deterministic in-memory transport used by contract tests.  It implements
 * the narrow GraphQL operations above, has no network behavior, and remembers
 * mutation IDs so changed requests fail closed.
 */
export class FakeLinearTransport implements LinearTransport {
  readonly requests: LinearTransportRequest[] = [];
  readonly projects = new Map<string, Record<string, unknown>>();
  readonly issues = new Map<string, Record<string, unknown>>();
  readonly comments = new Map<string, Record<string, unknown>>();
  private readonly mutationHashes = new Map<string, string>();
  private timeoutNextMutation: "before" | "after" | undefined;

  queueMutationTimeout(mode: "before" | "after"): void {
    this.timeoutNextMutation = mode;
  }

  async request(input: LinearTransportRequest): Promise<LinearTransportResponse> {
    this.requests.push(input);
    const parsed = JSON.parse(input.body) as { operationName?: string; variables?: Record<string, any> };
    const variables = parsed.variables ?? {};
    if (parsed.operationName === "ValkyrieProject") {
      const project = this.projects.get(String(variables.id));
      return { status: 200, body: { data: { project: project ?? null } } };
    }
    if (parsed.operationName === "ValkyrieIssue") {
      const issue = this.issues.get(String(variables.id));
      return { status: 200, body: { data: { issue: issue ?? null } } };
    }
    if (parsed.operationName === "ValkyrieComment") {
      const comment = this.comments.get(String(variables.id));
      return { status: 200, body: { data: { comment: comment ?? null } } };
    }
    if (parsed.operationName === "ValkyrieIssueCreate") {
      const inputValue = variables.input as Record<string, unknown>;
      const stableId = String(inputValue.id);
      const hash = sha256(linearCanonicalJson(inputValue));
      const previous = this.mutationHashes.get(stableId);
      if (previous && previous !== hash) {
        return { status: 200, body: { errors: [{ message: "idempotency conflict" }] } };
      }
      if (this.timeoutNextMutation === "before") {
        this.timeoutNextMutation = undefined;
        throw new LinearAuthorityError("LINEAR_TIMEOUT", "Linear request timed out", { ambiguous: true, retryable: true });
      }
      this.mutationHashes.set(stableId, hash);
      const issue = {
        id: stableId,
        title: String(inputValue.title),
        description: String(inputValue.description),
        updatedAt: "2026-08-13T00:00:00.000Z",
        team: { id: String(inputValue.teamId) },
        project: { id: String(inputValue.projectId) },
      };
      this.issues.set(stableId, issue);
      if (this.timeoutNextMutation === "after") {
        this.timeoutNextMutation = undefined;
        throw new LinearAuthorityError("LINEAR_TIMEOUT", "Linear request timed out", { ambiguous: true, retryable: true });
      }
      return { status: 200, body: { data: { issueCreate: { success: true, issue } } } };
    }
    if (parsed.operationName === "ValkyrieCommentCreate") {
      const inputValue = variables.input as Record<string, unknown>;
      const stableId = String(inputValue.id);
      const hash = sha256(linearCanonicalJson(inputValue));
      const previous = this.mutationHashes.get(stableId);
      if (previous && previous !== hash) return { status: 200, body: { errors: [{ message: "idempotency conflict" }] } };
      if (this.timeoutNextMutation === "before") {
        this.timeoutNextMutation = undefined;
        throw new LinearAuthorityError("LINEAR_TIMEOUT", "Linear request timed out", { ambiguous: true, retryable: true });
      }
      this.mutationHashes.set(stableId, hash);
      const comment = {
        id: stableId,
        body: String(inputValue.body),
        updatedAt: "2026-08-13T00:00:00.000Z",
        issue: { id: String(inputValue.issueId) },
      };
      this.comments.set(stableId, comment);
      if (this.timeoutNextMutation === "after") {
        this.timeoutNextMutation = undefined;
        throw new LinearAuthorityError("LINEAR_TIMEOUT", "Linear request timed out", { ambiguous: true, retryable: true });
      }
      return { status: 200, body: { data: { commentCreate: { success: true, comment } } } };
    }
    return { status: 400, body: { data: null } };
  }
}

export { FakeLinearTransport as FakeLinearAuthorityGateway };
