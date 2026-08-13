import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const GITHUB_REST_ORIGIN = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_MAX_RESPONSE_BYTES = 256 * 1024;
export const GITHUB_MAX_TITLE_BYTES = 4 * 1024;
export const GITHUB_MAX_BODY_BYTES = 32 * 1024;
export const GITHUB_MAX_PULLS = 100;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u;
const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,254}$/u;
const FORBIDDEN_REF = /(?:\.\.|\.lock$|[~^:?*\[\\\s])/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type GithubDraftPrErrorCode =
  | "GITHUB_CONNECTOR_DISABLED"
  | "GITHUB_POLICY_INVALID"
  | "GITHUB_TRANSPORT_ERROR"
  | "GITHUB_TIMEOUT"
  | "GITHUB_HTTP_ERROR"
  | "GITHUB_RESPONSE_TOO_LARGE"
  | "GITHUB_RESPONSE_MALFORMED"
  | "GITHUB_REF_NOT_FOUND"
  | "GITHUB_REF_DRIFT"
  | "GITHUB_SCHEMA_INVALID"
  | "GITHUB_IDEMPOTENCY_CONFLICT"
  | "GITHUB_AMBIGUOUS_RESULT"
  | "GITHUB_OPERATOR_REVIEW"
  | "GITHUB_RECONCILIATION_FAILED";

export class GithubDraftPrError extends Error {
  readonly code: GithubDraftPrErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(
    code: GithubDraftPrErrorCode,
    message: string,
    options: { retryable?: boolean; ambiguous?: boolean } = {},
  ) {
    super(message);
    this.name = "GithubDraftPrError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? (code === "GITHUB_TIMEOUT" || code === "GITHUB_AMBIGUOUS_RESULT");
  }
}

export interface GithubDraftPrPolicyInput {
  readonly owner: string;
  readonly repo: string;
  readonly baseRef: string;
  readonly headRef: string;
  /** Approved remote OIDs. A draft PR cannot be created without both. */
  readonly baseOid?: string;
  readonly headOid?: string;
  readonly approvedBaseOid?: string;
  readonly approvedHeadOid?: string;
  readonly policyVersion?: string;
}

export interface GithubDraftPrPolicy {
  readonly owner: string;
  readonly repo: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly approvedBaseOid?: string;
  readonly approvedHeadOid?: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
}

export interface GithubTransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface GithubTransportResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GithubTransport {
  request(input: GithubTransportRequest): Promise<GithubTransportResponse>;
}

export type GithubTransportFunction =
  (input: GithubTransportRequest) => Promise<GithubTransportResponse>;

export interface GithubRefSnapshot {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly repositoryIdentity: string;
  readonly baseRef: string;
  readonly baseOid: string;
  readonly headRef: string;
  readonly headOid: string;
  readonly observedAt: string;
}

export interface GithubDraftPrInput {
  readonly actionId: string;
  readonly title: string;
  readonly body: string;
}

export interface GithubPullRequestView {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly htmlUrl?: string;
  readonly base: {
    readonly ref: string;
    readonly sha: string;
  };
  readonly head: {
    readonly ref: string;
    readonly sha: string;
  };
  readonly updatedAt: string;
}

export interface GithubDraftPrReceipt {
  readonly provider: "github";
  readonly kind: "draft-pull-request";
  readonly actionId: string;
  readonly stableMarker: string;
  readonly externalId: string;
  readonly number: number;
  readonly owner: string;
  readonly repo: string;
  readonly baseRef: string;
  readonly baseOid: string;
  readonly headRef: string;
  readonly headOid: string;
  readonly title: string;
  readonly bodyHash: string;
  readonly payloadHash: string;
  readonly externalRevision: string;
  readonly observedAt: string;
  readonly requestHash: string;
  readonly draft: true;
  readonly reconciled: boolean;
  readonly replayed: boolean;
  readonly htmlUrl?: string;
}

interface GithubActionRecord {
  readonly requestHash: string;
  readonly receipt: GithubDraftPrReceipt;
}

interface ParsedResponse {
  readonly value: unknown;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function githubCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(githubCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${githubCanonicalJson(item)}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

function safeText(value: unknown, field: string, maximum: number, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value !== value.trim() || controls.test(value) || value.includes("\r")) {
    throw new GithubDraftPrError("GITHUB_POLICY_INVALID", `GitHub ${field} is invalid`);
  }
  return value;
}

function safeOwner(value: unknown): string {
  const result = safeText(value, "owner", 100);
  if (!SAFE_OWNER.test(result)) throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub owner is invalid");
  return result;
}

function safeRepo(value: unknown): string {
  const result = safeText(value, "repository", 100);
  if (!SAFE_REPOSITORY.test(result)) throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub repository is invalid");
  return result;
}

function safeRef(value: unknown, field: string): string {
  const result = safeText(value, field, 256);
  if (result.startsWith("-") || !SAFE_REF.test(result) || FORBIDDEN_REF.test(result)) {
    throw new GithubDraftPrError("GITHUB_POLICY_INVALID", `GitHub ${field} is invalid`);
  }
  return result;
}

function safeOid(value: unknown, field: string): string {
  const result = safeText(value, field, 64).toLowerCase();
  if (!OID.test(result)) throw new GithubDraftPrError("GITHUB_POLICY_INVALID", `GitHub ${field} is invalid`);
  return result;
}

function actionMarker(actionId: string): string {
  const value = safeText(actionId, "action ID", 128);
  if (!SAFE_ID.test(value)) throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub action ID is invalid");
  return `<!-- valkyrie-action:${value} -->`;
}

function repositoryIdentity(owner: string, repo: string): string {
  return `github.com/${owner}/${repo}`;
}

export function createGithubDraftPrPolicy(input: GithubDraftPrPolicyInput): GithubDraftPrPolicy {
  const owner = safeOwner(input.owner);
  const repo = safeRepo(input.repo);
  const baseRef = safeRef(input.baseRef, "base ref");
  const headRef = safeRef(input.headRef, "head ref");
  const approvedBaseOid = input.approvedBaseOid ?? input.baseOid;
  const approvedHeadOid = input.approvedHeadOid ?? input.headOid;
  const normalizedBaseOid = approvedBaseOid === undefined ? undefined : safeOid(approvedBaseOid, "approved base OID");
  const normalizedHeadOid = approvedHeadOid === undefined ? undefined : safeOid(approvedHeadOid, "approved head OID");
  const policyVersion = safeText(input.policyVersion ?? "github-draft-pr-v1", "policy version", 128);
  const policyDigest = sha256(githubCanonicalJson({
    schemaVersion: 1,
    owner,
    repo,
    baseRef,
    headRef,
    approvedBaseOid: normalizedBaseOid,
    approvedHeadOid: normalizedHeadOid,
    policyVersion,
  }));
  return Object.freeze({
    owner,
    repo,
    baseRef,
    headRef,
    approvedBaseOid: normalizedBaseOid,
    approvedHeadOid: normalizedHeadOid,
    policyVersion,
    policyDigest,
  });
}

function normalizeTransport(transport: GithubTransport | GithubTransportFunction): GithubTransport {
  return typeof transport === "function" ? { request: transport } : transport;
}

function responseBytes(body: unknown): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  try { return new TextEncoder().encode(JSON.stringify(body)); }
  catch { throw new GithubDraftPrError("GITHUB_RESPONSE_MALFORMED", "GitHub response cannot be encoded"); }
}

function parseResponse(body: unknown, maximum: number): ParsedResponse {
  const bytes = responseBytes(body);
  if (bytes.byteLength > maximum) throw new GithubDraftPrError("GITHUB_RESPONSE_TOO_LARGE", "GitHub response exceeded its byte bound");
  if (typeof body === "string" || body instanceof Uint8Array) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { value: JSON.parse(text) };
    } catch {
      throw new GithubDraftPrError("GITHUB_RESPONSE_MALFORMED", "GitHub response is not valid UTF-8 JSON");
    }
  }
  return { value: body };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", `GitHub ${field} is malformed`);
  }
  return value as Record<string, unknown>;
}

function boundedUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = safeText(value, "pull request URL", 2_048);
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password) {
      throw new Error();
    }
  } catch {
    throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub pull request URL is invalid");
  }
  return text;
}

function parseRefResponse(value: unknown, policy: GithubDraftPrPolicy, field: "base" | "head"): string {
  const root = record(value, `${field} ref`);
  const object = record(root.object, `${field} ref object`);
  const sha = safeOid(object.sha, `${field} ref OID`);
  const ref = safeText(root.ref, `${field} ref name`, 512);
  const expected = field === "base" ? `refs/heads/${policy.baseRef}` : `refs/heads/${policy.headRef}`;
  if (ref !== expected) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", `GitHub ${field} ref identity is unexpected`);
  return sha;
}

function parsePull(value: unknown, requireDraft = true): GithubPullRequestView {
  const root = record(value, "pull request");
  if (typeof root.id !== "number" || !Number.isSafeInteger(root.id) || root.id < 1
      || typeof root.number !== "number" || !Number.isSafeInteger(root.number) || root.number < 1) {
    throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub pull request identity is invalid");
  }
  const title = safeText(root.title, "pull request title", GITHUB_MAX_TITLE_BYTES);
  const body = root.body === null ? "" : safeText(root.body, "pull request body", GITHUB_MAX_BODY_BYTES, true);
  if (requireDraft && (root.draft !== true || root.state !== "open")) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub response is not an open draft pull request");
  if (root.draft !== true && root.draft !== false) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub pull request draft state is invalid");
  if (root.state !== "open" && root.state !== "closed") throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub pull request state is invalid");
  const baseRoot = record(root.base, "pull request base");
  const headRoot = record(root.head, "pull request head");
  const base = {
    ref: safeRef(baseRoot.ref, "pull request base ref"),
    sha: safeOid(baseRoot.sha, "pull request base OID"),
  };
  const head = {
    ref: safeRef(headRoot.ref, "pull request head ref"),
    sha: safeOid(headRoot.sha, "pull request head OID"),
  };
  const updatedAt = safeText(root.updated_at, "pull request updated_at", 80);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub pull request updated_at is invalid");
  const htmlUrl = boundedUrl(root.html_url);
  return Object.freeze({
    id: root.id,
    number: root.number,
    title,
    body,
    draft: root.draft,
    state: root.state,
    base,
    head,
    updatedAt: new Date(Date.parse(updatedAt)).toISOString(),
    ...(htmlUrl ? { htmlUrl } : {}),
  });
}

