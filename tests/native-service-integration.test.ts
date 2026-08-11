import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DirectCliRuntimeAdapter } from "../apps/control-plane/src/direct-cli-runtimes.ts";
import { AtomicConnectivityRuntimeAdapter } from "../apps/control-plane/src/atomic-runtime-adapter.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { exactVersionPattern } from "../apps/control-plane/src/runtime-registry.ts";
import { ControlPlaneService } from "../apps/control-plane/src/service.ts";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import type { RuntimeAdapter } from "../apps/control-plane/src/runtime.ts";
import type { RuntimeName } from "../apps/control-plane/src/types.ts";

const fakeRuntime = resolve("scripts/fake-direct-runtime.ts");
const fakeAtomic = resolve("scripts/fake-atomic-rpc.ts");
const atomicPackage = resolve("packages/atomic-workflow-architect");

async function waitForTerminal(store: SqliteStore, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.getRun(runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${runId}`);
}

test("service creates governed context artifacts before a native connectivity run", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-native-service-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Fixture", "Decisions"), { recursive: true });
  writeFileSync(
    join(brainRoot, "Projects", "Fixture", "Decisions", "ADR-001.md"),
    "---\nid: ADR-001\ntype: decision\nstatus: accepted\nauthority: canonical\nproject: fixture\n---\n# Fixture boundary\n\nOnly bounded read-only connectivity is allowed.\n",
    "utf8",
  );
  const store = new SqliteStore(join(root, "store.sqlite"));
  await store.seedProjects([{
    id: "fixture",
    name: "Fixture",
    objective: "Exercise native service integration",
    currentMilestone: "Connectivity",
    health: "on_track",
    linearTeam: "FIX",
    repository: "fixture/repo",
    vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture",
  }]);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const adapter = new DirectCliRuntimeAdapter({
    name: "codex",
    command: process.execPath,
    commandPrefixArgs: ["--experimental-strip-types", fakeRuntime, "codex", "success"],
    expectedVersion: exactVersionPattern("codex", "0.147.0-alpha.6.5"),
    store,
    workspaces,
    artifactRoot: join(root, "artifacts"),
    startTimeoutMs: 2_000,
    stopTimeoutMs: 250,
  });
  const adapters = new Map<RuntimeName, RuntimeAdapter>([["codex", adapter]]);
  const service = new ControlPlaneService(store, new LocalProjectBrain(brainRoot), workspaces, adapters);

  try {
    await assert.rejects(
      service.startRun({
        projectId: "fixture",
        objective: "Inspect the host instead of performing a connectivity marker",
        runtime: "codex",
        workflow: "runtime-connectivity",
      }),
      /Return exactly MARKER/,
    );
    assert.equal((await store.listRuns()).length, 0);
    assert.equal((await store.listLeases()).length, 0);

    const started = await service.startRun({
      projectId: "fixture",
      objective: "Return exactly VALKYRIE_FIXTURE_OK and nothing else.",
      runtime: "codex",
      workflow: "runtime-connectivity",
      maxCostUsd: 1,
    });
    const runId = started.run.run.id;
    const terminal = await waitForTerminal(store, runId);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.metadata.adapter, "native");
    assert.equal(terminal.metadata.finalAction, "analysis_only");
    assert.equal(terminal.metadata.crossProcessResume, false);

    const artifacts = await store.listArtifacts(runId);
    const context = artifacts.find((artifact) => artifact.kind === "project-brain-context-pack");
    const contract = artifacts.find((artifact) => artifact.kind === "run-contract");
    assert.ok(context);
    assert.ok(contract);
    const contextBody = JSON.parse(readFileSync(context.uri, "utf8"));
    const contractBody = JSON.parse(readFileSync(contract.uri, "utf8"));
    assert.equal(contextBody.runId, runId);
    assert.equal(contextBody.automaticEpisodicCapture, false);
    assert.equal(contextBody.entries[0].title, "Fixture boundary");
    assert.equal(contractBody.runId, runId);
    assert.equal(contractBody.rootRuntime, "codex");
    assert.equal(contractBody.finalAction, "analysis_only");
    assert.equal(contractBody.writerLease.holderRunId, runId);
    assert.ok(artifacts.some((artifact) => artifact.kind === "native-result"));
    assert.equal((await store.listLeases()).length, 0);

    const events = await store.listEvents(runId);
    assert.ok(events.some((event) => event.type === "runtime.native"));
    assert.ok(events.some((event) => event.type === "run.completed"));
  } finally {
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("service refuses a symlinked native context directory before writing outside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-native-service-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "valkyrie-native-service-outside-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Fixture"), { recursive: true });
  const store = new SqliteStore(join(root, "store.sqlite"));
  await store.seedProjects([{
    id: "fixture",
    name: "Fixture",
    objective: "Reject workspace symlink escapes",
    currentMilestone: "Connectivity",
    health: "on_track",
    linearTeam: "FIX",
    repository: "fixture/repo",
    vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture",
  }]);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const originalPrepare = workspaces.prepare.bind(workspaces);
  workspaces.prepare = (runId, project) => {
    const prepared = originalPrepare(runId, project);
    symlinkSync(outside, join(prepared.path, ".control-plane"));
    return prepared;
  };
  let adapterStarted = false;
  const adapter = {
    name: "codex" as const,
    capabilities: () => ({ steer: false, pause: false, resume: false, approve: false, artifacts: true }),
    preflight: async () => ({
      runtime: "codex" as const,
      adapter: "native" as const,
      enabled: true,
      available: true,
      executionMode: "read-only" as const,
      authenticated: true,
      capabilities: { steer: false, pause: false, resume: false, approve: false, artifacts: true },
    }),
    start: async () => {
      adapterStarted = true;
      throw new Error("adapter must not start");
    },
    advance: async () => undefined,
    steer: async () => undefined,
    cancel: async () => undefined,
    resolveApproval: async () => undefined,
  } satisfies RuntimeAdapter;
  const service = new ControlPlaneService(
    store,
    new LocalProjectBrain(brainRoot),
    workspaces,
    new Map<RuntimeName, RuntimeAdapter>([["codex", adapter]]),
  );

  try {
    await assert.rejects(
      service.startRun({
        projectId: "fixture",
        objective: "Return exactly VALKYRIE_SYMLINK_OK and nothing else.",
        runtime: "codex",
        workflow: "runtime-connectivity",
      }),
      /context directory must be a regular non-symlink directory/,
    );
    assert.equal(adapterStarted, false);
    assert.equal(existsSync(join(outside, "context-pack.json")), false);
    assert.equal(existsSync(join(outside, "run-contract.json")), false);
    const [run] = await store.listRuns();
    assert.equal(run?.status, "failed");
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("service launches Atomic through the governed offline discovery boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-atomic-service-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Fixture"), { recursive: true });
  writeFileSync(
    join(brainRoot, "Projects", "Fixture", "Project.md"),
    "---\ntype: project\nstatus: accepted\nauthority: canonical\nproject: fixture\n---\n# Fixture project\n\nUse offline package discovery only.\n",
    "utf8",
  );
  const store = new SqliteStore(join(root, "store.sqlite"));
  await store.seedProjects([{
    id: "fixture",
    name: "Fixture",
    objective: "Exercise Atomic service integration",
    currentMilestone: "Connectivity",
    health: "on_track",
    linearTeam: "FIX",
    repository: "fixture/repo",
    vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture",
  }]);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const adapter = new AtomicConnectivityRuntimeAdapter({
    command: process.execPath,
    commandPrefixArgs: ["--experimental-strip-types", fakeAtomic],
    expectedVersion: "0.9.12-fake",
    packageDir: atomicPackage,
    dataDir: join(root, "runtime"),
    artifactRoot: join(root, "artifacts"),
    store,
    workspaces,
    requestTimeoutMs: 2_000,
  });
  const adapters = new Map<RuntimeName, RuntimeAdapter>([["atomic", adapter]]);
  const service = new ControlPlaneService(store, new LocalProjectBrain(brainRoot), workspaces, adapters);

  try {
    const started = await service.startRun({
      projectId: "fixture",
      objective: "Discover the pinned Atomic package without model execution",
      runtime: "atomic",
      workflow: "runtime-connectivity",
      maxCostUsd: 1,
    });
    const run = (await service.getRun(started.run.run.id)).run;
    assert.equal(run.status, "completed");
    assert.equal(run.metadata.modelExecutionAttempted, false);
    assert.equal(run.metadata.crossProcessResume, false);
    assert.equal(run.metadata.atomicWorkflowDiscovery, "request-preflight");
    const artifacts = await store.listArtifacts(run.id);
    assert.ok(artifacts.some((artifact) => artifact.kind === "project-brain-context-pack"));
    assert.ok(artifacts.some((artifact) => artifact.kind === "run-contract"));
    assert.ok(artifacts.some((artifact) => artifact.kind === "atomic-launch-manifest"));
    assert.ok(artifacts.some((artifact) => artifact.kind === "atomic-connectivity"));
    assert.ok((await store.listEvents(run.id)).some((event) => event.type === "runtime.native"));
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
