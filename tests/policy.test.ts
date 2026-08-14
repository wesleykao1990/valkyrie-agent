import test from "node:test";
import assert from "node:assert/strict";
import {
  assessEngineeringRequest,
  ENGINEERING_ROUTING_POLICY_VERSION,
  recommendEngineeringExecution,
  routeTask,
  validateBudget,
} from "../apps/control-plane/src/policy.ts";
import { loadConfig } from "../apps/control-plane/src/config.ts";
import { buildIsolatedSmokeEnvironment } from "../scripts/smoke-environment.ts";

test("routes non-trivial engineering work to Atomic", () => {
  const decision = routeTask({
    projectId: "ovalo",
    objective: "Implement pronunciation feedback across multiple files with integration tests",
  });
  assert.equal(decision.runtime, "atomic");
  assert.equal(decision.role, "engineering-lead");
  assert.equal(decision.executionShape, "atomic-lite");
});

test("research selects a future Research Lead role without assuming Prime", () => {
  const decision = routeTask({ projectId: "ovalo", objective: "Research and benchmark three speech architectures" });
  assert.equal(decision.workClass, "research");
  assert.equal(decision.role, "research-lead");
  assert.equal(decision.runtime, null);
  assert.equal(decision.supported, false);
  assert.match(decision.reason, /no keyword selects Prime/i);
});

test("engineering that includes research terms still uses the engineering risk rubric", () => {
  const decision = routeTask({
    projectId: "ovalo",
    objective: "Research and implement a benchmark harness with integration tests",
  });
  assert.equal(decision.workClass, "engineering");
  assert.equal(decision.role, "engineering-lead");
  assert.notEqual(decision.runtime, "prime");
  assert.notEqual(decision.executionShape, null);
});

test("explicit runtime wins", () => {
  assert.equal(routeTask({ projectId: "ovalo", objective: "Anything", runtime: "claude" }).runtime, "claude");
  const prime = routeTask({ projectId: "ovalo", objective: "Research a bounded fixture", runtime: "prime" });
  assert.equal(prime.role, "research-lead");
  assert.equal(prime.runtime, "prime");
  assert.equal(prime.supported, true);
});

test("engineering routing selects the smallest complete execution shape", () => {
  const direct = recommendEngineeringExecution({
    structure: 0, verifiability: 1, iteration: 0, risk: 0, duration: 0, isolation: 0,
  });
  assert.deepEqual({ shape: direct.shape, score: direct.score }, { shape: "direct", score: 1 });

  const lite = recommendEngineeringExecution({
    structure: 1, verifiability: 1, iteration: 1, risk: 1, duration: 0, isolation: 0,
  });
  assert.deepEqual({ shape: lite.shape, score: lite.score }, { shape: "atomic-lite", score: 4 });

  const full = recommendEngineeringExecution({
    structure: 1, verifiability: 2, iteration: 1, risk: 1, duration: 1, isolation: 1,
  });
  assert.deepEqual({ shape: full.shape, score: full.score }, { shape: "atomic-full", score: 7 });
});

test("Hermes preference can increase rigor but cannot weaken control-plane policy", () => {
  const blocked = recommendEngineeringExecution({
    structure: 2, verifiability: 2, iteration: 2, risk: 2, duration: 1, isolation: 2,
    preference: "direct",
  });
  assert.equal(blocked.shape, "atomic-full");
  assert.equal(blocked.preferenceApplied, false);
  assert.match(blocked.reasons.join(" "), /blocked-by-policy/);

  const escalated = recommendEngineeringExecution({
    structure: 0, verifiability: 1, iteration: 0, risk: 0, duration: 0, isolation: 0,
    preference: "atomic-lite",
  });
  assert.equal(escalated.shape, "atomic-lite");
  assert.equal(escalated.preferenceApplied, true);
});

test("hard workflow signals select Atomic Full regardless of a low numeric score", () => {
  const decision = recommendEngineeringExecution({
    structure: 0, verifiability: 0, iteration: 0, risk: 0, duration: 0, isolation: 0,
    preference: "direct",
    hardSignals: { approvalOrEvidenceGate: true },
  });
  assert.equal(decision.shape, "atomic-full");
  assert.equal(decision.baselineShape, "atomic-full");
  assert.equal(decision.preferenceApplied, false);
});

