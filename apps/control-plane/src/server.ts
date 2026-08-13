import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { ControlPlaneService } from "./service.ts";
import type { ControlPlaneStore } from "./store.ts";
import { readJson, sendError, sendJson } from "./http.ts";
import { hasValidBearerAuthorization } from "./auth.ts";

const media: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

const ATOMIC_FIXTURE_ARTIFACT_READ_ERROR =
  "Atomic fixture artifact evidence is unavailable or no longer matches the pending approval";
const ATOMIC_MODEL_FIXTURE_ARTIFACT_READ_ERROR =
  "Atomic model fixture artifact evidence is unavailable or no longer matches the pending approval";
const DIRECT_CODEX_FIXTURE_ARTIFACT_READ_ERROR =
  "Direct Codex fixture artifact evidence is unavailable or no longer matches the pending approval";

const SAFE_CONTROL_PLANE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const EXTERNAL_ACTION_STATES = new Set([
  "pending_approval", "authorized", "executing", "ambiguous", "succeeded",
  "denied", "expired", "failed", "quarantined",
]);
const MAX_CONNECTOR_LIST_LIMIT = 1_000;
const MAX_EXTERNAL_ACTION_TEXT_BYTES = 4 * 1024;
const MAX_EXTERNAL_ACTION_EXPIRY_BYTES = 128;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  required: readonly string[] = [],
): void {
  const allowed = new Set(keys);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0 || required.some((key) => !(key in value))) {
    throw new Error(`${label} accepts exactly the supported fields: ${keys.join(", ") || "no fields"}`);
  }
}

function safeControlPlaneId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_CONTROL_PLANE_ID.test(value)) {
    throw new Error(`${field} must be a safe control-plane ID of at most 128 characters`);
  }
  return value;
}

function boundedUtf8String(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()
      || /[\u0000-\u001f\u007f\r]/u.test(value) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${field} must be a bounded UTF-8 string of at most ${maximumBytes} bytes`);
  }
  return value;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = boundedUtf8String(value, field, MAX_EXTERNAL_ACTION_EXPIRY_BYTES);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be an ISO-compatible timestamp`);
  return timestamp;
}

function optionalExpiry(value: unknown): string | undefined {
  return optionalTimestamp(value, "expiresAt");
}

function boundedLimit(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_CONNECTOR_LIST_LIMIT) {
    throw new Error(`${field} must be an integer between 1 and ${MAX_CONNECTOR_LIST_LIMIT}`);
  }
  return value;
}

function queryLimit(url: URL, field: string): number | undefined {
  const values = url.searchParams.getAll("limit");
  if (values.length > 1) throw new Error(`${field} limit must be provided once`);
  if (values.length === 0) return undefined;
  if (values[0] === "") throw new Error(`${field} limit must be an integer between 1 and ${MAX_CONNECTOR_LIST_LIMIT}`);
  if (!/^[0-9]+$/u.test(values[0])) throw new Error(`${field} limit must be an integer between 1 and ${MAX_CONNECTOR_LIST_LIMIT}`);
  return boundedLimit(Number(values[0]), `${field} limit`);
}

function queryValue(url: URL, name: string, label: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error(`${label} must be provided once`);
  if (values.length === 0) return undefined;
  if (values[0] === "") throw new Error(`${label} must not be empty`);
  return values[0];
}

function rejectUnknownQuery(url: URL, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!accepted.has(key)) throw new Error(`${label} contains an unsupported query field`);
  }
}

function requireOperator(operatorId: string | undefined, label: string): string {
  if (!operatorId) throw new Error(`${label} requires a configured operator principal`);
  return safeControlPlaneId(operatorId, "Operator principal");
}

function decodeSafePathId(value: string, field: string): string {
  return safeControlPlaneId(decodeURIComponent(value), field);
}

function prepareGithubDraftPrInput(value: unknown): {
  runId: string; title: string; body: string; idempotencyKey?: string; expiresAt?: string;
} {
  const body = asObject(value, "GitHub draft PR preparation");
  exactObjectKeys(body, ["runId", "title", "body", "idempotencyKey", "expiresAt"], "GitHub draft PR preparation", ["runId", "title", "body"]);
  return {
    runId: safeControlPlaneId(body.runId, "runId"),
    title: boundedUtf8String(body.title, "title", MAX_EXTERNAL_ACTION_TEXT_BYTES),
    body: boundedUtf8String(body.body, "body", MAX_EXTERNAL_ACTION_TEXT_BYTES),
    ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: safeControlPlaneId(body.idempotencyKey, "idempotencyKey") }),
    ...(body.expiresAt === undefined ? {} : { expiresAt: optionalExpiry(body.expiresAt)! }),
  };
}

