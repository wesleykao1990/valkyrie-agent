import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  projectBrainDir: string;
  stageDelayMs: number;
  defaultRuntime: string;
  storeBackend: "sqlite" | "postgres";
  databaseUrl?: string;
  postgresAutoMigrate: boolean;
  seedDemoData: boolean;
  enableDemoReset: boolean;
}

function booleanFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean value`);
}

export function loadConfig(): AppConfig {
  const backend = (process.env.CONTROL_PLANE_STORE ?? "sqlite").trim().toLowerCase();
  if (backend !== "sqlite" && backend !== "postgres") {
    throw new Error("CONTROL_PLANE_STORE must be either sqlite or postgres");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (backend === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when CONTROL_PLANE_STORE=postgres");
  }
  const sqliteDemo = backend === "sqlite";

  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? "8787"),
    dataDir: resolve(process.env.DATA_DIR ?? "./data"),
    projectBrainDir: resolve(process.env.PROJECT_BRAIN_DIR ?? "./project-brain"),
    stageDelayMs: Number(process.env.DEMO_STAGE_DELAY_MS ?? "1200"),
    defaultRuntime: process.env.DEFAULT_RUNTIME ?? "atomic",
    storeBackend: backend,
    databaseUrl,
    postgresAutoMigrate: booleanFlag("POSTGRES_AUTO_MIGRATE", false),
    seedDemoData: sqliteDemo && booleanFlag("SEED_DEMO_DATA", true),
    enableDemoReset: sqliteDemo && booleanFlag("ENABLE_DEMO_RESET", true),
  };
}

export function loadProjectSeed(): Array<Record<string, unknown>> {
  const path = resolve("./config/projects.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
