import { loadControlPlaneAuth, validateLoopbackControlPlaneApi } from "../apps/control-plane/src/auth.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function requiredId(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !SAFE_ID.test(value)) throw new Error(`${name} must be a safe control-plane ID`);
  return value;
}

const api = validateLoopbackControlPlaneApi(process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787");
const auth = loadControlPlaneAuth();
if (!auth) throw new Error("The M7 read smoke requires the same control-plane bearer token as the running server");
const authToken = auth.token;
const projectId = requiredId("M7_LIVE_READ_PROJECT_ID");
const taskId = process.env.M7_LIVE_READ_TASK_ID?.trim();
if (taskId && !SAFE_ID.test(taskId)) throw new Error("M7_LIVE_READ_TASK_ID must be a safe control-plane ID");
const idempotencyKey = process.env.M7_LIVE_READ_IDEMPOTENCY_KEY?.trim()
  || `m7-live-read-${Date.now()}`;
if (!SAFE_ID.test(idempotencyKey)) throw new Error("M7_LIVE_READ_IDEMPOTENCY_KEY must be a safe control-plane ID");

async function request(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(`${api}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${authToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : `Control plane returned HTTP ${response.status}`);
  return value;
}

const status = await request("/api/connectors/status");
if (status?.enabled !== true || status?.linear?.mode === "disabled" || status?.git?.configuredProjects?.includes(projectId) !== true) {
  throw new Error("M7 connector status does not show the accepted Linear/Git project policy");
}
const result = await request("/api/engineering/assessments", {
  method: "POST",
  body: {
    projectId,
    ...(taskId ? { taskId } : {}),
    request: "Read current Linear and Git authority for the accepted M7 connector policy without launching a runtime.",
    preference: "auto",
    finalAction: "analysis_only",
    idempotencyKey,
  },
});
if (result?.assessment?.contextSources?.linear?.status !== "revision-bound"
    || result?.assessment?.contextSources?.git?.status !== "revision-bound"
    || result?.assessment?.executionSupported !== false
    || result?.launch?.supported !== false) {
  throw new Error("M7 live read did not return revision-bound authority with a fail-closed launcher");
}

console.log(JSON.stringify({
  status: "pass",
  projectId,
  taskId: taskId ?? null,
  assessmentId: result.assessment.id,
  linear: {
    status: result.assessment.contextSources.linear.status,
    projectRevision: result.assessment.contextSources.linear.projectRevision,
    taskRevision: result.assessment.contextSources.linear.taskRevision,
  },
  git: {
    status: result.assessment.contextSources.git.status,
    baseCommit: result.assessment.contextSources.git.baseCommit,
    headCommit: result.assessment.contextSources.git.headCommit,
    patchDigest: result.assessment.contextSources.git.patchDigest,
    policyDigest: result.assessment.contextSources.git.policyDigest,
  },
  externalWritesPerformed: false,
  runtimeLaunched: false,
}, null, 2));
