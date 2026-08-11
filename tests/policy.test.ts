import test from "node:test";
import assert from "node:assert/strict";
import { routeTask, validateBudget } from "../apps/control-plane/src/policy.ts";
import { loadConfig } from "../apps/control-plane/src/config.ts";

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
