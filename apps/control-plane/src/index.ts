import { mkdirSync, rmSync } from "node:fs";
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
  copyReviewedAtomicPackage,
} from "./atomic-fixture-pilot.ts";
import { setupAtomicFixtureRepository } from "../../../scripts/setup-atomic-fixture.ts";
import { AtomicModelPilotCoordinator } from "./atomic-model-pilot-coordinator.ts";
import { AtomicModelPilotLifecycleCoordinator } from "./atomic-model-pilot-lifecycle.ts";
import { buildScopedInferencePolicy, createConfiguredInferenceUpstream } from "./atomic-model-pilot-configured.ts";
import {
  ScopedInferenceGateway,
  createScopedInferenceGatewayServer,
  listenScopedInferenceGatewayUnix,
} from "./scoped-inference-gateway.ts";
import { DockerCliBridgeEngine, ScopedInferenceBridge } from "./scoped-inference-bridge.ts";

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
let atomicModelPilot: AtomicModelPilotLifecycleCoordinator | undefined;
let closeInferenceGateway: (() => Promise<void>) | undefined;
let fixtureRepositoryCommit: string | undefined;
let writerRootForPilots: string | undefined;
let artifactRootForPilots: string | undefined;
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
  fixtureRepositoryCommit = fixtureRepository.commit;
  writerRootForPilots = writerRoot;
  artifactRootForPilots = artifactRoot;
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

