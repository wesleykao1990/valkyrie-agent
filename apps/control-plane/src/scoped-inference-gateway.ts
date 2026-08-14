import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson, StorageConflictError, type ControlPlaneStore, type InferenceCapability, type InferenceRole } from "./store.ts";

const TOKEN = /^vki_[A-Za-z0-9_-]{43}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 64;

export interface ScopedInferencePolicy {
  provider: string;
  model: string;
  roleModels: Record<InferenceRole, string>;
  api: "openai-completions";
  roles: InferenceRole[];
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxElapsedMs: number;
  ttlMs: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
}

export interface IssuedInferenceCapability {
  token: string;
  capability: InferenceCapability;
}

export interface InferenceUpstreamResult {
  status: number;
  contentType: "application/json" | "text/event-stream";
  body: Buffer;
  providerRequestId: string;
  inputTokens: number;
  outputTokens: number;
  /** Bounded native provider records, retained for audit alongside normalized request evidence. */
  nativeRecords?: Record<string, unknown>[];
  /** Stable provider session/thread identity when the reviewed upstream supports retained turns. */
  providerSessionId?: string;
  /** True only when this request resumed the exact previously recorded provider session. */
  providerSessionReused?: boolean;
}

export interface InferenceUpstream {
  complete(input: {
    capabilityId: string;
    requestId: string;
    provider: string;
    model: string;
    role: InferenceRole;
    body: Record<string, unknown>;
    /** Durable audit identity from an earlier completed request in this role, if one exists. */
    priorProviderSessionId?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<InferenceUpstreamResult>;
}

export interface HttpOpenAiInferenceUpstreamOptions {
  baseUrl: string;
  credential?: string;
  authorization: "bearer" | "x-api-key";
  allowCredentialFreeLoopback?: boolean;
  maxResponseBytes?: number;
}

export class ScopedInferenceGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ScopedInferenceGatewayError";
    this.status = status;
    this.code = code;
  }
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ScopedInferenceGatewayError(400, "invalid_request", `${label} is outside its reviewed bound`);
  }
  return value as number;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScopedInferenceGatewayError(400, "invalid_request", "Inference request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function validatePolicy(policy: ScopedInferencePolicy): void {
  if (!SAFE_ID.test(policy.provider) || !SAFE_ID.test(policy.model) || policy.api !== "openai-completions") {
    throw new Error("Scoped inference policy provider/model/API is invalid");
  }
  const roles = new Set(policy.roles);
  if (roles.size !== 4 || !["implementer", "verifier_initial", "repair", "verifier_final"].every((role) => roles.has(role as InferenceRole))) {
    throw new Error("Scoped inference policy must contain each exact pilot role once");
  }
  integer(policy.maxRequests, "maxRequests", 16, 16);
  integer(policy.maxInputTokens, "maxInputTokens", 1, 1_000_000);
  integer(policy.maxOutputTokens, "maxOutputTokens", 1, 131_072);
  integer(policy.maxCostMicros, "maxCostMicros", 0, 100_000_000);
  integer(policy.maxElapsedMs, "maxElapsedMs", 100, 10 * 60_000);
  integer(policy.ttlMs, "ttlMs", 60_000, 30 * 60_000);
  integer(policy.inputCostMicrosPerMillion, "inputCostMicrosPerMillion", 0, 100_000_000);
  integer(policy.outputCostMicrosPerMillion, "outputCostMicrosPerMillion", 0, 100_000_000);
  for (const role of policy.roles) {
    if (!SAFE_ID.test(policy.roleModels[role])) throw new Error(`Scoped inference model alias for ${role} is invalid`);
  }
  if (new Set(Object.values(policy.roleModels)).size !== 4) throw new Error("Scoped inference model aliases must be unique per role");
}