function prepareLinearEvidenceCommentInput(value: unknown): {
  runId: string; body: string; idempotencyKey?: string; expiresAt?: string;
} {
  const body = asObject(value, "Linear evidence comment preparation");
  exactObjectKeys(body, ["runId", "body", "idempotencyKey", "expiresAt"], "Linear evidence comment preparation", ["runId", "body"]);
  return {
    runId: safeControlPlaneId(body.runId, "runId"),
    body: boundedUtf8String(body.body, "body", MAX_EXTERNAL_ACTION_TEXT_BYTES),
    ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: safeControlPlaneId(body.idempotencyKey, "idempotencyKey") }),
    ...(body.expiresAt === undefined ? {} : { expiresAt: optionalExpiry(body.expiresAt)! }),
  };
}

function prepareLinearIssueInput(value: unknown): {
  runId: string; title: string; description: string; idempotencyKey?: string; expiresAt?: string;
} {
  const body = asObject(value, "Linear issue preparation");
  exactObjectKeys(
    body,
    ["runId", "title", "description", "idempotencyKey", "expiresAt"],
    "Linear issue preparation",
    ["runId", "title", "description"],
  );
  return {
    runId: safeControlPlaneId(body.runId, "runId"),
    title: boundedUtf8String(body.title, "title", MAX_EXTERNAL_ACTION_TEXT_BYTES),
    description: boundedUtf8String(body.description, "description", MAX_EXTERNAL_ACTION_TEXT_BYTES),
    ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: safeControlPlaneId(body.idempotencyKey, "idempotencyKey") }),
    ...(body.expiresAt === undefined ? {} : { expiresAt: optionalExpiry(body.expiresAt)! }),
  };
}

function resolveExternalActionInput(value: unknown): {
  decision: "approve" | "deny" | "request_changes"; idempotencyKey?: string;
} {
  const body = asObject(value, "External action resolution");
  exactObjectKeys(body, ["decision", "idempotencyKey"], "External action resolution", ["decision"]);
  if (body.decision !== "approve" && body.decision !== "deny" && body.decision !== "request_changes") {
    throw new Error("External action resolution decision is invalid");
  }
  return {
    decision: body.decision,
    ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: safeControlPlaneId(body.idempotencyKey, "idempotencyKey") }),
  };
}

function reconcileExternalActionInput(value: unknown): {
  outcome: "zero" | "one" | "multiple";
  matchCount?: number;
  externalId?: string;
  externalRevision?: string;
  payloadHash?: string;
  observedAt?: string;
} {
  const body = asObject(value, "External action reconciliation");
  exactObjectKeys(
    body,
    ["outcome", "matchCount", "externalId", "externalRevision", "payloadHash", "observedAt"],
    "External action reconciliation",
    ["outcome"],
  );
  if (body.outcome !== "zero" && body.outcome !== "one" && body.outcome !== "multiple") {
    throw new Error("External action reconciliation outcome is invalid");
  }
  if (body.matchCount !== undefined
      && (!Number.isSafeInteger(body.matchCount) || (body.matchCount as number) < 0 || (body.matchCount as number) > 100)) {
    throw new Error("External action reconciliation matchCount is invalid");
  }
  if (body.outcome === "one"
      && (body.externalId === undefined || body.externalRevision === undefined || body.payloadHash === undefined)) {
    throw new Error("One-match reconciliation requires complete provider identity");
  }
  if (body.outcome !== "one"
      && (body.externalId !== undefined || body.externalRevision !== undefined || body.payloadHash !== undefined)) {
    throw new Error("Only one-match reconciliation may include provider identity");
  }
  if (body.payloadHash !== undefined
      && (typeof body.payloadHash !== "string" || !/^[a-f0-9]{64}$/u.test(body.payloadHash))) {
    throw new Error("External action reconciliation payloadHash is invalid");
  }
  return {
    outcome: body.outcome,
    ...(body.matchCount === undefined ? {} : { matchCount: body.matchCount as number }),
    ...(body.externalId === undefined ? {} : { externalId: safeControlPlaneId(body.externalId, "externalId") }),
    ...(body.externalRevision === undefined ? {} : { externalRevision: safeControlPlaneId(body.externalRevision, "externalRevision") }),
    ...(body.payloadHash === undefined ? {} : { payloadHash: body.payloadHash }),
    ...(body.observedAt === undefined ? {} : { observedAt: optionalTimestamp(body.observedAt, "observedAt")! }),
  };
}

