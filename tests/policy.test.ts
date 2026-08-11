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

test("disposable fixture processes ignore inherited persistent storage and repository settings", () => {
  const names = [
    "CONTROL_PLANE_STORE",
    "DATABASE_URL",
    "TEST_DATABASE_URL",
    "RUN_POSTGRES_STORAGE_CONTRACT_TESTS",
    "POSTGRES_AUTO_MIGRATE",
    "REPOSITORY_PATH_OVALO",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CONTROL_PLANE_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://persistent.example/control_plane";
    process.env.TEST_DATABASE_URL = "postgresql://persistent.example/test";
    process.env.RUN_POSTGRES_STORAGE_CONTRACT_TESTS = "1";
    process.env.POSTGRES_AUTO_MIGRATE = "true";
    process.env.REPOSITORY_PATH_OVALO = "/sensitive/repository";

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
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