function sanitizeRequest(value: unknown, capability: InferenceCapability, role: InferenceRole, policy: ScopedInferencePolicy): Record<string, unknown> {
  const request = plainObject(value);
  if (!capability.roles.includes(role)) throw new ScopedInferenceGatewayError(403, "role_scope", "Inference role is outside the capability");
  const allowed = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stream", "stream_options", "tools", "tool_choice", "response_format", "reasoning_effort", "stop", "store"]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new ScopedInferenceGatewayError(400, "unsupported_field", `Inference field ${key} is not allowed`);
  }
  if (request.model !== policy.roleModels[role]) throw new ScopedInferenceGatewayError(403, "model_scope", "Requested model does not match the capability role");
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > MAX_MESSAGES) {
    throw new ScopedInferenceGatewayError(400, "message_bound", "Inference messages are outside the reviewed bound");
  }
  const requestedOutput = request.max_completion_tokens ?? request.max_tokens ?? capability.maxOutputTokens;
  const maxTokens = integer(requestedOutput, "max output tokens", 1, capability.maxOutputTokens);
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new ScopedInferenceGatewayError(400, "invalid_stream", "stream must be a boolean");
  }
  if (request.store !== undefined && request.store !== false) {
    throw new ScopedInferenceGatewayError(400, "invalid_store", "store must be false when supplied");
  }
  const normalized: Record<string, unknown> = { ...request, model: capability.model, max_tokens: maxTokens };
  delete normalized.max_completion_tokens;
  if (request.stream === true) normalized.stream_options = { include_usage: true };
  const body = canonicalJson(normalized);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ScopedInferenceGatewayError(413, "request_too_large", "Inference request exceeds its byte bound");
  // A conservative pre-provider guard; authoritative token accounting comes from the provider response.
  if (Math.ceil(body.length / 2) > capability.maxInputTokens) {
    throw new ScopedInferenceGatewayError(413, "input_budget", "Inference request exceeds its conservative input-token bound");
  }
  return normalized;
}

function costMicros(policy: ScopedInferencePolicy, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * policy.inputCostMicrosPerMillion + outputTokens * policy.outputCostMicrosPerMillion) / 1_000_000);
}

function usageFromJson(value: unknown): { inputTokens: number; outputTokens: number; providerRequestId?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, any>;
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  return { inputTokens, outputTokens, providerRequestId: typeof record.id === "string" ? record.id : undefined };
}

function responseUsage(body: Buffer, contentType: "application/json" | "text/event-stream") {
  if (contentType === "application/json") {
    try { return usageFromJson(JSON.parse(body.toString("utf8"))); } catch { return null; }
  }
  let found: ReturnType<typeof usageFromJson> = null;
  for (const line of body.toString("utf8").split(/\r?\n/u)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try { found = usageFromJson(JSON.parse(line.slice(6))) ?? found; } catch {}
  }
  return found;
}

