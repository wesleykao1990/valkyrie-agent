import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
  atomicFixturePilot: AtomicFixturePilotConfig;
}

export interface AtomicFixturePilotConfig {
  enabled: boolean;
  repositoryPath?: string;
  engineCommand?: string;
  engineSocket?: string;
  image?: string;
  root: string;
  user?: string;
  maxCostUsd: number;
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

function positiveNumber(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be greater than zero and at most ${maximum}`);
  }
  return value;
}

function optionalAbsolutePath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
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
  const enableDemoReset = sqliteDemo && booleanFlag("ENABLE_DEMO_RESET", true);
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const runtimeAdapters = {
    atomic: adapterMode("ATOMIC_ADAPTER"),
    codex: adapterMode("CODEX_ADAPTER"),
    claude: adapterMode("CLAUDE_ADAPTER"),
  };
  const atomicFixturePilotEnabled = booleanFlag("ATOMIC_FIXTURE_PILOT_ENABLED", false);
  const auth = loadControlPlaneAuth();
  if (!auth && (Object.values(runtimeAdapters).includes("native") || atomicFixturePilotEnabled)) {
    throw new Error("Control-plane bearer authentication is required when a native runtime or the Atomic fixture pilot is enabled");
  }
  if (!auth && !isLoopbackHost(host)) {
    throw new Error("Control-plane bearer authentication is required for a non-loopback HOST binding");
  }

  const atomicFixturePilot: AtomicFixturePilotConfig = {
    enabled: atomicFixturePilotEnabled,
    repositoryPath: optionalAbsolutePath("ATOMIC_FIXTURE_PILOT_REPOSITORY"),
    engineCommand: optionalAbsolutePath("ATOMIC_FIXTURE_PILOT_ENGINE"),
    engineSocket: process.env.ATOMIC_FIXTURE_PILOT_ENGINE_SOCKET?.trim() || undefined,
    image: process.env.ATOMIC_FIXTURE_PILOT_IMAGE?.trim() || undefined,
    root: resolve(process.env.ATOMIC_FIXTURE_PILOT_ROOT ?? "./data/atomic-fixture-pilot"),
    user: process.env.ATOMIC_FIXTURE_PILOT_USER?.trim() || undefined,
    maxCostUsd: positiveNumber("ATOMIC_FIXTURE_PILOT_MAX_COST_USD", 1, 5),
  };
  if (atomicFixturePilot.enabled) {
    if (!atomicFixturePilot.repositoryPath) throw new Error("ATOMIC_FIXTURE_PILOT_REPOSITORY is required when the Atomic fixture pilot is enabled");
    if (!atomicFixturePilot.engineCommand) throw new Error("ATOMIC_FIXTURE_PILOT_ENGINE is required when the Atomic fixture pilot is enabled");
    if (!atomicFixturePilot.image) throw new Error("ATOMIC_FIXTURE_PILOT_IMAGE is required when the Atomic fixture pilot is enabled");
    if (!isAbsolute(process.env.ATOMIC_FIXTURE_PILOT_ROOT ?? "")) {
      throw new Error("ATOMIC_FIXTURE_PILOT_ROOT must be an explicit absolute path when the pilot is enabled");
    }
    if (enableDemoReset) {
      throw new Error("ENABLE_DEMO_RESET must be false when the Atomic fixture pilot is enabled");
    }
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
    enableDemoReset,
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
    atomicFixturePilot,
  };
}

export function loadProjectSeed(): Array<Record<string, unknown>> {
  const path = resolve("./config/projects.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
