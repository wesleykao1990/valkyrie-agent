const blockedNames = new Set([
  "ATOMIC_COMMAND",
  "ATOMIC_ADAPTER",
  "ATOMIC_EXPECTED_VERSION",
  "ATOMIC_PACKAGE_DIR",
  "ATOMIC_RUNTIME_ENV_ALLOWLIST",
  "ATOMIC_FIXTURE_PILOT_ENABLED",
  "ATOMIC_FIXTURE_PILOT_REPOSITORY",
  "ATOMIC_FIXTURE_PILOT_ENGINE",
  "ATOMIC_FIXTURE_PILOT_ENGINE_SOCKET",
  "ATOMIC_FIXTURE_PILOT_IMAGE",
  "ATOMIC_FIXTURE_PILOT_ROOT",
  "ATOMIC_FIXTURE_PILOT_USER",
  "ATOMIC_FIXTURE_PILOT_MAX_COST_USD",
  "CLAUDE_ADAPTER",
  "CLAUDE_COMMAND",
  "CLAUDE_EXPECTED_VERSION",
  "CLAUDE_RUNTIME_ENV_ALLOWLIST",
  "CODEX_ADAPTER",
  "CODEX_COMMAND",
  "CODEX_EXPECTED_VERSION",
  "CODEX_RUNTIME_ENV_ALLOWLIST",
  "CONTROL_PLANE_API",
  "CONTROL_PLANE_AUTH_TOKEN",
  "CONTROL_PLANE_AUTH_TOKEN_FILE",
  "CONTROL_PLANE_MCP_TOOL_ALLOWLIST",
  "CONTROL_PLANE_OPERATOR_ID",
  "CONTROL_PLANE_STORE",
  "DATABASE_URL",
  "DATA_DIR",
  "DEFAULT_RUNTIME",
  "DEMO_STAGE_DELAY_MS",
  "ENABLE_DEMO_RESET",
  "HOST",
  "GITHUB_CONNECTOR_MODE",
  "GITHUB_TOKEN_FILE",
  "LINEAR_AUTH_MODE",
  "LINEAR_CONNECTOR_MODE",
  "LINEAR_TOKEN_FILE",
  "M7_CONNECTOR_POLICY_FILE",
  "M7_CONNECTOR_POLICY_SHA256",
  "OPENVIKING_MODE",
  "OPENVIKING_URL",
  "PORT",
  "POSTGRES_AUTO_MIGRATE",
  "POSTGRES_SSL",
  "PROJECT_BRAIN_DIR",
  "RUN_POSTGRES_STORAGE_CONTRACT_TESTS",
  "RUN_POSTGRES_MODEL_LIFECYCLE_TESTS",
  "SEED_DEMO_DATA",
  "TEST_DATABASE_URL",
  "VALKYRIE_OCI_LIVE_ENGINE",
  "VALKYRIE_OCI_LIVE_IMAGE",
  "VALKYRIE_OCI_LIVE_ROOT",
  "VALKYRIE_OCI_LIVE_SOCKET",
  "VALKYRIE_OCI_LIVE_USER",
]);

/**
 * Keep smoke processes on disposable SQLite state even when the invoking shell
 * is configured for a persistent database or a real repository worktree.
 */
export function buildIsolatedSmokeEnvironment(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      value !== undefined
      && !blockedNames.has(name)
      && !name.startsWith("ATOMIC_FIXTURE_MODEL_")
      && !name.startsWith("DIRECT_CODEX_MODEL_")
      && !name.startsWith("DIRECT_CLAUDE_MODEL_")
      && !name.startsWith("VALKYRIE_M6_")
      && !name.startsWith("M7_LIVE_")
      && !name.startsWith("REPOSITORY_PATH_")
    ),
  );
  return {
    ...inherited,
    CONTROL_PLANE_STORE: "sqlite",
    POSTGRES_AUTO_MIGRATE: "false",
    SEED_DEMO_DATA: "true",
    ENABLE_DEMO_RESET: "true",
    ...overrides,
  };
}