async function readBoundedResponse(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new ScopedInferenceGatewayError(502, "upstream_response_bound", "Inference provider response exceeded its byte bound");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class HttpOpenAiInferenceUpstream implements InferenceUpstream {
  private readonly endpoint: string;
  private readonly credential?: string;
  private readonly authorization: "bearer" | "x-api-key";
  private readonly maxResponseBytes: number;

  constructor(options: HttpOpenAiInferenceUpstreamOptions) {
    let parsed: URL;
    try { parsed = new URL(options.baseUrl); } catch { throw new Error("Inference upstream base URL is invalid"); }
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname.toLowerCase());
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback && options.allowCredentialFreeLoopback))
        || parsed.username || parsed.password || parsed.pathname !== "/v1" || parsed.search || parsed.hash) {
      throw new Error("Inference upstream must be an HTTPS /v1 URL or an explicitly credential-free HTTP loopback /v1 URL");
    }
    if (options.credential !== undefined && (options.credential.length < 16 || /\s|[\u0000-\u001f\u007f]/u.test(options.credential))) {
      throw new Error("Inference upstream credential is invalid");
    }
    if (!options.credential && !(loopback && options.allowCredentialFreeLoopback)) {
      throw new Error("External inference upstream requires a provider credential");
    }
    this.endpoint = `${parsed.origin}/v1/chat/completions`;
    this.credential = options.credential;
    this.authorization = options.authorization;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    integer(this.maxResponseBytes, "maxResponseBytes", 1024, MAX_RESPONSE_BYTES);
  }

  async complete(input: Parameters<InferenceUpstream["complete"]>[0]): Promise<InferenceUpstreamResult> {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "valkyrie-scoped-inference/0.1" };
    if (this.credential && this.authorization === "bearer") headers.authorization = `Bearer ${this.credential}`;
    else if (this.credential) headers["x-api-key"] = this.credential;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST", headers, body: canonicalJson(input.body), signal: input.signal, redirect: "error",
      });
    } catch {
      throw new ScopedInferenceGatewayError(502, "upstream_transport", "Inference provider transport failed");
    }
    if (!response.ok) throw new ScopedInferenceGatewayError(502, "upstream_status", "Inference provider rejected the bounded request");
    const header = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (header !== "application/json" && header !== "text/event-stream") {
      throw new ScopedInferenceGatewayError(502, "upstream_content_type", "Inference provider returned an unsupported content type");
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > this.maxResponseBytes) {
      throw new ScopedInferenceGatewayError(502, "upstream_response_bound", "Inference provider response exceeded its byte bound");
    }
    const body = await readBoundedResponse(response, this.maxResponseBytes);
    const usage = responseUsage(body, header);
    if (!usage) throw new ScopedInferenceGatewayError(502, "missing_usage", "Inference provider omitted authoritative token usage");
    const rawId = response.headers.get("x-request-id") ?? usage.providerRequestId ?? "provider-response";
    const providerRequestId = SAFE_ID.test(rawId) ? rawId : `provider_${sha(rawId).slice(0, 32)}`;
    return { status: response.status, contentType: header, body, providerRequestId, ...usage };
  }
}

export async function issueScopedInferenceCapability(input: {
  store: ControlPlaneStore;
  runId: string;
  projectId: string;
  workflow: string;
  policy: ScopedInferencePolicy;
  now?: () => Date;
}): Promise<IssuedInferenceCapability> {
  validatePolicy(input.policy);
  const token = `vki_${randomBytes(32).toString("base64url")}`;
  const now = (input.now ?? (() => new Date()))();
  const policyHash = sha(canonicalJson(input.policy));
  const capability: InferenceCapability = {
    id: `icap_${sha(`${input.runId}\0${token}`).slice(0, 32)}`,
    runId: input.runId,
    projectId: input.projectId,
    workflow: input.workflow,
    tokenHash: sha(token),
    provider: input.policy.provider,
    model: input.policy.model,
    api: input.policy.api,
    roles: [...input.policy.roles],
    maxRequests: input.policy.maxRequests,
    maxInputTokens: input.policy.maxInputTokens,
    maxOutputTokens: input.policy.maxOutputTokens,
    maxCostMicros: input.policy.maxCostMicros,
    maxElapsedMs: input.policy.maxElapsedMs,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.policy.ttlMs).toISOString(),
    state: "active",
    policyHash,
  };
  await input.store.createInferenceCapability(capability);
  return { token, capability };
}

export class ScopedInferenceGateway {
  private readonly store: ControlPlaneStore;
  private readonly upstream: InferenceUpstream;
  private readonly policy: ScopedInferencePolicy;
  constructor(
    store: ControlPlaneStore,
    upstream: InferenceUpstream,
    policy: ScopedInferencePolicy,
  ) {
    this.store = store;
    this.upstream = upstream;
    this.policy = policy;
    validatePolicy(policy);
  }

