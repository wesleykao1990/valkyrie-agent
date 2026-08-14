import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AtomicConnectivityRuntimeAdapter, validateAtomicLaunchManifest, validateAtomicModelLaunchManifest } from "../apps/control-plane/src/atomic-runtime-adapter.ts";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import type { Run } from "../apps/control-plane/src/types.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";

const fakeAtomic = resolve("scripts/fake-atomic-rpc.ts");
const atomicPackage = resolve("packages/atomic-workflow-architect");

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("Atomic native adapter performs credential-free package/RPC discovery without model execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-atomic-native-"));
  const store = new SqliteStore(join(root, "store.sqlite"));
  const previousAllowlist = process.env.ATOMIC_RUNTIME_ENV_ALLOWLIST;
  const previousSecret = process.env.ATOMIC_TEST_SECRET;
  process.env.ATOMIC_RUNTIME_ENV_ALLOWLIST = "ATOMIC_TEST_SECRET";
  process.env.ATOMIC_TEST_SECRET = "must-not-reach-atomic";
  await store.seedProjects([{
    id: "fixture", name: "Fixture", objective: "Atomic boundary", currentMilestone: "Pilot", health: "on_track",
    linearTeam: "FIX", repository: "fixture/repo", vaultPath: "Projects/Fixture", memoryNamespace: "projects/fixture",
  }]);
  const project = await store.getProject("fixture");
  assert.ok(project);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const run: Run = {
    id: "run-atomic-connectivity", projectId: "fixture", rootRuntime: "atomic", workflow: "runtime-connectivity",
    status: "queued", stage: null, stageIndex: 0, budgetUsd: 1, costUsd: 0,
    workspaceId: null, nativeRunId: null, nextActionAt: null, startedAt: null, completedAt: null,
    metadata: { requestedObjective: "Discover the pinned Atomic package" }, createdAt: new Date().toISOString(),
  };
  const prepared = workspaces.prepare(run.id, project);
  run.workspaceId = prepared.workspaceId;
  const created = await store.createRunBundle({ run, workspace: prepared.workspace, lease: prepared.lease });
  assert.ok(created.lease);
  const controlDir = join(prepared.path, ".control-plane");
  mkdirSync(controlDir, { recursive: true });
  const contextBody = JSON.stringify({ runId: run.id, acceptedDecisions: [] });
  const contractBody = JSON.stringify({ runId: run.id, finalAction: "analysis_only" });
  const contextPath = join(controlDir, "context-pack.json");
  const contractPath = join(controlDir, "run-contract.json");
  writeFileSync(contextPath, contextBody, "utf8");
  writeFileSync(contractPath, contractBody, "utf8");
  const adapter = new AtomicConnectivityRuntimeAdapter({
    command: process.execPath,
    commandPrefixArgs: ["--experimental-strip-types", fakeAtomic],
    expectedVersion: "0.9.12-fake",
    packageDir: atomicPackage,
    dataDir: join(root, "runtime-data"),
    artifactRoot: join(root, "artifacts"),
    store,
    workspaces,
    requestTimeoutMs: 2_000,
  });

  try {
    const preflight = await adapter.preflight();
    assert.equal(preflight.available, true);
    assert.equal(preflight.authenticated, "unknown");
    assert.match(preflight.reason ?? "", /discovery only/);

    const runtimeContext = {
      run: created.run,
      objective: "Discover the pinned Atomic package",
      workspacePath: prepared.path,
      workspace: created.workspace,
      writerLease: created.lease,
      contextPack: { path: contextPath, uri: contextPath, checksum: sha(contextBody) },
      runContract: { path: contractPath, uri: contractPath, checksum: sha(contractBody) },
      finalAction: "analysis_only" as const,
    };
    await assert.rejects(adapter.start({
      ...runtimeContext,
      writerLease: { ...created.lease, fencingToken: created.lease.fencingToken + 1 },
    }), /exact writer lease owner and fence/);
    const native = await adapter.start(runtimeContext);
    assert.equal(native.nativeSessionId, "fake-main-session");
    assert.equal(native.metadata?.crossProcessResume, false);
    const terminal = await store.getRun(run.id);
    assert.equal(terminal?.status, "completed");
    assert.equal(terminal?.metadata.modelExecutionAttempted, false);
    assert.equal(terminal?.metadata.atomicWorkflowDiscovery, "request-preflight");
    assert.equal((await store.listLeases()).length, 0);
    const events = await store.listEvents(run.id);
    const raw = events.filter((event) => event.type === "runtime.native");
    assert.ok(raw.length >= 6);
    assert.ok(raw.some((event) => JSON.stringify(event.payload.rawNative).includes("native-entry-1")));
    const state = raw.find((event) => (event.payload.rawNative as any).command === "get_state");
    assert.equal((state?.payload.rawNative as any).data.offline, "1");
    assert.equal((state?.payload.rawNative as any).data.leakedSecret, null);
    assert.equal((state?.payload.rawNative as any).data.projectTrustArg, "--no-approve");
    const artifacts = await store.listArtifacts(run.id);
    assert.ok(artifacts.some((artifact) => artifact.kind === "atomic-connectivity"));
    const launchArtifact = artifacts.find((artifact) => artifact.kind === "atomic-launch-manifest");
    assert.ok(launchArtifact);
    const launch = JSON.parse(readFileSync(launchArtifact.uri, "utf8"));
    assert.equal(launch.schema_version, "1.1.0");
    assert.equal(launch.run_id, run.id);
    assert.equal(launch.root_runtime, "atomic");
    assert.equal(launch.workflow.name, "request-preflight");
    assert.equal(launch.crossProcessResume, false);
    assert.equal(launch.final_action, "analysis_only");
    assert.equal(launch.writer_lease.holder_run_id, run.id);
    assert.equal(launch.writer_lease.owner_id, created.lease.ownerId);
    assert.equal(launch.writer_lease.fencing_token, created.lease.fencingToken);
  } finally {
    if (previousAllowlist === undefined) delete process.env.ATOMIC_RUNTIME_ENV_ALLOWLIST;
    else process.env.ATOMIC_RUNTIME_ENV_ALLOWLIST = previousAllowlist;
    if (previousSecret === undefined) delete process.env.ATOMIC_TEST_SECRET;
    else process.env.ATOMIC_TEST_SECRET = previousSecret;
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atomic launch-manifest validation rejects values outside the imported schema", () => {
  assert.ok(validateAtomicLaunchManifest({ root_runtime: "atomic" }, atomicPackage).some((error) => error.includes("missing run_id")));
  const template = JSON.parse(readFileSync(join(
    atomicPackage,
    "skills",
    "atomic-workflow-architect",
    "assets",
    "launch-manifest-template.json",
  ), "utf8"));
  const missingOwner = structuredClone(template);
  delete missingOwner.writer_lease.owner_id;
  assert.ok(validateAtomicLaunchManifest(missingOwner, atomicPackage).some((error) => error.includes("missing owner_id")));
  const staleFence = structuredClone(template);
  staleFence.writer_lease.fencing_token = 1.5;
  assert.ok(validateAtomicLaunchManifest(staleFence, atomicPackage).some((error) => error.includes("expected integer")));
  const unsafeFence = structuredClone(template);
  unsafeFence.writer_lease.fencing_token = Number.MAX_SAFE_INTEGER + 1;
  assert.ok(validateAtomicLaunchManifest(unsafeFence, atomicPackage).some((error) => error.includes("above maximum")));
});

test("Atomic model launch manifest rejects credentials, network widening, and repair expansion", () => {
  const packageDir = resolve("packages/atomic-workflow-architect");
  const template = JSON.parse(readFileSync(join(
    packageDir, "skills", "atomic-workflow-architect", "assets", "model-launch-manifest-template.json",
  ), "utf8"));
  assert.deepEqual(validateAtomicModelLaunchManifest(template, packageDir), []);
  for (const mutate of [
    (value: any) => { value.inference.credential_in_writer = true; },
    (value: any) => { value.inference.live_provider_verified = true; },
    (value: any) => { value.sandbox.network_policy = "public"; },
    (value: any) => { value.bounds.max_repairs = 2; },
    (value: any) => { value.inference.max_requests = 5; },
    (value: any) => { value.provider_api_key = "secret"; },
  ]) {
    const changed = structuredClone(template);
    mutate(changed);
    assert.ok(validateAtomicModelLaunchManifest(changed, packageDir).length > 0);
  }
});
