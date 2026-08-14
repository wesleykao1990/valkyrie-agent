import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { ControlPlaneService } from "../apps/control-plane/src/service.ts";
import type { ControlPlaneStore } from "../apps/control-plane/src/store.ts";

const token = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";

test("HTTP bearer auth protects every API route while health and static files stay public", async () => {
  const root = mkdtempSync(join(tmpdir(), "control-plane-server-auth-"));
  const publicDir = join(root, "public");
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, "index.html"), "public developer console");
  const artifactReads: Array<{ runId: string; artifactId: string }> = [];
  const modelArtifactReads: Array<{ runId: string; artifactId: string }> = [];
  const modelApprovals: Array<{ approvalId: string; decision: string; resolvedBy: string }> = [];
  const engineeringRequests: unknown[] = [];
  const service = {
    portfolio: async () => ({ projects: [] }),
    runtimeStatus: async () => [{ runtime: "atomic", adapter: "mock", available: true }],
    skillSuiteStatus: () => ({ enabled: false, rootRef: "private-managed-skill-suites", suites: [] }),
    assessEngineeringRequest: async (input: unknown) => {
      engineeringRequests.push(input);
      return { assessment: { id: "route_fixture", selectedShape: "atomic-lite", executionSupported: false }, replayed: false };
    },
    getEngineeringRoutingAssessment: async (assessmentId: string) => ({ id: assessmentId, selectedShape: "atomic-lite" }),
    readAtomicFixtureArtifact: async (runId: string, artifactId: string) => {
      artifactReads.push({ runId, artifactId });
      if (artifactId === "artifact_internal_failure") {
        throw new Error(`ENOENT: no such file or directory, open '${join(root, "private-artifacts", runId)}'`);
      }
      return {
        runId,
        approvalId: "approval_fixture",
        artifactId,
        kind: "candidate-patch",
        mediaType: "text/x-diff",
        checksum: "a".repeat(64),
        sizeBytes: 12,
        evidenceDigest: "b".repeat(64),
        content: "patch bytes\n",
      };
    },
    readAtomicModelFixtureArtifact: async (runId: string, artifactId: string) => {
      modelArtifactReads.push({ runId, artifactId });
      return {
        runId,
        approvalId: "approval_model",
        artifactId,
        kind: "fresh-model-verifier-final",
        mediaType: "application/json",
        checksum: "c".repeat(64),
        sizeBytes: 18,
        evidenceDigest: "d".repeat(64),
        content: "{\"approved\":true}\n",
      };
    },
    resolveAtomicModelFixtureApproval: async (approvalId: string, decision: string, resolvedBy: string) => {
      modelApprovals.push({ approvalId, decision, resolvedBy });
      return { run: { id: "run_model", status: "completed" } };
    },
  } as unknown as ControlPlaneService;
  const store = {
    backend: "sqlite",
    healthCheck: async () => ({ ok: true, backend: "sqlite", migrationsCurrent: true }),
  } as unknown as ControlPlaneStore;
  const server = createControlPlaneServer(service, store, publicDir, {
    authToken: token,
    operatorId: "wesley-local-operator",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.match(await (await fetch(`${base}/`)).text(), /public developer console/);

    const missing = await fetch(`${base}/api/portfolio`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="control-plane"');
    assert.deepEqual(await missing.json(), { error: "Unauthorized" });

    const wrong = await fetch(`${base}/api/runtimes`, {
      headers: { authorization: "Bearer definitely-not-the-control-plane-token" },
    });
    assert.equal(wrong.status, 401);

    const sse = await fetch(`${base}/api/runs/run_example/events`);
    assert.equal(sse.status, 401);

    const unknownApi = await fetch(`${base}/api/not-a-real-route`);
    assert.equal(unknownApi.status, 401);

    const artifactWithoutAuth = await fetch(
      `${base}/api/atomic-fixture/runs/run_fixture/artifacts/artifact_fixture`,
    );
    assert.equal(artifactWithoutAuth.status, 401);
    assert.equal((await fetch(
      `${base}/api/atomic-model-fixture/runs/run_model/artifacts/artifact_model`,
    )).status, 401);

    const runtimes = await fetch(`${base}/api/runtimes`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(runtimes.status, 200);
    assert.equal((await runtimes.json())[0].runtime, "atomic");
    const suites = await fetch(`${base}/api/skill-suites`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(suites.status, 200);
    assert.equal((await suites.json() as any).rootRef, "private-managed-skill-suites");

    const engineering = await fetch(`${base}/api/engineering/assessments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "ovalo", request: "Implement a bounded parser with unit tests." }),
    });
    assert.equal(engineering.status, 201);
    assert.equal((await engineering.json() as any).assessment.id, "route_fixture");
    const engineeringGet = await fetch(`${base}/api/engineering/assessments/route_fixture`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(engineeringGet.status, 200);
    assert.equal((await engineeringGet.json() as any).id, "route_fixture");
    assert.deepEqual(engineeringRequests, [{ projectId: "ovalo", request: "Implement a bounded parser with unit tests." }]);

    const artifact = await fetch(
      `${base}/api/atomic-fixture/runs/run_fixture/artifacts/artifact_fixture`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(artifact.status, 200);
    const artifactBody = await artifact.json() as Record<string, unknown>;
    assert.equal(artifactBody.content, "patch bytes\n");
    assert.equal("path" in artifactBody, false);
    assert.equal(JSON.stringify(artifactBody).includes(root), false);

    const failedArtifact = await fetch(
      `${base}/api/atomic-fixture/runs/run_fixture/artifacts/artifact_internal_failure`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(failedArtifact.status, 400);
    const failedBody = await failedArtifact.json() as { error: string };
    assert.match(failedBody.error, /unavailable|no longer matches/i);
    assert.equal(failedBody.error.includes(root), false);
    assert.deepEqual(artifactReads, [
      { runId: "run_fixture", artifactId: "artifact_fixture" },
      { runId: "run_fixture", artifactId: "artifact_internal_failure" },
    ]);

    const modelArtifact = await fetch(
      `${base}/api/atomic-model-fixture/runs/run_model/artifacts/artifact_model`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(modelArtifact.status, 200);
    assert.equal((await modelArtifact.json() as Record<string, unknown>).content, "{\"approved\":true}\n");
    const resolved = await fetch(
      `${base}/api/atomic-model-fixture/approvals/approval_model/resolve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    assert.equal(resolved.status, 200);
    assert.deepEqual(modelArtifactReads, [{ runId: "run_model", artifactId: "artifact_model" }]);
    assert.deepEqual(modelApprovals, [{
      approvalId: "approval_model",
      decision: "approve",
      resolvedBy: "wesley-local-operator",
    }]);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});

test("general engineering intake remains unavailable on an unauthenticated loopback API", async () => {
  const root = mkdtempSync(join(tmpdir(), "control-plane-engineering-auth-"));
  const publicDir = join(root, "public");
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, "index.html"), "public");
  let called = false;
  const service = {
    assessEngineeringRequest: async () => { called = true; return {}; },
  } as unknown as ControlPlaneService;
  const store = {
    backend: "sqlite",
    healthCheck: async () => ({ ok: true, backend: "sqlite", migrationsCurrent: true }),
  } as unknown as ControlPlaneStore;
  const server = createControlPlaneServer(service, store, publicDir);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/engineering/assessments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "ovalo", request: "Implement a bounded parser." }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json() as any).error, /bearer authentication/);
    assert.equal(called, false);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated production connector routes expose only bounded service operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "control-plane-production-api-"));
  const publicDir = join(root, "public");
  mkdirSync(publicDir);
  const calls: Record<string, unknown[]> = {
    deadList: [], deadReplay: [], github: [], linear: [], linearIssue: [], plans: [], gets: [], resolves: [], reconciles: [],
  };
  const service = {
    connectorStatus: async () => ({ enabled: false, externalEffects: { branchPublication: false, merge: false, deployment: false } }),
    listConnectorDeadLetters: async (limit?: number) => { calls.deadList.push(limit); return [{ outboxId: "outbox_1", state: "dead" }]; },
    replayConnectorDeadLetter: async (outboxId: string, resolvedBy: string) => { calls.deadReplay.push({ outboxId, resolvedBy }); return { outboxId, state: "pending" }; },
    prepareGithubDraftPr: async (input: unknown) => { calls.github.push(input); return { id: "plan_github" }; },
    prepareLinearEvidenceComment: async (input: unknown) => { calls.linear.push(input); return { id: "plan_linear" }; },
    prepareLinearIssue: async (input: unknown) => { calls.linearIssue.push(input); return { id: "plan_linear_issue" }; },
    listExternalActionPlans: async (input: unknown) => { calls.plans.push(input); return [{ id: "plan_github" }]; },
    getExternalActionPlan: async (planId: string) => { calls.gets.push(planId); return { id: planId }; },
    resolveExternalActionPlan: async (planId: string, decision: string, resolvedBy: string, idempotencyKey?: string) => {
      calls.resolves.push({ planId, decision, resolvedBy, idempotencyKey });
      return { id: planId, state: decision === "approve" ? "authorized" : "denied" };
    },
    reconcileExternalActionPlan: async (planId: string, input: unknown, operatorId: string) => {
      calls.reconciles.push({ planId, input, operatorId });
      return { id: planId, state: "succeeded" };
    },
  } as unknown as ControlPlaneService;
  const store = {
    backend: "sqlite",
    healthCheck: async () => ({ ok: true, backend: "sqlite", migrationsCurrent: true }),
  } as unknown as ControlPlaneStore;
  const server = createControlPlaneServer(service, store, publicDir, {
    authToken: token,
    operatorId: "wesley-local-operator",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}` };
  const json = () => ({ ...auth, "content-type": "application/json", });
  try {
    assert.equal((await fetch(`${base}/api/connectors/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/connectors/status`, { headers: auth })).status, 200);

    const dead = await fetch(`${base}/api/connectors/outbox/dead?limit=2`, { headers: auth });
    assert.equal(dead.status, 200);
    assert.deepEqual(calls.deadList, [2]);
    const replay = await fetch(`${base}/api/connectors/outbox/dead/outbox_1`, {
      method: "POST", headers: json(), body: "{}",
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(calls.deadReplay, [{ outboxId: "outbox_1", resolvedBy: "wesley-local-operator" }]);

    const github = await fetch(`${base}/api/external-actions/github-draft-pr`, {
      method: "POST", headers: json(),
      body: JSON.stringify({ runId: "run_1", title: "Title", body: "Body", idempotencyKey: "retry_1" }),
    });
    assert.equal(github.status, 201);
    assert.deepEqual(calls.github, [{ runId: "run_1", title: "Title", body: "Body", idempotencyKey: "retry_1" }]);
    const targetInjection = await fetch(`${base}/api/external-actions/github-draft-pr`, {
      method: "POST", headers: json(),
      body: JSON.stringify({ runId: "run_1", title: "Title", body: "Body", owner: "attacker" }),
    });
    assert.equal(targetInjection.status, 400);
    assert.equal(calls.github.length, 1);

    const linear = await fetch(`${base}/api/external-actions/linear-evidence-comment`, {
      method: "POST", headers: json(), body: JSON.stringify({ runId: "run_1", body: "Evidence" }),
    });
    assert.equal(linear.status, 201);
    assert.deepEqual(calls.linear, [{ runId: "run_1", body: "Evidence" }]);
    const linearIssue = await fetch(`${base}/api/external-actions/linear-issue`, {
      method: "POST", headers: json(),
      body: JSON.stringify({ runId: "run_1", title: "Bounded issue", description: "Evidence-bound description", idempotencyKey: "issue_retry_1" }),
    });
    assert.equal(linearIssue.status, 201);
    assert.deepEqual(calls.linearIssue, [{
      runId: "run_1", title: "Bounded issue", description: "Evidence-bound description", idempotencyKey: "issue_retry_1",
    }]);
    const linearTargetInjection = await fetch(`${base}/api/external-actions/linear-issue`, {
      method: "POST", headers: json(),
      body: JSON.stringify({ runId: "run_1", title: "Bounded issue", description: "Evidence", teamId: "attacker" }),
    });
    assert.equal(linearTargetInjection.status, 400);
    assert.equal(calls.linearIssue.length, 1);
    const plans = await fetch(`${base}/api/external-actions?projectId=project_1&state=pending_approval&limit=3`, { headers: auth });
    assert.equal(plans.status, 200);
    assert.deepEqual(calls.plans, [{ projectId: "project_1", state: "pending_approval", limit: 3 }]);
    const plan = await fetch(`${base}/api/external-actions/plan_github`, { headers: auth });
    assert.equal(plan.status, 200);
    const resolved = await fetch(`${base}/api/external-actions/plan_github/resolve`, {
      method: "POST", headers: json(), body: JSON.stringify({ decision: "approve", idempotencyKey: "resolve_1" }),
    });
    assert.equal(resolved.status, 200);
    const reconciled = await fetch(`${base}/api/external-actions/plan_github/reconcile`, {
      method: "POST", headers: json(), body: JSON.stringify({
        outcome: "one",
        matchCount: 1,
        externalId: "pr_42",
        externalRevision: "revision_42",
        payloadHash: "a".repeat(64),
        observedAt: "2026-08-13T10:00:00.000Z",
      }),
    });
    assert.equal(reconciled.status, 200);
    const targetInjectionReconcile = await fetch(`${base}/api/external-actions/plan_github/reconcile`, {
      method: "POST", headers: json(), body: JSON.stringify({ outcome: "zero", repository: "attacker/repo" }),
    });
    assert.equal(targetInjectionReconcile.status, 400);
    assert.deepEqual(calls.gets, ["plan_github"]);
    assert.deepEqual(calls.resolves, [{ planId: "plan_github", decision: "approve", resolvedBy: "wesley-local-operator", idempotencyKey: "resolve_1" }]);
    assert.deepEqual(calls.reconciles, [{
      planId: "plan_github",
      input: {
        outcome: "one",
        matchCount: 1,
        externalId: "pr_42",
        externalRevision: "revision_42",
        payloadHash: "a".repeat(64),
        observedAt: "2026-08-13T10:00:00.000Z",
      },
      operatorId: "wesley-local-operator",
    }]);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});