  async complete(token: string, role: InferenceRole, rawBody: unknown): Promise<InferenceUpstreamResult> {
    if (!TOKEN.test(token)) throw new ScopedInferenceGatewayError(401, "invalid_capability", "Inference capability is invalid");
    const tokenHash = sha(token);
    const capability = await this.store.getInferenceCapabilityByTokenHash(tokenHash);
    if (!capability || capability.tokenHash !== tokenHash || capability.policyHash !== sha(canonicalJson(this.policy))) {
      throw new ScopedInferenceGatewayError(401, "invalid_capability", "Inference capability is invalid");
    }
    const body = sanitizeRequest(rawBody, capability, role, this.policy);
    const requestHash = sha(canonicalJson(body));
    const requestId = `ireq_${sha(`${capability.id}\0${role}\0${requestHash}`).slice(0, 32)}`;
    let reservation;
    try {
      reservation = await this.store.reserveInferenceRequest({
        id: requestId, tokenHash, runId: capability.runId, role, requestHash,
      });
    } catch {
      throw new ScopedInferenceGatewayError(409, "capability_conflict", "Inference capability reservation conflicted with durable policy");
    }
    if (reservation.replayed) {
      throw new ScopedInferenceGatewayError(409, "request_already_attempted", "This exact inference request has already been attempted; automatic replay is disabled");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(capability.maxElapsedMs, this.policy.maxElapsedMs));
    try {
      const priorRequests = (await this.store.listInferenceRequests(capability.runId))
        .filter((item) => item.id !== requestId && item.role === role && item.state === "completed" && item.providerSessionId);
      const priorSessionIds = [...new Set(priorRequests.map((item) => item.providerSessionId!))];
      if (priorSessionIds.length > 1) {
        throw new ScopedInferenceGatewayError(409, "provider_session_conflict", "Inference role has conflicting durable provider-session evidence");
      }
      const priorProviderSessionId = priorSessionIds[0];
      const result = await this.upstream.complete({
        capabilityId: capability.id, requestId,
        provider: capability.provider, model: capability.model, role, body,
        ...(priorProviderSessionId ? { priorProviderSessionId } : {}),
        timeoutMs: Math.min(capability.maxElapsedMs, this.policy.maxElapsedMs), signal: controller.signal,
      });
      if (!SAFE_ID.test(result.providerRequestId) || result.body.byteLength > MAX_RESPONSE_BYTES
          || !Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0
          || !Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0
          || !["application/json", "text/event-stream"].includes(result.contentType)) {
        throw new ScopedInferenceGatewayError(502, "invalid_upstream_response", "Inference upstream returned invalid bounded evidence");
      }
      const hasSessionId = result.providerSessionId !== undefined;
      const hasSessionReuse = result.providerSessionReused !== undefined;
      if (hasSessionId !== hasSessionReuse
          || (hasSessionId && (!SAFE_ID.test(result.providerSessionId!) || typeof result.providerSessionReused !== "boolean"))
          || (priorProviderSessionId !== undefined
            && (result.providerSessionId !== priorProviderSessionId || result.providerSessionReused !== true))
          || (priorProviderSessionId === undefined && result.providerSessionReused === true)) {
        throw new ScopedInferenceGatewayError(502, "provider_session_mismatch", "Inference upstream returned inconsistent provider-session evidence");
      }
      const nativeRecords = result.nativeRecords ?? [];
      if (!Array.isArray(nativeRecords) || nativeRecords.length > 4_096
          || nativeRecords.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
        throw new ScopedInferenceGatewayError(502, "invalid_upstream_response", "Inference upstream returned invalid native evidence");
      }
      for (const [ordinal, record] of nativeRecords.entries()) {
        await this.store.appendEvent({
          id: `event_inference_native_${sha(`${requestId}\0${ordinal}\0${canonicalJson(record)}`).slice(0, 32)}`,
          runId: capability.runId,
          type: "inference.native.raw",
          message: "Raw bounded inference-provider record retained",
          payload: {
            requestId,
            role,
            provider: capability.provider,
            model: capability.model,
            ordinal,
            providerSessionId: result.providerSessionId ?? null,
            providerSessionReused: result.providerSessionReused ?? null,
            rawNative: record,
          },
          createdAt: new Date().toISOString(),
        });
      }
      const cost = costMicros(this.policy, result.inputTokens, result.outputTokens);
      await this.store.completeInferenceRequest({
        id: requestId, state: "completed", responseHash: sha(result.body), providerRequestId: result.providerRequestId,
        ...(result.providerSessionId ? {
          providerSessionId: result.providerSessionId,
          providerSessionReused: result.providerSessionReused,
        } : {}),
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicros: cost,
      });
      await this.store.appendEvent({
        id: `event_inference_completed_${sha(requestId).slice(0, 32)}`,
        runId: capability.runId,
        type: "inference.request.completed",
        message: "Scoped inference request completed within its durable budget",
        payload: {
          requestId,
          role,
          providerRequestId: result.providerRequestId,
          providerSessionId: result.providerSessionId ?? null,
          providerSessionReused: result.providerSessionReused ?? null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costMicros: cost,
          nativeRecordCount: nativeRecords.length,
        },
        createdAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      await this.store.completeInferenceRequest({
        id: requestId, state: "failed", failureCode: error instanceof ScopedInferenceGatewayError ? error.code : "upstream_failure",
        inputTokens: 0, outputTokens: 0, costMicros: 0,
      }).catch(() => undefined);
      throw error instanceof ScopedInferenceGatewayError
        ? error
        : new ScopedInferenceGatewayError(502, "upstream_failure", "Inference upstream failed within the bounded proxy");
    } finally {
      clearTimeout(timer);
    }
  }

}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new ScopedInferenceGatewayError(413, "request_too_large", "Inference request exceeds its byte bound");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ScopedInferenceGatewayError(400, "invalid_json", "Inference request is not valid JSON"); }
}

