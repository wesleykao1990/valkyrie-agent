import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildIsolatedSmokeEnvironment } from "./smoke-environment.ts";

const root = resolve(".");
const temporaryRoot = mkdtempSync(join(tmpdir(), "wesley-acp-http-smoke-"));
const dataDir = join(temporaryRoot, "data");
const brainDir = join(temporaryRoot, "project-brain");
cpSync(join(root, "project-brain"), brainDir, { recursive: true });
const port = 19877 + Math.floor(Math.random() * 1000);
const api = `http://127.0.0.1:${port}`;
const authToken = "http-smoke-local-bearer-token-0123456789";

const server = spawn(process.execPath, ["--experimental-strip-types", "apps/control-plane/src/index.ts"], {
  cwd: root,
  env: buildIsolatedSmokeEnvironment({
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    PROJECT_BRAIN_DIR: brainDir,
    DEMO_STAGE_DELAY_MS: "5",
    CONTROL_PLANE_AUTH_TOKEN: authToken,
  }),
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
let serverError = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverError += chunk; });

async function json<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (path.startsWith("/api/")) headers.authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function waitFor<T>(load: () => Promise<T>, predicate: (value: T) => boolean, label: string, attempts = 200): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i += 1) {
    try {
      last = await load();
      if (predicate(last)) return last;
    } catch {}
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}\n${serverError}`);
}

try {
  await waitFor(() => json<{ ok: boolean }>("/health"), (value) => value.ok, "server health");

  const unauthenticated = await fetch(`${api}/api/portfolio`);
  if (unauthenticated.status !== 401 || unauthenticated.headers.get("www-authenticate") !== 'Bearer realm="control-plane"') {
    throw new Error("Authenticated API boundary did not reject a request without a bearer token");
  }
  const wrongToken = await fetch(`${api}/api/portfolio`, { headers: { authorization: "Bearer wrong-token-value-that-is-long-enough" } });
  if (wrongToken.status !== 401) throw new Error("Authenticated API boundary accepted an incorrect bearer token");

  const portfolio = await json<any>("/api/portfolio");
  if (portfolio.projects?.length !== 3) throw new Error("Expected three seeded projects");
  const page = await (await fetch(`${api}/`)).text();
  if (!page.includes("Wesley Agent Control Plane")) throw new Error("Developer console did not render");

  const comparison = await json<any>("/api/runs/compare", "POST", {
    projectId: "ovalo",
    objective: "Implement and verify pronunciation feedback",
    runtimes: ["atomic", "codex", "claude"],
    perRunMaxCostUsd: 5,
  });
  const runIds: string[] = comparison.runs.map((run: any) => run.id);
  const workspaceIds: string[] = comparison.runs.map((run: any) => run.workspaceId);
  if (runIds.length !== 3 || new Set(runIds).size !== 3) throw new Error("Comparison did not create three runs");
  if (new Set(workspaceIds).size !== 3) throw new Error("Comparison candidates did not receive distinct workspaces");

  const approvals = await waitFor(
    () => json<any[]>("/api/approvals"),
    (items) => items.filter((item) => item.state === "pending" && runIds.includes(item.runId)).length === 3,
    "three approval gates",
  );
  const pending = approvals.filter((item) => item.state === "pending" && runIds.includes(item.runId));
  const invalidApproval = await fetch(`${api}/api/approvals/${pending[0].id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ decision: "approve_eventually" }),
  });
  if (invalidApproval.status !== 400 || !(await invalidApproval.text()).includes("decision must be approve")) {
    throw new Error("Invalid approval decision was not rejected without persistence");
  }
  const missingApproval = await fetch(`${api}/api/approvals/${pending[0].id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({}),
  });
  if (missingApproval.status !== 400 || !(await missingApproval.text()).includes("decision must be approve")) {
    throw new Error("Missing approval decision was not rejected without persistence");
  }
  const stillPending = await json<any[]>("/api/approvals");
  if (stillPending.find((item) => item.id === pending[0].id)?.state !== "pending") {
    throw new Error("Invalid approval decision mutated approval state");
  }
  for (const approval of pending) {
    await json(`/api/approvals/${approval.id}/resolve`, "POST", { decision: "approve" });
  }

  const allRuns = await waitFor(
    () => json<any[]>("/api/runs"),
    (items) => runIds.every((runId) => items.find((item) => item.id === runId)?.status === "completed"),
    "three completed runs",
  );
  const selectedRuns = runIds.map((runId) => allRuns.find((item) => item.id === runId));

  const details = await Promise.all(runIds.map((runId) => json<any>(`/api/runs/${runId}`)));
  const artifactCounts = details.map((detail) => detail.artifacts.length);
  if (!details.every((detail) => detail.artifacts.length >= 2)) throw new Error(`Insufficient evidence artifacts: ${artifactCounts.join(", ")}`);
  if (!details.every((detail) => detail.events.some((event: any) => event.type === "run.completed"))) {
    throw new Error("At least one run lacks a normalized completion event");
  }

  const proposals = await waitFor(
    () => json<any[]>("/api/memory/proposals"),
    (items) => items.filter((item) => item.state === "proposed" && runIds.includes(item.runId)).length === 3,
    "three governed memory proposals",
  );
  const proposal = proposals.find((item) => item.state === "proposed" && runIds.includes(item.runId));
  const invalidMemory = await fetch(`${api}/api/memory/proposals/${proposal.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ decision: "promote_eventually" }),
  });
  if (invalidMemory.status !== 400 || !(await invalidMemory.text()).includes("decision must be promote")) {
    throw new Error("Invalid memory decision was not rejected without persistence");
  }
  const stillProposed = await json<any[]>("/api/memory/proposals");
  if (stillProposed.find((item) => item.id === proposal.id)?.state !== "proposed") {
    throw new Error("Invalid memory decision mutated proposal state");
  }
  const missingPreview = await fetch(`${api}/api/memory/proposals/${proposal.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ decision: "promote" }),
  });
  if (missingPreview.status !== 400 || !(await missingPreview.text()).includes("exact reviewed preview")) {
    throw new Error("Memory promotion without an exact preview was not rejected");
  }
  const preview = await json<any>(`/api/memory/proposals/${proposal.id}/preview`);
  if (preview.proposalId !== proposal.id || !preview.target || !preview.content?.includes(proposal.claim)) {
    throw new Error("Memory review endpoint did not return the exact proposal target and content");
  }
  if (existsSync(preview.path)) throw new Error("Memory preview wrote canonical Markdown before promotion");
  const tamperedPreview = await fetch(`${api}/api/memory/proposals/${proposal.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ decision: "promote", preview: { ...preview, content: `${preview.content}\ntampered` } }),
  });
  if (tamperedPreview.status !== 400 || !(await tamperedPreview.text()).includes("does not exactly match")) {
    throw new Error("Tampered memory preview was not rejected");
  }
  const afterTamper = await json<any[]>("/api/memory/proposals");
  if (afterTamper.find((item) => item.id === proposal.id)?.state !== "proposed" || existsSync(preview.path)) {
    throw new Error("Tampered memory preview mutated proposal or canonical Project Brain state");
  }
  const promoted = await json<any>(`/api/memory/proposals/${proposal.id}/resolve`, "POST", { decision: "promote", preview });
  if (promoted.state !== "promoted") throw new Error("Memory proposal was not promoted through the review endpoint");
  if (!promoted.targetNote || !existsSync(join(brainDir, promoted.targetNote))) {
    throw new Error("Promoted canonical Markdown note was not created");
  }

  console.log(
    `HTTP smoke passed: ${portfolio.projects.length} projects, ${selectedRuns.length} isolated candidates, ` +
    `${pending.length} approvals, artifacts ${artifactCounts.join("/")}, and one promoted memory proposal.`,
  );
} finally {
  server.kill("SIGTERM");
  await delay(100);
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (server.exitCode && server.exitCode !== 0) {
    process.stderr.write(`${serverOutput}\n${serverError}`);
  }
}
