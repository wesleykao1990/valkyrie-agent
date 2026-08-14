import { join, resolve } from "node:path";
import { createControlPlaneStore } from "../apps/control-plane/src/store-factory.ts";

const configuredBackend = process.env.CONTROL_PLANE_STORE ?? "sqlite";
if (configuredBackend !== "sqlite" && configuredBackend !== "postgres") {
  throw new Error(`Invalid CONTROL_PLANE_STORE value: ${configuredBackend}. Expected sqlite or postgres.`);
}
const backend = configuredBackend;
const store = backend === "postgres"
  ? await createControlPlaneStore({
      backend,
      databaseUrl: process.env.DATABASE_URL ?? "",
      autoMigrate: true,
      ssl: process.env.POSTGRES_SSL === "require" ? { rejectUnauthorized: true } : undefined,
    })
  : await createControlPlaneStore({
      backend,
      sqlitePath: join(resolve(process.env.DATA_DIR ?? "./data"), "control-plane.sqlite"),
    });

try {
  const results = await store.migrate();
  for (const item of results) {
    console.log(`${backend} migration ${item.version} ${item.name}: ${item.status} (${item.checksum.slice(0, 12)})`);
  }
  const health = await store.healthCheck();
  if (!health.ok || !health.migrationsCurrent) throw new Error(`${backend} migration verification failed`);
} finally {
  await store.close();
}
