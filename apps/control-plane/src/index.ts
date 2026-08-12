import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, loadProjectSeed } from "./config.ts";
import { createControlPlaneStore } from "./store-factory.ts";
import { LocalProjectBrain } from "./project-brain.ts";
import { WorkspaceManager } from "./workspace.ts";
import { createRuntimeAdapters } from "./runtime-registry.ts";
import { ControlPlaneService } from "./service.ts";
import { createControlPlaneServer } from "./server.ts";
import { shutdownControlPlane } from "./shutdown.ts";
import { WriterWorkspaceManager } from "./writer-workspace.ts";
import { OciSandboxProvider } from "./oci-sandbox-provider.ts";
import { WriterSandboxBoundary } from "./writer-sandbox-boundary.ts";
import {
  ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS,
  ATOMIC_FIXTURE_RUNTIME_VERSION,
  AtomicFixturePilotCoordinator,
} from "./atomic-fixture-pilot.ts";
import { setupAtomicFixtureRepository } from "../../../scripts/setup-atomic-fixture.ts";

// Local databases, context packs, contracts, and native output are sensitive.
// New POSIX files/directories created by the server must be owner-only.
if (process.platform !== "win32") process.umask(0o077);

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = await createControlPlaneStore(config.storeBackend === "sqlite"
  ? { backend: "sqlite", sqlitePath: join(config.dataDir, "control-plane.sqlite") }
  : {
      backend: "postgres",
      databaseUrl: config.databaseUrl!,
      autoMigrate: config.postgresAutoMigrate,
    });
const migrations = config.storeBackend === "sqlite" || config.postgresAutoMigrate
  ? await store.migrate()
  : [];
for (const migration of migrations) {
  console.log(`storage migration ${migration.version} ${migration.name}: ${migration.status}`);
}
const health = await store.healthCheck();
if (!health.ok || !health.migrationsCurrent) {
  await store.close();
  throw new Error(`${health.backend} storage is unavailable or migrations are not current`);
}
if (config.seedDemoData) await store.seedProjects(loadProjectSeed());
const brain = new LocalProjectBrain(config.projectBrainDir);
const workspaces = new WorkspaceManager(store, join(config.dataDir, "workspaces"));
const adapters = createRuntimeAdapters(store, workspaces, config);
let atomicFixturePilot: AtomicFixturePilotCoordinator | undefined;
if (config.atomicFixturePilot.enabled) {
  const pilotRoot = config.atomicFixturePilot.root;
  const writerRoot = join(pilotRoot, "writer-workspaces");
  const contextRoot = join(pilotRoot, "run-contexts");
  const artifactRoot = join(pilotRoot, "artifacts");
  const providerStateRoot = join(pilotRoot, "oci-state");
  for (const path of [pilotRoot, writerRoot, contextRoot, artifactRoot, providerStateRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const fixtureRepository = setupAtomicFixtureRepository(config.atomicFixturePilot.repositoryPath!);
  const writerWorkspaces = new WriterWorkspaceManager({
    store,
    root: writerRoot,
    gitCommand: "/usr/bin/git",
    leaseTtlMs: 45_000,
  });
  const provider = new OciSandboxProvider({
    enabled: true,
    engineCommand: config.atomicFixturePilot.engineCommand!,
    ...(config.atomicFixturePilot.engineSocket ? { engineSocket: config.atomicFixturePilot.engineSocket } : {}),
    image: config.atomicFixturePilot.image!,
    workspaceRoot: writerRoot,
    contextRoot,
    artifactRoot,
    stateRoot: providerStateRoot,
    networkPolicy: { mode: "none" },
    resourceBounds: {
      memoryBytes: 2 * 1024 * 1024 * 1024,
      cpus: 2,
      pidsLimit: 256,
      tmpfsBytes: 128 * 1024 * 1024,
    },
    ...(config.atomicFixturePilot.user ? { user: config.atomicFixturePilot.user } : {}),
    atomicRpc: {
      reviewedBinaryPath: "/usr/local/bin/atomic",
      expectedVersion: ATOMIC_FIXTURE_RUNTIME_VERSION,
      reviewedImageLabels: ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS,
      transportBounds: { sessionMs: 3 * 60 * 1_000, maxTransportBytes: 16 * 1024 * 1024 },
    },
  });
  const boundary = new WriterSandboxBoundary({
    store,
    workspaces: writerWorkspaces,
    provider,
    artifactRoot,
    ownerId: "atomic_fixture_pilot",
    leaseTtlMs: 45_000,
    heartbeatIntervalMs: 5_000,
  });
  atomicFixturePilot = new AtomicFixturePilotCoordinator({
    store,
    brain,
    boundary,
    provider,
    packageDir: config.atomicPackageDir,
    repositoryPath: config.atomicFixturePilot.repositoryPath!,
    repositoryCommit: fixtureRepository.commit,
    contextRoot,
    maxCostUsd: config.atomicFixturePilot.maxCostUsd,
  });
}
const service = new ControlPlaneService(store, brain, workspaces, adapters, { atomicFixturePilot });
const [existingTasks, existingRuns] = await Promise.all([store.listTasks(), store.listRuns(1)]);
if (config.seedDemoData && existingTasks.length === 0 && existingRuns.length === 0) await service.resetDemo(true);
if (atomicFixturePilot) await atomicFixturePilot.bootstrap();
const atomicFixtureReconciliation = atomicFixturePilot ? await atomicFixturePilot.reconcileStartup() : null;
if (atomicFixtureReconciliation && (
  atomicFixtureReconciliation.sandbox.instancesExamined > 0
  || atomicFixtureReconciliation.queuedScheduled > 0
  || atomicFixtureReconciliation.approvalsRecovered > 0
  || atomicFixtureReconciliation.expiredApprovals > 0
)) {
  console.log(`Atomic fixture startup reconciliation: ${JSON.stringify(atomicFixtureReconciliation)}`);
}
const reconciliation = await service.reconcileStartup();
if (Object.values(reconciliation).some((value) => value > 0)) {
  console.log(`startup reconciliation: ${JSON.stringify(reconciliation)}`);
}

const publicDir = resolve("./apps/control-plane/public");
const server = createControlPlaneServer(service, store, publicDir, {
  enableDemoReset: config.enableDemoReset,
  authToken: config.authToken,
});
const worker = setInterval(() => { void service.tick().catch((error) => console.error("worker tick failed", error)); }, 250);

server.listen(config.port, config.host, () => {
  console.log(`Wesley Agent Control Plane prototype listening on http://${config.host}:${config.port}`);
  console.log("Hermes remains the intended interface; this web page is a developer console.");
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(worker);
  void (async () => {
    await atomicFixturePilot?.shutdown();
    await shutdownControlPlane(server, adapters.values(), store);
  })().then(
    () => process.exit(0),
    (error) => {
      console.error("control-plane shutdown failed", error);
      process.exit(1);
    },
  );
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