test("engineering routing rejects invalid dimension values", () => {
  assert.throws(() => recommendEngineeringExecution({
    structure: 3 as 2, verifiability: 0, iteration: 0, risk: 0, duration: 0, isolation: 0,
  }), /structure routing score/);
});

test("control-plane routing derives Direct, Lite, and Full without caller-supplied scores", () => {
  const direct = assessEngineeringRequest({
    request: "Fix one typo in a single README file.",
    finalAction: "analysis_only",
    projectHealth: "on_track",
    preference: "auto",
  });
  assert.equal(direct.policyVersion, ENGINEERING_ROUTING_POLICY_VERSION);
  assert.equal(direct.decision.shape, "direct");
  assert.equal(direct.assessment.structure, 0);

  const lite = assessEngineeringRequest({
    request: "Implement a bounded parser in two files with unit tests.",
    finalAction: "prepare_reviewable_result",
    projectHealth: "on_track",
  });
  assert.equal(lite.decision.shape, "atomic-lite");
  assert.equal(lite.assessment.verifiability, 2);
  assert.equal(lite.assessment.iteration, 1);

  const full = assessEngineeringRequest({
    request: "Create a production database migration with an approval gate and bounded repair until green.",
    finalAction: "prepare_reviewable_result",
    projectHealth: "at_risk",
    preference: "direct",
  });
  assert.equal(full.decision.shape, "atomic-full");
  assert.equal(full.assessment.risk, 2);
  assert.equal(full.assessment.hardSignals?.explicitLoop, true);
  assert.match(full.decision.reasons.join(" "), /blocked-by-policy/);
});

test("derived routing applies authoritative context floors while retaining caller preference as upward-only", () => {
  const value = assessEngineeringRequest({
    request: "Please review this focused change.",
    finalAction: "analysis_only",
    projectHealth: "on_track",
    preference: "atomic-full",
    task: { title: "Review", objective: "Review", status: "planned", priority: "critical" },
  });
  assert.equal(value.assessment.risk, 1);
  assert.equal(value.decision.shape, "atomic-full");
  assert.equal(value.decision.preferenceApplied, true);
  assert.ok(value.matchedSignals.includes("task-priority-risk-floor"));
});

