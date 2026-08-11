import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isLoopbackHost, loadControlPlaneAuth } from "./auth.ts";

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
  authToken?: string;
  runtimeAdapters: {
    atomic: RuntimeAdapterMode;
    codex: RuntimeAdapterMode;
    claude: RuntimeAdapterMode;
  };
  atomicCommand: string;
  atomicExpectedVersion: string;
  atomicPackageDir: string;
  atomicRuntimeEnvAllowlist: string[];
  codexCommand: string;
  codexExpectedVersion: string;
  codexRuntimeEnvAllowlist: string[];
  claudeCommand: string;
  claudeExpectedVersion: string;
  claudeRuntimeEnvAllowlist: string[];
}

export type RuntimeAdapterMode = "mock" | "native";

function booleanFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean value`);
}

function adapterMode(name: string): RuntimeAdapterMode {
  const value = (process.env[name] ?? "mock").trim().toLowerCase();
  if (value === "mock" || value === "native") return value;
  throw new Error(`${name} must be either mock or native`);
}

function envAllowlist(name: string): string[] {
  const value = process.env[name] ?? "";
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const item of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(item)) throw new Error(`${name} contains an invalid environment variable name`);
  }
  return [...new Set(names)];
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
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const runtimeAdapters = {
    atomic: adapterMode("ATOMIC_ADAPTER"),
    codex: adapterMode("CODEX_ADAPTER"),
    claude: adapterMode("CLAUDE_ADAPTER"),
  };
  const auth = loadControlPlaneAuth();
  if (!auth && Object.values(runtimeAdapters).includes("native")) {
    throw new Error("Control-plane bearer authentication is required when any native runtime adapter is enabled");
  }
  if (!auth && !isLoopbackHost(host)) {
    throw new Error("Control-plane bearer authentication is required for a non-loopback HOST binding");
  }

  return {
    host,
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
    authToken: auth?.token,
    runtimeAdapters,
    atomicCommand: process.env.ATOMIC_COMMAND?.trim() || "atomic",
    atomicExpectedVersion: process.env.ATOMIC_EXPECTED_VERSION?.trim() || "0.9.12",
    atomicPackageDir: resolve(process.env.ATOMIC_PACKAGE_DIR ?? "./packages/atomic-workflow-architect"),
    atomicRuntimeEnvAllowlist: envAllowlist("ATOMIC_RUNTIME_ENV_ALLOWLIST"),
    codexCommand: process.env.CODEX_COMMAND?.trim() || "codex",
    codexExpectedVersion: process.env.CODEX_EXPECTED_VERSION?.trim() || "0.147.0-alpha.6.5",
    codexRuntimeEnvAllowlist: envAllowlist("CODEX_RUNTIME_ENV_ALLOWLIST"),
    claudeCommand: process.env.CLAUDE_COMMAND?.trim() || "claude",
    claudeExpectedVersion: process.env.CLAUDE_EXPECTED_VERSION?.trim() || "2.1.81",
    claudeRuntimeEnvAllowlist: envAllowlist("CLAUDE_RUNTIME_ENV_ALLOWLIST"),
  };
}

export function loadProjectSeed(): Array<Record<string, unknown>> {
  const path = resolve("./config/projects.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
