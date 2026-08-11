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
const service = new ControlPlaneService(store, brain, workspaces, adapters);
const [existingTasks, existingRuns] = await Promise.all([store.listTasks(), store.listRuns(1)]);
if (config.seedDemoData && existingTasks.length === 0 && existingRuns.length === 0) await service.resetDemo(true);
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
  void shutdownControlPlane(server, adapters.values(), store).then(
    () => process.exit(0),
    (error) => {
      console.error("control-plane shutdown failed", error);
      process.exit(1);
    },
  );
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