test("derived routing rejects invalid or unbounded literal requests", () => {
  assert.throws(() => assessEngineeringRequest({
    request: "x",
    finalAction: "analysis_only",
    projectHealth: "on_track",
  }), /5 to 16000/);
  assert.throws(() => assessEngineeringRequest({
    request: "x".repeat(16_001),
    finalAction: "analysis_only",
    projectHealth: "on_track",
  }), /5 to 16000/);
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

test("Atomic model pilot is default-off and requires accepted digests plus a credential boundary", () => {
  const names = [
    "ATOMIC_FIXTURE_PILOT_ENABLED", "ATOMIC_FIXTURE_PILOT_REPOSITORY", "ATOMIC_FIXTURE_PILOT_ENGINE",
    "ATOMIC_FIXTURE_PILOT_IMAGE", "ATOMIC_FIXTURE_PILOT_ROOT", "ATOMIC_FIXTURE_MODEL_PILOT_ENABLED",
    "ATOMIC_FIXTURE_MODEL_PROVIDER", "ATOMIC_FIXTURE_MODEL_ID", "ATOMIC_FIXTURE_MODEL_UPSTREAM_BASE_URL",
    "ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE", "ATOMIC_FIXTURE_MODEL_ALLOW_CREDENTIAL_FREE_LOOPBACK",
    "ATOMIC_FIXTURE_MODEL_ACCEPTED_PACKAGE_SHA256", "ATOMIC_FIXTURE_MODEL_ACCEPTED_IMAGE_DIGEST",
    "ATOMIC_FIXTURE_MODEL_NETWORK", "CONTROL_PLANE_OPERATOR_ID",
    "ATOMIC_FIXTURE_MODEL_INPUT_COST_MICROS_PER_MILLION", "ATOMIC_FIXTURE_MODEL_OUTPUT_COST_MICROS_PER_MILLION",
    "ENABLE_DEMO_RESET", "CONTROL_PLANE_AUTH_TOKEN",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(loadConfig().atomicFixtureModelPilot.enabled, false);
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    process.env.ATOMIC_FIXTURE_MODEL_PILOT_ENABLED = "true";
    assert.throws(() => loadConfig(), /requires the isolated Atomic fixture pilot boundary/);
    process.env.ATOMIC_FIXTURE_PILOT_ENABLED = "true";
    process.env.ATOMIC_FIXTURE_PILOT_REPOSITORY = "/tmp/fixture-repository";
    process.env.ATOMIC_FIXTURE_PILOT_ENGINE = "/usr/local/bin/docker";
    const digest = `sha256:${"a".repeat(64)}`;
    process.env.ATOMIC_FIXTURE_PILOT_IMAGE = `fixture.invalid/atomic@${digest}`;
    process.env.ATOMIC_FIXTURE_PILOT_ROOT = "/tmp/atomic-pilot-root";
    process.env.ENABLE_DEMO_RESET = "false";
    assert.throws(() => loadConfig(), /CONTROL_PLANE_OPERATOR_ID/);
    process.env.CONTROL_PLANE_OPERATOR_ID = "wesley-local-operator";
    assert.throws(() => loadConfig(), /explicit provider and model/);
    process.env.ATOMIC_FIXTURE_MODEL_PROVIDER = "future-provider";
    process.env.ATOMIC_FIXTURE_MODEL_ID = "future-model";
    process.env.ATOMIC_FIXTURE_MODEL_UPSTREAM_BASE_URL = "https://api.example.invalid/v1";
    assert.throws(() => loadConfig(), /internal Docker network/);
    process.env.ATOMIC_FIXTURE_MODEL_NETWORK = "valkyrie-model-test";
    assert.throws(() => loadConfig(), /private credential file/);
    process.env.ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE = "/tmp/future-provider-token";
    assert.throws(() => loadConfig(), /provider prices/);
    process.env.ATOMIC_FIXTURE_MODEL_INPUT_COST_MICROS_PER_MILLION = "1000000";
    process.env.ATOMIC_FIXTURE_MODEL_OUTPUT_COST_MICROS_PER_MILLION = "2000000";
    assert.throws(() => loadConfig(), /accepted package and immutable image digests/);
    process.env.ATOMIC_FIXTURE_MODEL_ACCEPTED_PACKAGE_SHA256 = "b".repeat(64);
    process.env.ATOMIC_FIXTURE_MODEL_ACCEPTED_IMAGE_DIGEST = digest;
    const configured = loadConfig().atomicFixtureModelPilot;
    assert.equal(configured.enabled, true);
    assert.equal(configured.maxInputTokens, 32_000);
    assert.equal(configured.maxOutputTokens, 8_000);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Atomic model pilot accepts an explicit subscription broker without provider API credentials", () => {
  const names = [
    "ATOMIC_FIXTURE_PILOT_ENABLED", "ATOMIC_FIXTURE_PILOT_REPOSITORY", "ATOMIC_FIXTURE_PILOT_ENGINE",
    "ATOMIC_FIXTURE_PILOT_IMAGE", "ATOMIC_FIXTURE_PILOT_ROOT", "ATOMIC_FIXTURE_MODEL_PILOT_ENABLED",
    "ATOMIC_FIXTURE_MODEL_UPSTREAM_MODE", "ATOMIC_FIXTURE_MODEL_PROVIDER", "ATOMIC_FIXTURE_MODEL_ID",
    "ATOMIC_FIXTURE_MODEL_NETWORK", "ATOMIC_FIXTURE_MODEL_ACCEPTED_PACKAGE_SHA256",
    "ATOMIC_FIXTURE_MODEL_ACCEPTED_IMAGE_DIGEST", "ATOMIC_FIXTURE_MODEL_CODEX_COMMAND",
    "ATOMIC_FIXTURE_MODEL_CODEX_EXPECTED_VERSION", "ATOMIC_FIXTURE_MODEL_CODEX_HOME",
    "ATOMIC_FIXTURE_MODEL_CODEX_SCRATCH_ROOT", "CONTROL_PLANE_OPERATOR_ID", "ENABLE_DEMO_RESET",
    "CONTROL_PLANE_AUTH_TOKEN", "ATOMIC_FIXTURE_MODEL_UPSTREAM_BASE_URL",
    "ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE", "ATOMIC_FIXTURE_MODEL_ALLOW_CREDENTIAL_FREE_LOOPBACK",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const digest = `sha256:${"c".repeat(64)}`;
    Object.assign(process.env, {
      CONTROL_PLANE_AUTH_TOKEN: "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE",
      CONTROL_PLANE_OPERATOR_ID: "wesley-local-operator",
      ENABLE_DEMO_RESET: "false",
      ATOMIC_FIXTURE_PILOT_ENABLED: "true",
      ATOMIC_FIXTURE_PILOT_REPOSITORY: "/tmp/fixture-repository",
      ATOMIC_FIXTURE_PILOT_ENGINE: "/usr/local/bin/docker",
      ATOMIC_FIXTURE_PILOT_IMAGE: `fixture.invalid/atomic@${digest}`,
      ATOMIC_FIXTURE_PILOT_ROOT: "/tmp/atomic-pilot-root",
      ATOMIC_FIXTURE_MODEL_PILOT_ENABLED: "true",
      ATOMIC_FIXTURE_MODEL_UPSTREAM_MODE: "codex-subscription",
      ATOMIC_FIXTURE_MODEL_PROVIDER: "openai-codex-subscription",
      ATOMIC_FIXTURE_MODEL_ID: "gpt-5.6-sol",
      ATOMIC_FIXTURE_MODEL_NETWORK: "valkyrie-model-test",
      ATOMIC_FIXTURE_MODEL_ACCEPTED_PACKAGE_SHA256: "d".repeat(64),
      ATOMIC_FIXTURE_MODEL_ACCEPTED_IMAGE_DIGEST: digest,
      ATOMIC_FIXTURE_MODEL_CODEX_COMMAND: "/opt/homebrew/bin/codex",
      ATOMIC_FIXTURE_MODEL_CODEX_EXPECTED_VERSION: "0.147.0",
      ATOMIC_FIXTURE_MODEL_CODEX_HOME: "/tmp/valkyrie-codex-home",
      ATOMIC_FIXTURE_MODEL_CODEX_SCRATCH_ROOT: "/tmp/valkyrie-codex-scratch",
    });
    const configured = loadConfig().atomicFixtureModelPilot;
    assert.equal(configured.upstreamMode, "codex-subscription");
    assert.equal(configured.upstreamBaseUrl, undefined);
    assert.equal(configured.credentialFile, undefined);
    process.env.ATOMIC_FIXTURE_MODEL_UPSTREAM_BASE_URL = "https://api.example.invalid/v1";
    assert.throws(() => loadConfig(), /forbids provider URLs/);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("M6 direct candidates are default-off, Codex requires M5b, and Claude remains separately gated", () => {
  const names = ["DIRECT_CODEX_MODEL_PILOT_ENABLED", "DIRECT_CLAUDE_MODEL_PILOT_ENABLED", "ATOMIC_FIXTURE_MODEL_PILOT_ENABLED", "CONTROL_PLANE_AUTH_TOKEN"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const defaults = loadConfig();
    assert.equal(defaults.directCodexModelPilotEnabled, false);
    assert.equal(defaults.directClaudeModelPilotEnabled, false);
    process.env.DIRECT_CODEX_MODEL_PILOT_ENABLED = "true";
    assert.throws(() => loadConfig(), /bearer authentication is required/);
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    assert.throws(() => loadConfig(), /requires the reviewed M5b scoped inference deployment/);
    delete process.env.DIRECT_CODEX_MODEL_PILOT_ENABLED;
    process.env.DIRECT_CLAUDE_MODEL_PILOT_ENABLED = "true";
    assert.equal(loadConfig().directClaudeModelPilotEnabled, true);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
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
    "RUN_POSTGRES_MODEL_LIFECYCLE_TESTS",
    "POSTGRES_AUTO_MIGRATE",
    "REPOSITORY_PATH_OVALO",
    "ATOMIC_ADAPTER",
    "CODEX_ADAPTER",
    "CLAUDE_ADAPTER",
    "CONTROL_PLANE_AUTH_TOKEN",
    "CONTROL_PLANE_AUTH_TOKEN_FILE",
    "CONTROL_PLANE_MCP_TOOL_ALLOWLIST",
    "CONTROL_PLANE_OPERATOR_ID",
    "ATOMIC_FIXTURE_MODEL_PILOT_ENABLED",
    "ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE",
    "DIRECT_CODEX_MODEL_PILOT_ENABLED",
    "DIRECT_CLAUDE_MODEL_PILOT_ENABLED",
    "VALKYRIE_M6_ATOMIC_RUN_ID",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CONTROL_PLANE_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://persistent.example/control_plane";
    process.env.TEST_DATABASE_URL = "postgresql://persistent.example/test";
    process.env.RUN_POSTGRES_STORAGE_CONTRACT_TESTS = "1";
    process.env.RUN_POSTGRES_MODEL_LIFECYCLE_TESTS = "1";
    process.env.POSTGRES_AUTO_MIGRATE = "true";
    process.env.REPOSITORY_PATH_OVALO = "/sensitive/repository";
    process.env.ATOMIC_ADAPTER = "native";
    process.env.CODEX_ADAPTER = "native";
    process.env.CLAUDE_ADAPTER = "native";
    process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
    process.env.CONTROL_PLANE_AUTH_TOKEN_FILE = "/sensitive/token";
    process.env.CONTROL_PLANE_MCP_TOOL_ALLOWLIST = "projects_list";
    process.env.CONTROL_PLANE_OPERATOR_ID = "wesley-local-operator";
    process.env.ATOMIC_FIXTURE_MODEL_PILOT_ENABLED = "true";
    process.env.ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE = "/sensitive/provider-token";
    process.env.DIRECT_CODEX_MODEL_PILOT_ENABLED = "true";
    process.env.DIRECT_CLAUDE_MODEL_PILOT_ENABLED = "true";

    const environment = buildIsolatedSmokeEnvironment({ PORT: "19001" });
    assert.equal(environment.CONTROL_PLANE_STORE, "sqlite");
    assert.equal(environment.POSTGRES_AUTO_MIGRATE, "false");
    assert.equal(environment.SEED_DEMO_DATA, "true");
    assert.equal(environment.ENABLE_DEMO_RESET, "true");
    assert.equal(environment.PORT, "19001");
    assert.equal(environment.DATABASE_URL, undefined);
    assert.equal(environment.TEST_DATABASE_URL, undefined);
    assert.equal(environment.RUN_POSTGRES_STORAGE_CONTRACT_TESTS, undefined);
    assert.equal(environment.RUN_POSTGRES_MODEL_LIFECYCLE_TESTS, undefined);
    assert.equal(environment.REPOSITORY_PATH_OVALO, undefined);
    assert.equal(environment.ATOMIC_ADAPTER, undefined);
    assert.equal(environment.CODEX_ADAPTER, undefined);
    assert.equal(environment.CLAUDE_ADAPTER, undefined);
    assert.equal(environment.CONTROL_PLANE_AUTH_TOKEN, undefined);
    assert.equal(environment.CONTROL_PLANE_AUTH_TOKEN_FILE, undefined);
    assert.equal(environment.CONTROL_PLANE_MCP_TOOL_ALLOWLIST, undefined);
    assert.equal(environment.CONTROL_PLANE_OPERATOR_ID, undefined);
    assert.equal(environment.ATOMIC_FIXTURE_MODEL_PILOT_ENABLED, undefined);
    assert.equal(environment.ATOMIC_FIXTURE_MODEL_CREDENTIAL_FILE, undefined);
    assert.equal(environment.DIRECT_CODEX_MODEL_PILOT_ENABLED, undefined);
    assert.equal(environment.DIRECT_CLAUDE_MODEL_PILOT_ENABLED, undefined);
    assert.equal(environment.VALKYRIE_M6_ATOMIC_RUN_ID, undefined);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