function requestHash(value: unknown): string {
  return sha256(githubCanonicalJson(value));
}

function markerInBody(body: string, marker: string): boolean {
  return body.includes(marker);
}

function encodeRef(ref: string): string {
  return ref.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function assertResponseStatus(response: GithubTransportResponse): void {
  if (!response || !Number.isSafeInteger(response.status)) throw new GithubDraftPrError("GITHUB_RESPONSE_MALFORMED", "GitHub transport response is malformed");
}

class LiveGithubTransport implements GithubTransport {
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(token: string, timeoutMs: number, maxResponseBytes: number) {
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async request(input: GithubTransportRequest): Promise<GithubTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          authorization: `Bearer ${this.token}`,
        },
        body: input.body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.body) return { status: response.status, body: await response.text() };
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > this.maxResponseBytes) {
          controller.abort();
          throw new GithubDraftPrError("GITHUB_RESPONSE_TOO_LARGE", "GitHub response exceeded its byte bound");
        }
        chunks.push(chunk);
      }
      return { status: response.status, body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) };
    } catch (error) {
      if (error instanceof GithubDraftPrError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new GithubDraftPrError("GITHUB_TIMEOUT", "GitHub request timed out", { retryable: true, ambiguous: true });
      }
      throw new GithubDraftPrError("GITHUB_TRANSPORT_ERROR", "GitHub request failed", { retryable: true, ambiguous: true });
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface LiveGithubDraftPrGatewayOptions {
  readonly policy: GithubDraftPrPolicy;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly now?: () => Date;
}

/** Explicit opt-in fixed-origin live GitHub client. */
export function createLiveGithubDraftPrGateway(options: LiveGithubDraftPrGatewayOptions): GithubDraftPrGateway {
  if (typeof options.token !== "string" || options.token.length < 1 || /\s|[\u0000-\u001f\u007f]/u.test(options.token)) {
    throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub credential is invalid");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? GITHUB_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub timeout bound is invalid");
  }
  return new GithubDraftPrGateway({
    policy: options.policy,
    transport: new LiveGithubTransport(options.token, timeoutMs, maxResponseBytes),
    maxResponseBytes,
    now: options.now,
  });
}