export function createControlPlaneServer(
  service: ControlPlaneService,
  store: ControlPlaneStore,
  publicDir: string,
  options: { enableDemoReset?: boolean; authToken?: string; operatorId?: string } = {},
) {
  const enableSqliteDemoReset = store.backend === "sqlite" && (options.enableDemoReset ?? true);
  return createServer(async (req, res) => {
    try {
      await route(req, res, service, store, publicDir, enableSqliteDemoReset, options.authToken, options.operatorId);
    } catch (error) {
      console.error(error);
      sendError(res, error, 400);
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  service: ControlPlaneService,
  store: ControlPlaneStore,
  publicDir: string,
  enableDemoReset: boolean,
  authToken?: string,
  operatorId?: string,
) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    const health = await store.healthCheck();
    const ok = health.ok && health.migrationsCurrent;
    return sendJson(res, ok ? 200 : 503, {
      ok,
      service: "wesley-agent-control-plane",
      prototype: true,
      storage: { backend: health.backend, migrationsCurrent: health.migrationsCurrent },
    });
  }
  if (path === "/api" || path.startsWith("/api/")) {
    if (authToken && !hasValidBearerAuthorization(req.headers.authorization, authToken)) {
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": 'Bearer realm="control-plane"',
      });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
  }
  let match: RegExpMatchArray | null;
  const productionConnectorRoute = path === "/api/connectors/status"
    || path === "/api/connectors/outbox/dead"
    || path.startsWith("/api/connectors/outbox/dead/")
    || path === "/api/external-actions"
    || path.startsWith("/api/external-actions/");
  if (productionConnectorRoute && !authToken) {
    return sendJson(res, 403, { error: "Production connector API requires configured bearer authentication" });
  }

  if (method === "GET" && path === "/api/connectors/status") {
    return sendJson(res, 200, await service.connectorStatus());
  }

  if (method === "GET" && path === "/api/connectors/outbox/dead") {
    rejectUnknownQuery(url, ["limit"], "Dead-letter list query");
    const limit = queryLimit(url, "Dead-letter list");
    return sendJson(res, 200, limit === undefined
      ? await service.listConnectorDeadLetters()
      : await service.listConnectorDeadLetters(limit));
  }

  match = path.match(/^\/api\/connectors\/outbox\/dead\/([^/]+)$/);
  if (method === "POST" && match) {
    const resolvedBy = requireOperator(operatorId, "Dead-letter replay");
    const body = asObject(await readJson(req), "Dead-letter replay");
    exactObjectKeys(body, [], "Dead-letter replay");
    return sendJson(res, 200, await service.replayConnectorDeadLetter(
      decodeSafePathId(match[1], "outboxId"), resolvedBy,
    ));
  }

  if (method === "POST" && path === "/api/external-actions/github-draft-pr") {
    requireOperator(operatorId, "GitHub draft PR preparation");
    return sendJson(res, 201, await service.prepareGithubDraftPr(prepareGithubDraftPrInput(await readJson(req))));
  }

  if (method === "POST" && path === "/api/external-actions/linear-evidence-comment") {
    requireOperator(operatorId, "Linear evidence comment preparation");
    return sendJson(res, 201, await service.prepareLinearEvidenceComment(prepareLinearEvidenceCommentInput(await readJson(req))));
  }

  if (method === "POST" && path === "/api/external-actions/linear-issue") {
    requireOperator(operatorId, "Linear issue preparation");
    return sendJson(res, 201, await service.prepareLinearIssue(prepareLinearIssueInput(await readJson(req))));
  }

  if (method === "GET" && path === "/api/external-actions") {
    rejectUnknownQuery(url, ["projectId", "state", "limit"], "External action list query");
    const projectId = queryValue(url, "projectId", "External action projectId");
    const state = queryValue(url, "state", "External action state");
    const limit = queryLimit(url, "External action list");
    if (projectId !== undefined) safeControlPlaneId(projectId, "projectId");
    if (state !== undefined && !EXTERNAL_ACTION_STATES.has(state)) {
      throw new Error("External action state is invalid");
    }
    return sendJson(res, 200, await service.listExternalActionPlans({
      ...(projectId !== undefined ? { projectId } : {}),
      ...(state !== undefined ? { state: state as "pending_approval" | "authorized" | "executing" | "ambiguous" | "succeeded" | "denied" | "expired" | "failed" | "quarantined" } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }));
  }

  match = path.match(/^\/api\/external-actions\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    const resolvedBy = requireOperator(operatorId, "External action approval resolution");
    const planId = decodeSafePathId(match[1], "planId");
    const input = resolveExternalActionInput(await readJson(req));
    return sendJson(res, 200, await service.resolveExternalActionPlan(
      planId, input.decision, resolvedBy, input.idempotencyKey,
    ));
  }

  match = path.match(/^\/api\/external-actions\/([^/]+)\/reconcile$/);
  if (method === "POST" && match) {
    const operator = requireOperator(operatorId, "External action reconciliation");
    return sendJson(res, 200, await service.reconcileExternalActionPlan(
      decodeSafePathId(match[1], "planId"),
      reconcileExternalActionInput(await readJson(req)),
      operator,
    ));
  }

  match = path.match(/^\/api\/external-actions\/([^/]+)$/);
  if (method === "GET" && match) {
    return sendJson(res, 200, await service.getExternalActionPlan(decodeSafePathId(match[1], "planId")));
  }

  if (method === "GET" && path === "/api/portfolio") return sendJson(res, 200, await service.portfolio());
  if (method === "GET" && path === "/api/runtimes") return sendJson(res, 200, await service.runtimeStatus());
  if (method === "GET" && path === "/api/skill-suites") return sendJson(res, 200, service.skillSuiteStatus());
  if (method === "GET" && path === "/api/projects") return sendJson(res, 200, await service.listProjects());
  if (method === "GET" && path === "/api/tasks") return sendJson(res, 200, await service.listTasks(url.searchParams.get("projectId") ?? undefined));
  if (method === "GET" && path === "/api/runs") return sendJson(res, 200, await service.listRuns());
  if (method === "GET" && path === "/api/approvals") return sendJson(res, 200, await service.listApprovals());
  if (method === "GET" && path === "/api/memory/proposals") return sendJson(res, 200, await service.listMemoryProposals());

  match = path.match(/^\/api\/engineering\/assessments\/([^/]+)$/);
  if (method === "GET" && match) {
    if (!authToken) return sendJson(res, 403, { error: "Engineering intake requires configured bearer authentication" });
    return sendJson(res, 200, await service.getEngineeringRoutingAssessment(decodeURIComponent(match[1])));
  }

  if (method === "POST" && path === "/api/engineering/assessments") {
    if (!authToken) return sendJson(res, 403, { error: "Engineering intake requires configured bearer authentication" });
    return sendJson(res, 201, await service.assessEngineeringRequest(await readJson(req)));
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/brief$/);
  if (method === "GET" && match) return sendJson(res, 200, await service.projectBrief(decodeURIComponent(match[1])));

  match = path.match(/^\/api\/runs\/([^/]+)$/);
  if (method === "GET" && match) return sendJson(res, 200, await service.getRun(decodeURIComponent(match[1])));

  match = path.match(/^\/api\/comparisons\/([^/]+)$/);
  if (method === "GET" && match) return sendJson(res, 200, await service.getComparison(decodeURIComponent(match[1])));

  match = path.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (method === "GET" && match) return streamEvents(req, res, store, decodeURIComponent(match[1]), Number(url.searchParams.get("after") ?? 0));

  match = path.match(/^\/api\/memory\/proposals\/([^/]+)\/preview$/);
  if (method === "GET" && match) return sendJson(res, 200, await service.previewMemoryPromotion(decodeURIComponent(match[1])));

  if (method === "GET" && path === "/api/memory/search") {
    const projectId = url.searchParams.get("projectId") ?? "";
    const q = url.searchParams.get("q") ?? "";
    return sendJson(res, 200, await service.searchMemory(projectId, q));
  }

  if (method === "POST" && path === "/api/ideas") return sendJson(res, 200, await service.captureIdea(await readJson(req)));
  if (method === "POST" && path === "/api/runs") return sendJson(res, 202, await service.startRun(await readJson(req)));
  if (method === "POST" && path === "/api/runs/compare") return sendJson(res, 202, await service.compareRuns(await readJson(req)));
  if (method === "POST" && path === "/api/memory/proposals") return sendJson(res, 201, await service.proposeMemory(await readJson(req)));
  if (method === "POST" && path === "/api/demo/reset") {
    if (!enableDemoReset) return sendJson(res, 403, { error: "Demo reset is disabled" });
    await service.resetDemo(true);
    return sendJson(res, 200, { ok: true });
  }

  match = path.match(/^\/api\/runs\/([^/]+)\/steer$/);
  if (method === "POST" && match) {
    const body = await readJson(req);
    return sendJson(res, 200, await service.steerRun(decodeURIComponent(match[1]), String(body.message ?? "")));
  }

  match = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (method === "POST" && match) return sendJson(res, 200, await service.cancelRun(
    decodeURIComponent(match[1]),
    operatorId ?? "authenticated-control-plane-client",
  ));

  match = path.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    const body = await readJson(req);
    return sendJson(res, 200, await service.resolveApproval(
      decodeURIComponent(match[1]),
      String(body.decision ?? ""),
      operatorId ?? "authenticated-control-plane-client",
    ));
  }

  match = path.match(/^\/api\/atomic-fixture\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    const body = await readJson(req);
    return sendJson(res, 200, await service.resolveAtomicFixtureApproval(
      decodeURIComponent(match[1]),
      String(body.decision ?? ""),
      operatorId ?? "authenticated-control-plane-client",
    ));
  }

  match = path.match(/^\/api\/atomic-fixture\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === "GET" && match) {
    try {
      return sendJson(res, 200, await service.readAtomicFixtureArtifact(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      ));
    } catch {
      // Never serialize a filesystem/store exception from this human-review
      // surface: native fs errors commonly embed absolute host paths.
      return sendJson(res, 400, { error: ATOMIC_FIXTURE_ARTIFACT_READ_ERROR });
    }
  }

  match = path.match(/^\/api\/atomic-model-fixture\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    if (!operatorId) return sendJson(res, 403, { error: "Atomic model approval requires a configured operator principal" });
    const body = await readJson(req);
    return sendJson(res, 200, await service.resolveAtomicModelFixtureApproval(
      decodeURIComponent(match[1]),
      String(body.decision ?? ""),
      operatorId,
    ));
  }

  match = path.match(/^\/api\/atomic-model-fixture\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === "GET" && match) {
    try {
      return sendJson(res, 200, await service.readAtomicModelFixtureArtifact(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      ));
    } catch {
      return sendJson(res, 400, { error: ATOMIC_MODEL_FIXTURE_ARTIFACT_READ_ERROR });
    }
  }

  match = path.match(/^\/api\/direct-codex-fixture\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    if (!operatorId) return sendJson(res, 403, { error: "Direct Codex approval requires a configured operator principal" });
    const body = await readJson(req);
    return sendJson(res, 200, await service.resolveDirectCodexFixtureApproval(
      decodeURIComponent(match[1]),
      String(body.decision ?? ""),
      operatorId,
    ));
  }

  match = path.match(/^\/api\/direct-codex-fixture\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === "GET" && match) {
    try {
      return sendJson(res, 200, await service.readDirectCodexFixtureArtifact(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      ));
    } catch {
      return sendJson(res, 400, { error: DIRECT_CODEX_FIXTURE_ARTIFACT_READ_ERROR });
    }
  }

  match = path.match(/^\/api\/memory\/proposals\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    const body = await readJson(req);
    return sendJson(res, 200, await service.resolveMemoryProposal(
      decodeURIComponent(match[1]),
      String(body.decision ?? ""),
      body.preview,
    ));
  }

  if (method === "GET") return serveStatic(res, publicDir, path);
  sendJson(res, 404, { error: "Not found" });
}

function streamEvents(req: IncomingMessage, res: ServerResponse, store: ControlPlaneStore, runId: string, initialSeq: number) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  let last = initialSeq;
  let flushing = false;
  let closed = false;
  const flush = async () => {
    if (flushing || closed) return;
    flushing = true;
    try {
      const events = await store.listEvents(runId, last);
      for (const event of events) {
        last = event.seq;
        res.write(`id: ${event.seq}\n`);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      flushing = false;
    }
  };
  const poll = () => { void flush().catch((error) => res.destroy(error instanceof Error ? error : new Error(String(error)))); };
  poll();
  const timer = setInterval(poll, 750);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    clearInterval(keepAlive);
  });
}

function serveStatic(res: ServerResponse, publicDir: string, requestPath: string) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const root = resolve(publicDir);
  const file = resolve(join(root, relativePath));
  if (!file.startsWith(root) || !existsSync(file)) return sendJson(res, 404, { error: "Not found" });
  const data = readFileSync(file);
  res.writeHead(200, { "content-type": media[extname(file)] ?? "application/octet-stream", "content-length": data.length });
  res.end(data);
}