if (config.atomicFixtureModelPilot.enabled) {
  if (!fixtureRepositoryCommit || !writerRootForPilots || !artifactRootForPilots) {
    throw new Error("Atomic model pilot requires the initialized fixed fixture writer boundary");
  }
  const pilotRoot = config.atomicFixturePilot.root;
  const contextRoot = join(pilotRoot, "model-run-contexts");
  const providerStateRoot = join(pilotRoot, "model-oci-state");
  const gatewaySocketRoot = join(pilotRoot, "model-gateway-socket");
  for (const path of [contextRoot, providerStateRoot, gatewaySocketRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const modelProvider = new OciSandboxProvider({
    enabled: true,
    engineCommand: config.atomicFixturePilot.engineCommand!,
    ...(config.atomicFixturePilot.engineSocket ? { engineSocket: config.atomicFixturePilot.engineSocket } : {}),
    image: config.atomicFixturePilot.image!,
    workspaceRoot: writerRootForPilots,
    contextRoot,
    artifactRoot: artifactRootForPilots,
    stateRoot: providerStateRoot,
    networkPolicy: { mode: "named", name: config.atomicFixtureModelPilot.networkName!, internal: true },
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
      stagedAgentConfig: true,
      transportBounds: { sessionMs: 4 * 60_000, maxTransportBytes: 16 * 1024 * 1024 },
    },
  });
  const runner = await modelProvider.preflightAtomicRunner();
  if (!runner.available || runner.imageDigest !== config.atomicFixtureModelPilot.acceptedImageDigest) {
    throw new Error(`Atomic model pilot runner preflight failed: ${runner.reason ?? "accepted image mismatch"}`);
  }
  const packageProbe = join(contextRoot, "package-preflight");
  let packageDigest: string;
  try {
    packageDigest = copyReviewedAtomicPackage(config.atomicPackageDir, packageProbe).digest;
  } finally {
    rmSync(packageProbe, { recursive: true, force: true });
  }
  if (packageDigest !== config.atomicFixtureModelPilot.acceptedPackageSha256) {
    throw new Error("Atomic model pilot package does not match its accepted deployment digest");
  }
  const policy = buildScopedInferencePolicy(config.atomicFixtureModelPilot);
  const upstream = createConfiguredInferenceUpstream(config.atomicFixtureModelPilot);
  const gateway = new ScopedInferenceGateway(store, upstream, policy);
  const gatewayServer = createScopedInferenceGatewayServer(gateway);
  const socketPath = join(gatewaySocketRoot, "inference.sock");
  closeInferenceGateway = await listenScopedInferenceGatewayUnix(gatewayServer, socketPath);
  const bridgeUser = config.atomicFixturePilot.user
    ?? `${typeof process.getuid === "function" ? process.getuid() : 65532}:${typeof process.getgid === "function" ? process.getgid() : 65532}`;
  const bridge = new ScopedInferenceBridge({
    engine: new DockerCliBridgeEngine(
      config.atomicFixturePilot.engineCommand!,
      [],
      config.atomicFixturePilot.engineSocket,
    ),
    image: config.atomicFixturePilot.image!,
    networkName: config.atomicFixtureModelPilot.networkName!,
    socketPath,
    user: bridgeUser,
  });
  const reconciledBridges = await bridge.reconcileStartup();
  if (reconciledBridges > 0) console.log(`Atomic model startup removed ${reconciledBridges} exact orphan inference bridge(s)`);
  const writerWorkspaces = new WriterWorkspaceManager({
    store,
    root: writerRootForPilots,
    gitCommand: "/usr/bin/git",
    leaseTtlMs: 45_000,
  });
  const modelBoundary = new WriterSandboxBoundary({
    store,
    workspaces: writerWorkspaces,
    provider: modelProvider,
    artifactRoot: artifactRootForPilots,
    ownerId: "atomic_model_fixture_pilot",
    leaseTtlMs: 45_000,
    heartbeatIntervalMs: 5_000,
  });
  const executor = new AtomicModelPilotCoordinator({
    store,
    boundary: modelBoundary,
    provider: modelProvider,
    packageDir: config.atomicPackageDir,
    repositoryPath: config.atomicFixturePilot.repositoryPath!,
    repositoryCommit: fixtureRepositoryCommit,
    contextRoot,
    policy,
    gatewayBaseUrl: `http://valkyrie-inference:${config.atomicFixtureModelPilot.gatewayPort}/v1`,
    acceptedPackageSha256: config.atomicFixtureModelPilot.acceptedPackageSha256!,
    acceptedImageDigest: config.atomicFixtureModelPilot.acceptedImageDigest!,
    maxCostUsd: config.atomicFixtureModelPilot.maxCostUsd,
    liveProviderExpected: true,
    bridge,
  });
  atomicModelPilot = new AtomicModelPilotLifecycleCoordinator({
    store,
    brain,
    boundary: modelBoundary,
    executor,
    maxCostUsd: config.atomicFixtureModelPilot.maxCostUsd,
  });
}

const service = new ControlPlaneService(store, brain, workspaces, adapters, { atomicFixturePilot, atomicModelPilot });
const [existingTasks, existingRuns] = await Promise.all([store.listTasks(), store.listRuns(1)]);
if (config.seedDemoData && existingTasks.length === 0 && existingRuns.length === 0) await service.resetDemo(true);
if (atomicFixturePilot) await atomicFixturePilot.bootstrap();
if (atomicModelPilot) await atomicModelPilot.bootstrap();
const atomicFixtureReconciliation = atomicFixturePilot ? await atomicFixturePilot.reconcileStartup() : null;
if (atomicFixtureReconciliation && (
  atomicFixtureReconciliation.sandbox.instancesExamined > 0
  || atomicFixtureReconciliation.queuedScheduled > 0
  || atomicFixtureReconciliation.approvalsRecovered > 0
  || atomicFixtureReconciliation.expiredApprovals > 0
)) {
  console.log(`Atomic fixture startup reconciliation: ${JSON.stringify(atomicFixtureReconciliation)}`);
}
const atomicModelReconciliation = atomicModelPilot ? await atomicModelPilot.reconcileStartup() : null;
if (atomicModelReconciliation && (
  atomicModelReconciliation.sandbox.instancesExamined > 0
  || atomicModelReconciliation.queuedScheduled > 0
  || atomicModelReconciliation.approvalsRecovered > 0
  || atomicModelReconciliation.expiredApprovals > 0
  || atomicModelReconciliation.capabilitiesExpired > 0
)) {
  console.log(`Atomic model startup reconciliation: ${JSON.stringify(atomicModelReconciliation)}`);
}
const reconciliation = await service.reconcileStartup();
if (Object.values(reconciliation).some((value) => value > 0)) {
  console.log(`startup reconciliation: ${JSON.stringify(reconciliation)}`);
}

const publicDir = resolve("./apps/control-plane/public");
const server = createControlPlaneServer(service, store, publicDir, {
  enableDemoReset: config.enableDemoReset,
  authToken: config.authToken,
  operatorId: config.operatorId,
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
    await atomicModelPilot?.shutdown();
    await closeInferenceGateway?.();
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
