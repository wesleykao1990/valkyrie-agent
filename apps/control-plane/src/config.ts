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
  atomicFixtureModelPilot: AtomicFixtureModelPilotConfig;
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

export interface AtomicFixtureModelPilotConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  upstreamBaseUrl?: string;
  credentialFile?: string;
  credentialHeader: "bearer" | "x-api-key";
  allowCredentialFreeLoopback: boolean;
  gatewayPort: number;
  acceptedPackageSha256?: string;
  acceptedImageDigest?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
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

function safeModelId(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error(`${name} must be a safe provider/model ID`);
  return value;
}

function optionalSha256(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function credentialHeader(name: string): "bearer" | "x-api-key" {
  const value = (process.env[name] ?? "bearer").trim().toLowerCase();
  if (value !== "bearer" && value !== "x-api-key") throw new Error(`${name} must be bearer or x-api-key`);
  return value;
}

function nonnegativeNumber(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${name} must be nonnegative and at most ${maximum}`);
  return value;
}

function modelUpstreamBaseUrl(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid provider base URL`); }
  const loopback = isLoopbackHost(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
      || parsed.username || parsed.password || parsed.pathname !== "/v1" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTPS /v1 provider URL or an HTTP loopback /v1 URL without credentials, query, or fragment`);
  }
  return parsed.href.replace(/\/$/, "");
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
  const atomicFixtureModelPilotEnabled = booleanFlag("ATOMIC_FIXTURE_MODEL_PILOT_ENABLED", false);
  const auth = loadControlPlaneAuth();
  if (!auth && (Object.values(runtimeAdapters).includes("native") || atomicFixturePilotEnabled || atomicFixtureModelPilotEnabled)) {
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

  const atomicFixtureModelPilot: AtomicFixtureModelPilotConfig = {
    enabled: atomicFixtureModelPilotEnabled,
    provider: safeModelId("ATOMIC_FIXTURE_MODEL_PROVIDER"),
    model: safeModelId("ATOMIC_FIXTURE_MODEL_ID"),
    upstreamBaseUrl: modelUpstreamBaseUrl("ATOMIC_FIXTURE_MODEL_UPSTREAM_BASE_URL"),
    credentialFile: optionalAbsolutePath("ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE"),
    credentialHeader: credentialHeader("ATOMIC_FIXTURE_MODEL_CREDENTIAL_HEADER"),
    allowCredentialFreeLoopback: booleanFlag("ATOMIC_FIXTURE_MODEL_ALLOW_CREDENTIAL_FREE_LOOPBACK", false),
    gatewayPort: positiveNumber("ATOMIC_FIXTURE_MODEL_GATEWAY_PORT", 8790, 65_535),
    acceptedPackageSha256: optionalSha256("ATOMIC_FIXTURE_MODEL_ACCEPTED_PACKAGE_SHA256"),
    acceptedImageDigest: process.env.ATOMIC_FIXTURE_MODEL_ACCEPTED_IMAGE_DIGEST?.trim() || undefined,
    maxInputTokens: positiveNumber("ATOMIC_FIXTURE_MODEL_MAX_INPUT_TOKENS", 32_000, 128_000),
    maxOutputTokens: positiveNumber("ATOMIC_FIXTURE_MODEL_MAX_OUTPUT_TOKENS", 8_000, 32_768),
    maxCostUsd: positiveNumber("ATOMIC_FIXTURE_MODEL_MAX_COST_USD", 1, 5),
    inputCostMicrosPerMillion: nonnegativeNumber("ATOMIC_FIXTURE_MODEL_INPUT_COST_MICROS_PER_MILLION", 0, 100_000_000),
    outputCostMicrosPerMillion: nonnegativeNumber("ATOMIC_FIXTURE_MODEL_OUTPUT_COST_MICROS_PER_MILLION", 0, 100_000_000),
  };
  if (atomicFixtureModelPilot.enabled) {
    if (!atomicFixturePilot.enabled) throw new Error("ATOMIC_FIXTURE_MODEL_PILOT_ENABLED requires the isolated Atomic fixture pilot boundary");
    if (!atomicFixtureModelPilot.provider || !atomicFixtureModelPilot.model || !atomicFixtureModelPilot.upstreamBaseUrl) {
      throw new Error("The Atomic model pilot requires an explicit provider, model, and upstream base URL");
    }
    const upstream = new URL(atomicFixtureModelPilot.upstreamBaseUrl);
    const credentialFreeLoopback = isLoopbackHost(upstream.hostname) && atomicFixtureModelPilot.allowCredentialFreeLoopback;
    if (!atomicFixtureModelPilot.credentialFile
        && !credentialFreeLoopback) {
      throw new Error("The Atomic model pilot requires a private credential file unless an explicit credential-free loopback provider is selected");
    }
    if (!credentialFreeLoopback
        && (process.env.ATOMIC_FIXTURE_MODEL_INPUT_COST_MICROS_PER_MILLION === undefined
          || process.env.ATOMIC_FIXTURE_MODEL_OUTPUT_COST_MICROS_PER_MILLION === undefined)) {
      throw new Error("External Atomic model pilots require explicit input/output provider prices for budget accounting");
    }
    if (!atomicFixtureModelPilot.acceptedPackageSha256 || !atomicFixtureModelPilot.acceptedImageDigest
        || !/^sha256:[a-f0-9]{64}$/.test(atomicFixtureModelPilot.acceptedImageDigest)) {
      throw new Error("The Atomic model pilot requires accepted package and immutable image digests");
    }
    if (atomicFixturePilot.image !== atomicFixtureModelPilot.acceptedImageDigest
        && !atomicFixturePilot.image?.endsWith(`@${atomicFixtureModelPilot.acceptedImageDigest}`)) {
      throw new Error("The Atomic model pilot accepted image digest must match the configured runner image");
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
    atomicFixtureModelPilot,
  };
}

export function loadProjectSeed(): Array<Record<string, unknown>> {
  const path = resolve("./config/projects.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
