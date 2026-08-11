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

export function createControlPlaneServer(
  service: ControlPlaneService,
  store: ControlPlaneStore,
  publicDir: string,
  options: { enableDemoReset?: boolean; authToken?: string } = {},
) {
  const enableSqliteDemoReset = store.backend === "sqlite" && (options.enableDemoReset ?? true);
  return createServer(async (req, res) => {
    try {
      await route(req, res, service, store, publicDir, enableSqliteDemoReset, options.authToken);
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
  if (method === "GET" && path === "/api/portfolio") return sendJson(res, 200, await service.portfolio());
  if (method === "GET" && path === "/api/runtimes") return sendJson(res, 200, await service.runtimeStatus());
  if (method === "GET" && path === "/api/projects") return sendJson(res, 200, await service.listProjects());
  if (method === "GET" && path === "/api/tasks") return sendJson(res, 200, await service.listTasks(url.searchParams.get("projectId") ?? undefined));
  if (method === "GET" && path === "/api/runs") return sendJson(res, 200, await service.listRuns());
  if (method === "GET" && path === "/api/approvals") return sendJson(res, 200, await service.listApprovals());
  if (method === "GET" && path === "/api/memory/proposals") return sendJson(res, 200, await service.listMemoryProposals());

  let match = path.match(/^\/api\/projects\/([^/]+)\/brief$/);
  if (method === "GET" && match) return sendJson(res, 200, await service.projectBrief(decodeURIComponent(match[1])));

  match = path.match(/^\/api\/runs\/([^/]+)$/);
  if (method === "GET" && match) return sendJson(res, 200, await service.getRun(decodeURIComponent(match[1])));

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
  if (method === "POST" && match) return sendJson(res, 200, await service.cancelRun(decodeURIComponent(match[1])));

  match = path.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && match) {
    const body = await readJson(req);
    return sendJson(res, 200, await service.resolveApproval(decodeURIComponent(match[1]), String(body.decision ?? ""), "wesley"));
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
