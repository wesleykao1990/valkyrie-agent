import test from "node:test";
import assert from "node:assert/strict";
import { routeTask, validateBudget } from "../apps/control-plane/src/policy.ts";
import { loadConfig } from "../apps/control-plane/src/config.ts";
import { buildIsolatedSmokeEnvironment } from "../scripts/smoke-environment.ts";

test("routes non-trivial engineering work to Atomic", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Implement pronunciation feedback with tests" }).runtime, "atomic");
});

test("routes long research to Prime", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Research and benchmark three speech architectures" }).runtime, "prime");
});

test("explicit runtime wins", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Anything", runtime: "claude" }).runtime, "claude");
});

test("budget is bounded", () => {
  assert.equal(validateBudget(undefined), 8);
  assert.throws(() => validateBudget(30));
});

test("PostgreSQL configuration fails closed without DATABASE_URL", () => {
  const backend = process.env.CONTROL_PLANE_STORE;
  const databaseUrl = process.env.DATABASE_URL;
  try {
    process.env.CONTROL_PLANE_STORE = "postgres";
    delete process.env.DATABASE_URL;
    assert.throws(() => loadConfig(), /DATABASE_URL is required/);
  } finally {
    if (backend === undefined) delete process.env.CONTROL_PLANE_STORE;
    else process.env.CONTROL_PLANE_STORE = backend;
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
  }
});