function sendError(response: ServerResponse, error: unknown): void {
  const normalized = error instanceof ScopedInferenceGatewayError
    ? error
    : new ScopedInferenceGatewayError(500, "gateway_failure", "Inference gateway failed");
  response.writeHead(normalized.status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { code: normalized.code, message: normalized.message } }));
}

export function createScopedInferenceGatewayServer(gateway: ScopedInferenceGateway): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new ScopedInferenceGatewayError(404, "not_found", "Inference route was not found");
      }
      const auth = request.headers.authorization;
      const role = request.headers["x-valkyrie-role"];
      if (!auth?.startsWith("Bearer ") || typeof role !== "string") {
        throw new ScopedInferenceGatewayError(401, "missing_capability", "Inference capability and role are required");
      }
      const body = await readBody(request);
      const result = await gateway.complete(auth.slice(7), role as InferenceRole, body);
      response.writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-store" });
      response.end(result.body);
    } catch (error) { sendError(response, error); }
  });
}

export async function listenScopedInferenceGatewayUnix(server: Server, socketPath: string): Promise<() => Promise<void>> {
  if (!isAbsolute(socketPath)) throw new Error("Inference gateway Unix socket path must be absolute");
  const requested = resolve(socketPath);
  const parent = realpathSync(dirname(requested));
  const path = join(parent, basename(requested));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || (process.platform !== "win32" && (parentStat.mode & 0o077) !== 0)) {
    throw new Error("Inference gateway socket parent must be canonical, private, and non-symlinked");
  }
  if (existsSync(path)) throw new Error("Inference gateway socket path already exists");
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolvePromise(); };
    server.once("error", onError); server.once("listening", onListening); server.listen(path);
  });
  chmodSync(path, 0o600);
  return async () => {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    if (existsSync(path)) unlinkSync(path);
  };
}

/**
 * Colima/Docker Desktop cannot reliably bind-mount a macOS Unix socket into a
 * Linux VM. This loopback listener is reachable only through the engine's
 * special host gateway; the fixed dual-homed bridge remains the sole writer-
 * network peer and the run-scoped bearer is still mandatory on every request.
 */
export async function listenScopedInferenceGatewayLoopback(server: Server, port: number): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Inference gateway loopback port is invalid");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolvePromise(); };
    server.once("error", onError); server.once("listening", onListening); server.listen(port, "127.0.0.1");
  });
  return async () => {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  };
}
