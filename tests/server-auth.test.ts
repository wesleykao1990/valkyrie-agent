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