test("demo data and reset default on only for SQLite", () => {
  const names = ["CONTROL_PLANE_STORE", "DATABASE_URL", "SEED_DEMO_DATA", "ENABLE_DEMO_RESET", "POSTGRES_AUTO_MIGRATE"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const sqlite = loadConfig();
    assert.equal(sqlite.storeBackend, "sqlite");
    assert.equal(sqlite.seedDemoData, true);
    assert.equal(sqlite.enableDemoReset, true);
    assert.equal(sqlite.postgresAutoMigrate, false);

    process.env.CONTROL_PLANE_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://example.invalid/control_plane";
    process.env.SEED_DEMO_DATA = "true";
    process.env.ENABLE_DEMO_RESET = "true";
    const postgres = loadConfig();
    assert.equal(postgres.seedDemoData, false);
    assert.equal(postgres.enableDemoReset, false);
    assert.equal(postgres.postgresAutoMigrate, false);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("native runtime adapters are explicit and invalid selections fail closed", () => {
  const names = ["ATOMIC_ADAPTER", "CODEX_ADAPTER", "CLAUDE_ADAPTER", "CLAUDE_RUNTIME_ENV_ALLOWLIST", "CONTROL_PLANE_AUTH_TOKEN"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const defaults = loadConfig();
    assert.deepEqual(defaults.runtimeAdapters, { atomic: "mock", codex: "mock", claude: "mock" });

    process.env.CODEX_ADAPTER = "native";
    process.env.CLAUDE_RUNTIME_ENV_ALLOWLIST = "ANTHROPIC_API_KEY";
    assert.throws(() => loadConfig(), /bearer authentication is required/);
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    const native = loadConfig();
    assert.equal(native.runtimeAdapters.codex, "native");
    assert.deepEqual(native.claudeRuntimeEnvAllowlist, ["ANTHROPIC_API_KEY"]);

    process.env.ATOMIC_ADAPTER = "sometimes";
    assert.throws(() => loadConfig(), /ATOMIC_ADAPTER must be either mock or native/);
    process.env.ATOMIC_ADAPTER = "mock";
    process.env.CLAUDE_RUNTIME_ENV_ALLOWLIST = "BAD-NAME";
    assert.throws(() => loadConfig(), /invalid environment variable name/);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Atomic fixture pilot is default-off and fails closed without auth or exact local boundary configuration", () => {
  const names = [
    "ATOMIC_FIXTURE_PILOT_ENABLED",
    "ATOMIC_FIXTURE_PILOT_REPOSITORY",
    "ATOMIC_FIXTURE_PILOT_ENGINE",
    "ATOMIC_FIXTURE_PILOT_IMAGE",
    "ATOMIC_FIXTURE_PILOT_ROOT",
    "ENABLE_DEMO_RESET",
    "CONTROL_PLANE_AUTH_TOKEN",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(loadConfig().atomicFixturePilot.enabled, false);

    process.env.ATOMIC_FIXTURE_PILOT_ENABLED = "true";
    assert.throws(() => loadConfig(), /bearer authentication is required/);
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    assert.throws(() => loadConfig(), /ATOMIC_FIXTURE_PILOT_REPOSITORY is required/);
    process.env.ATOMIC_FIXTURE_PILOT_REPOSITORY = "/tmp/fixture-repository";
    process.env.ATOMIC_FIXTURE_PILOT_ENGINE = "/usr/local/bin/docker";
    process.env.ATOMIC_FIXTURE_PILOT_IMAGE = `fixture.invalid/atomic@sha256:${"a".repeat(64)}`;
    process.env.ATOMIC_FIXTURE_PILOT_ROOT = "/tmp/atomic-pilot-root";
    assert.throws(() => loadConfig(), /ENABLE_DEMO_RESET must be false/);
    process.env.ENABLE_DEMO_RESET = "false";
    const configured = loadConfig().atomicFixturePilot;
    assert.equal(configured.enabled, true);
    assert.equal(configured.maxCostUsd, 1);

    process.env.ENABLE_DEMO_RESET = "true";
    assert.throws(() => loadConfig(), /ENABLE_DEMO_RESET must be false/);
    process.env.ENABLE_DEMO_RESET = "false";
    process.env.ATOMIC_FIXTURE_PILOT_ROOT = "relative/path";
    assert.throws(() => loadConfig(), /must be an explicit absolute path/);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("non-loopback bindings require control-plane authentication", () => {
  const names = ["HOST", "CONTROL_PLANE_AUTH_TOKEN", "CONTROL_PLANE_AUTH_TOKEN_FILE"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.HOST = "0.0.0.0";
    assert.throws(() => loadConfig(), /non-loopback HOST/);
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    assert.equal(loadConfig().host, "0.0.0.0");
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("disposable fixture processes ignore inherited persistent storage and repository settings", () => {
  const names = [
    "CONTROL_PLANE_STORE",
    "DATABASE_URL",
    "TEST_DATABASE_URL",
    "RUN_POSTGRES_STORAGE_CONTRACT_TESTS",
    "POSTGRES_AUTO_MIGRATE",
    "REPOSITORY_PATH_OVALO",
    "ATOMIC_ADAPTER",
    "CODEX_ADAPTER",
    "CLAUDE_ADAPTER",
    "CONTROL_PLANE_AUTH_TOKEN",
    "CONTROL_PLANE_AUTH_TOKEN_FILE",
    "CONTROL_PLANE_MCP_TOOL_ALLOWLIST",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CONTROL_PLANE_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://persistent.example/control_plane";
    process.env.TEST_DATABASE_URL = "postgresql://persistent.example/test";
    process.env.RUN_POSTGRES_STORAGE_CONTRACT_TESTS = "1";
    process.env.POSTGRES_AUTO_MIGRATE = "true";
    process.env.REPOSITORY_PATH_OVALO = "/sensitive/repository";
    process.env.ATOMIC_ADAPTER = "native";
    process.env.CODEX_ADAPTER = "native";
    process.env.CLAUDE_ADAPTER = "native";
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    process.env.CONTROL_PLANE_AUTH_TOKEN_FILE = "/sensitive/token";
    process.env.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = "projects_list";

    const environment = buildIsolatedSmokeEnvironment({ PORT: "19001" });
    assert.equal(environment.CONTROL_PLANE_STORE, "sqlite");
    assert.equal(environment.POSTGRES_AUTO_MIGRATE, "false");
    assert.equal(environment.SEED_DEMO_DATA, "true");
    assert.equal(environment.ENABLE_DEMO_RESET, "true");
    assert.equal(environment.PORT, "19001");
    assert.equal(environment.DATABASE_URL, undefined);
    assert.equal(environment.TEST_DATABASE_URL, undefined);
    assert.equal(environment.RUN_POSTGRES_STORAGE_CONTRACT_TESTS, undefined);
    assert.equal(environment.REPOSITORY_PATH_OVALO, undefined);
    assert.equal(environment.ATOMIC_ADAPTER, undefined);
    assert.equal(environment.CODEX_ADAPTER, undefined);
    assert.equal(environment.CLAUDE_ADAPTER, undefined);
    assert.equal(environment.CONTROL_PLANE_AUTH_TOKEN, undefined);
    assert.equal(environment.CONTROL_PLANE_AUTH_TOKEN_FILE, undefined);
    assert.equal(environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST, undefined);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
