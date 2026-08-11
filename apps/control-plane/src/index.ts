import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, loadProjectSeed } from "./config.ts";
import { SqliteStore } from "./store.ts";
import { LocalProjectBrain } from "./project-brain.ts";
import { WorkspaceManager } from "./workspace.ts";
import { createMockAdapters } from "./mock-runtimes.ts";
import { ControlPlaneService } from "./service.ts";
import { createControlPlaneServer } from "./server.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = new SqliteStore(join(config.dataDir, "control-plane.sqlite"));
store.seedProjects(loadProjectSeed());
if (store.listTasks().length === 0) {
  // Service is constructed below; seed immediately afterward.
}
const brain = new LocalProjectBrain(config.projectBrainDir);
const workspaces = new WorkspaceManager(store, join(config.dataDir, "workspaces"));
const adapters = createMockAdapters(store, workspaces, join(config.dataDir, "artifacts"), config.stageDelayMs);
const service = new ControlPlaneService(store, brain, workspaces, adapters);
if (store.listTasks().length === 0) service.resetDemo(true);

const publicDir = resolve("./apps/control-plane/public");
const server = createControlPlaneServer(service, store, publicDir);
const worker = setInterval(() => service.tick().catch((error) => console.error("worker tick failed", error)), 250);

server.listen(config.port, config.host, () => {
  console.log(`Wesley Agent Control Plane prototype listening on http://${config.host}:${config.port}`);
  console.log("Hermes remains the intended interface; this web page is a developer console.");
});

function shutdown() {
  clearInterval(worker);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