export class GithubDraftPrGateway {
  readonly policy: GithubDraftPrPolicy;
  private readonly transport?: GithubTransport;
  private readonly maxResponseBytes: number;
  private readonly clock: () => Date;
  private readonly actions = new Map<string, GithubActionRecord>();

  constructor(options: {
    readonly policy: GithubDraftPrPolicy;
    readonly transport?: GithubTransport | GithubTransportFunction;
    readonly maxResponseBytes?: number;
    readonly now?: () => Date;
  }) {
    if (!options || !options.policy) throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub draft PR policy is required");
    this.policy = options.policy;
    this.transport = options.transport ? normalizeTransport(options.transport) : undefined;
    this.maxResponseBytes = options.maxResponseBytes ?? GITHUB_MAX_RESPONSE_BYTES;
    this.clock = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > GITHUB_MAX_RESPONSE_BYTES) {
      throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub response bound is invalid");
    }
  }

  async inspectRefs(): Promise<GithubRefSnapshot> {
    const baseOid = parseRefResponse(await this.execute("GET", this.refPath(this.policy.baseRef)), this.policy, "base");
    const headOid = parseRefResponse(await this.execute("GET", this.refPath(this.policy.headRef)), this.policy, "head");
    const observed = this.clock();
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub observation clock is invalid");
    return Object.freeze({
      provider: "github" as const,
      owner: this.policy.owner,
      repo: this.policy.repo,
      repositoryIdentity: repositoryIdentity(this.policy.owner, this.policy.repo),
      baseRef: this.policy.baseRef,
      baseOid,
      headRef: this.policy.headRef,
      headOid,
      observedAt: observed.toISOString(),
    });
  }

  readRefs(): Promise<GithubRefSnapshot> { return this.inspectRefs(); }

  async createDraftPullRequest(input: GithubDraftPrInput): Promise<GithubDraftPrReceipt> {
    const actionId = safeText(input.actionId, "action ID", 128);
    const marker = actionMarker(actionId);
    const title = safeText(input.title, "pull request title", GITHUB_MAX_TITLE_BYTES);
    const body = safeText(`${input.body}\n\n${marker}`, "pull request body", GITHUB_MAX_BODY_BYTES, true);
    const request = {
      actionId,
      marker,
      owner: this.policy.owner,
      repo: this.policy.repo,
      baseRef: this.policy.baseRef,
      headRef: this.policy.headRef,
      approvedBaseOid: this.policy.approvedBaseOid,
      approvedHeadOid: this.policy.approvedHeadOid,
      title,
      body,
      draft: true,
    };
    const hash = requestHash(request);
    const prior = this.actions.get(actionId);
    if (prior) {
      if (prior.requestHash !== hash) throw new GithubDraftPrError("GITHUB_IDEMPOTENCY_CONFLICT", "GitHub action ID was reused with different payload");
      return { ...prior.receipt, replayed: true };
    }
    if (!this.policy.approvedBaseOid || !this.policy.approvedHeadOid) {
      throw new GithubDraftPrError("GITHUB_POLICY_INVALID", "GitHub draft PR requires approved base and head OIDs");
    }
    const refs = await this.inspectRefs();
    if (refs.baseOid !== this.policy.approvedBaseOid || refs.headOid !== this.policy.approvedHeadOid) {
      throw new GithubDraftPrError("GITHUB_REF_DRIFT", "GitHub base or head ref changed from the approved OIDs");
    }
    const existing = await this.findMarkedPulls(marker, refs);
    if (existing.length > 1) {
      throw new GithubDraftPrError("GITHUB_OPERATOR_REVIEW", "Multiple GitHub draft PRs match the stable action marker");
    }
    if (existing.length === 1) {
      const match = existing[0];
      if (match.title !== title || sha256(match.body) !== sha256(body)) {
        throw new GithubDraftPrError("GITHUB_IDEMPOTENCY_CONFLICT", "GitHub stable marker already has a different payload");
      }
      const receipt = this.makeReceipt(actionId, marker, request, hash, match, true);
      this.actions.set(actionId, { requestHash: hash, receipt });
      return receipt;
    }
    try {
      const response = await this.execute("POST", this.pullPath(), {
        title,
        head: this.policy.headRef,
        base: this.policy.baseRef,
        body,
        draft: true,
      });
      const pull = parsePull(response);
      this.assertExactPull(pull, refs, marker);
      const receipt = this.makeReceipt(actionId, marker, request, hash, pull, false);
      this.actions.set(actionId, { requestHash: hash, receipt });
      return receipt;
    } catch (error) {
      if (!(error instanceof GithubDraftPrError) || !error.ambiguous) throw error;
      const receipt = await this.reconcile(actionId, marker, request, hash, refs, title, body);
      this.actions.set(actionId, { requestHash: hash, receipt });
      return receipt;
    }
  }

  createDraftPr(input: GithubDraftPrInput): Promise<GithubDraftPrReceipt> {
    return this.createDraftPullRequest(input);
  }

  private refPath(ref: string): string {
    return `/repos/${encodeURIComponent(this.policy.owner)}/${encodeURIComponent(this.policy.repo)}/git/ref/heads/${encodeRef(ref)}`;
  }

  private pullPath(): string {
    return `/repos/${encodeURIComponent(this.policy.owner)}/${encodeURIComponent(this.policy.repo)}/pulls`;
  }

  private async findMarkedPulls(marker: string, refs: GithubRefSnapshot): Promise<GithubPullRequestView[]> {
    const path = `${this.pullPath()}?state=open&head=${encodeURIComponent(`${this.policy.owner}:${this.policy.headRef}`)}&base=${encodeURIComponent(this.policy.baseRef)}&per_page=${GITHUB_MAX_PULLS}`;
    const value = await this.execute("GET", path);
    if (!Array.isArray(value)) throw new GithubDraftPrError("GITHUB_RESPONSE_MALFORMED", "GitHub pull request list is malformed");
    if (value.length > GITHUB_MAX_PULLS) throw new GithubDraftPrError("GITHUB_RESPONSE_TOO_LARGE", "GitHub pull request list exceeded its bound");
    const pulls = value.map((item) => parsePull(item, false));
    return pulls.filter((pull) => this.matchesExact(pull, marker, refs));
  }

  private matchesExact(pull: GithubPullRequestView, marker: string, refs: GithubRefSnapshot): boolean {
    return pull.draft === true && pull.state === "open"
      && pull.base.ref === refs.baseRef && pull.base.sha === refs.baseOid
      && pull.head.ref === refs.headRef && pull.head.sha === refs.headOid
      && markerInBody(pull.body, marker);
  }

  private assertExactPull(pull: GithubPullRequestView, refs: GithubRefSnapshot, marker: string): void {
    if (!this.matchesExact(pull, marker, refs)) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub create response does not match the approved exact refs and marker");
  }

  private makeReceipt(
    actionId: string,
    marker: string,
    request: Record<string, unknown>,
    hash: string,
    pull: GithubPullRequestView,
    reconciled: boolean,
  ): GithubDraftPrReceipt {
    const observed = this.clock();
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) throw new GithubDraftPrError("GITHUB_SCHEMA_INVALID", "GitHub observation clock is invalid");
    const payloadHash = sha256(githubCanonicalJson(pull));
    return Object.freeze({
      provider: "github" as const,
      kind: "draft-pull-request" as const,
      actionId,
      stableMarker: marker,
      externalId: String(pull.number),
      number: pull.number,
      owner: this.policy.owner,
      repo: this.policy.repo,
      baseRef: pull.base.ref,
      baseOid: pull.base.sha,
      headRef: pull.head.ref,
      headOid: pull.head.sha,
      title: pull.title,
      bodyHash: sha256(pull.body),
      payloadHash,
      externalRevision: pull.updatedAt,
      observedAt: observed.toISOString(),
      requestHash: hash,
      draft: true as const,
      reconciled,
      replayed: false,
      ...(pull.htmlUrl ? { htmlUrl: pull.htmlUrl } : {}),
    });
  }

  private async reconcile(
    actionId: string,
    marker: string,
    request: Record<string, unknown>,
    hash: string,
    refs: GithubRefSnapshot,
    title: string,
    body: string,
  ): Promise<GithubDraftPrReceipt> {
    try {
      const pulls = await this.findMarkedPulls(marker, refs);
      if (pulls.length > 1) throw new GithubDraftPrError("GITHUB_OPERATOR_REVIEW", "Multiple GitHub draft PRs match the stable action marker");
      if (pulls.length === 0) throw new GithubDraftPrError("GITHUB_AMBIGUOUS_RESULT", "GitHub draft PR outcome remains ambiguous", { ambiguous: true });
      const pull = pulls[0];
      if (pull.title !== title || sha256(pull.body) !== sha256(body)) {
        throw new GithubDraftPrError("GITHUB_IDEMPOTENCY_CONFLICT", "GitHub stable marker reconciled to a different payload");
      }
      return this.makeReceipt(actionId, marker, request, hash, pull, true);
    } catch (error) {
      if (error instanceof GithubDraftPrError && (error.code === "GITHUB_AMBIGUOUS_RESULT" || error.code === "GITHUB_OPERATOR_REVIEW" || error.code === "GITHUB_IDEMPOTENCY_CONFLICT")) throw error;
      throw new GithubDraftPrError("GITHUB_RECONCILIATION_FAILED", "GitHub draft PR reconciliation failed", { ambiguous: true });
    }
  }

  private async execute(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    if (!this.transport) throw new GithubDraftPrError("GITHUB_CONNECTOR_DISABLED", "GitHub connector is disabled");
    const url = `${GITHUB_REST_ORIGIN}${path}`;
    let response: GithubTransportResponse;
    try {
      response = await this.transport.request({
        method,
        url,
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof GithubDraftPrError) throw error;
      throw new GithubDraftPrError("GITHUB_TRANSPORT_ERROR", "GitHub request failed", { retryable: true, ambiguous: true });
    }
    assertResponseStatus(response);
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 404 && method === "GET" && path.includes("/git/ref/")) {
        throw new GithubDraftPrError("GITHUB_REF_NOT_FOUND", "GitHub ref was not found");
      }
      throw new GithubDraftPrError("GITHUB_HTTP_ERROR", "GitHub request returned an unsuccessful status", {
        retryable: response.status >= 500,
        ambiguous: response.status >= 500,
      });
    }
    return parseResponse(response.body, this.maxResponseBytes).value;
  }
}

