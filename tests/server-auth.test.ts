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
  const service = {
    portfolio: async () => ({ projects: [] }),
    runtimeStatus: async () => [{ runtime: "atomic", adapter: "mock", available: true }],
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
  } as unknown as ControlPlaneService;
  const store = {
    backend: "sqlite",
    healthCheck: async () => ({ ok: true, backend: "sqlite", migrationsCurrent: true }),
  } as unknown as ControlPlaneStore;
  const server = createControlPlaneServer(service, store, publicDir, { authToken: token });
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

    const runtimes = await fetch(`${base}/api/runtimes`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(runtimes.status, 200);
    assert.equal((await runtimes.json())[0].runtime, "atomic");

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
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});