/**
 * Deterministic no-network fake. It models exact remote refs and draft PRs,
 * including after-timeout persistence and changed-action conflicts.
 */
export class FakeGithubTransport implements GithubTransport {
  readonly requests: GithubTransportRequest[] = [];
  readonly refs = new Map<string, string>();
  readonly pulls: GithubPullRequestView[] = [];
  private nextNumber = 1;
  private timeoutNext: "before" | "after" | undefined;
  private readonly actions = new Map<string, string>();

  queueTimeout(mode: "before" | "after"): void {
    this.timeoutNext = mode;
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, safeOid(oid, "fake ref OID"));
  }

  async request(input: GithubTransportRequest): Promise<GithubTransportResponse> {
    this.requests.push(input);
    const url = new URL(input.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (input.method === "GET" && pathParts.includes("heads")) {
      const headsIndex = pathParts.indexOf("heads");
      const ref = pathParts.slice(headsIndex + 1).map((part) => decodeURIComponent(part)).join("/");
      const oid = this.refs.get(ref);
      if (!oid) return { status: 404, body: { message: "Not Found" } };
      return { status: 200, body: { ref: `refs/heads/${ref}`, object: { sha: oid, type: "commit" } } };
    }
    if (input.method === "GET" && pathParts.at(-1) === "pulls") {
      return {
        status: 200,
        body: this.pulls.map((pull) => ({
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          draft: pull.draft,
          state: pull.state,
          base: pull.base,
          head: pull.head,
          updated_at: pull.updatedAt,
          ...(pull.htmlUrl ? { html_url: pull.htmlUrl } : {}),
        })),
      };
    }
    if (input.method === "POST" && pathParts.at(-1) === "pulls") {
      const body = JSON.parse(input.body ?? "{}") as Record<string, unknown>;
      const markerMatch = /<!-- valkyrie-action:([A-Za-z0-9][A-Za-z0-9_.:-]{0,127}) -->/u.exec(String(body.body));
      const actionId = markerMatch?.[1];
      const hash = sha256(githubCanonicalJson(body));
      if (actionId && this.actions.has(actionId) && this.actions.get(actionId) !== hash) {
        return { status: 409, body: { message: "conflict" } };
      }
      if (this.timeoutNext === "before") {
        this.timeoutNext = undefined;
        throw new GithubDraftPrError("GITHUB_TIMEOUT", "GitHub request timed out", { retryable: true, ambiguous: true });
      }
      const baseRef = String(body.base);
      const headRef = String(body.head);
      const baseOid = this.refs.get(baseRef);
      const headOid = this.refs.get(headRef);
      if (!baseOid || !headOid) return { status: 422, body: { message: "ref not found" } };
      const now = "2026-08-13T00:00:00.000Z";
      const pull: GithubPullRequestView = {
        id: this.nextNumber + 1000,
        number: this.nextNumber++,
        title: String(body.title),
        body: String(body.body),
        draft: true,
        state: "open",
        base: { ref: baseRef, sha: baseOid },
        head: { ref: headRef, sha: headOid },
        updatedAt: now,
        htmlUrl: `https://github.com/example/repo/pull/${this.nextNumber - 1}`,
      };
      if (body.draft !== true) return { status: 422, body: { message: "draft required" } };
      this.pulls.push(pull);
      if (actionId) this.actions.set(actionId, hash);
      if (this.timeoutNext === "after") {
        this.timeoutNext = undefined;
        throw new GithubDraftPrError("GITHUB_TIMEOUT", "GitHub request timed out", { retryable: true, ambiguous: true });
      }
      return {
        status: 201,
        body: {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          draft: pull.draft,
          state: pull.state,
          base: pull.base,
          head: pull.head,
          updated_at: pull.updatedAt,
          html_url: pull.htmlUrl,
        },
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  }
}

export {
  GithubDraftPrGateway as GitHubDraftPrGateway,
  GithubDraftPrError as GitHubDraftPrError,
  FakeGithubTransport as FakeGitHubTransport,
  createGithubDraftPrPolicy as createGitHubDraftPrPolicy,
  createLiveGithubDraftPrGateway as createLiveGitHubDraftPrGateway,
};
