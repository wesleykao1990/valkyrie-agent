import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const profile = process.env.VALKYRIE_HERMES_PROFILE ?? "valkyrieeval";
const serverName = "valkyrie_project_os";
const tokenPath = resolve(process.env.CONTROL_PLANE_AUTH_TOKEN_FILE ?? "data/auth/control-plane.token");
const mcpCommand = resolve("bin/project-os-pilot-mcp");
const api = process.env.CONTROL_PLANE_API ?? "http://127.0.0.1:8787";
const profileMarker = resolve("data/runtime/hermes", `${profile}.empty-profile-v1`);

if (!/^[a-z0-9]+$/.test(profile)) throw new Error("VALKYRIE_HERMES_PROFILE must be lowercase alphanumeric");

function run(args: string[], allowFailure = false, input?: string) {
  const result = spawnSync("hermes", args, {
    encoding: "utf8",
    ...(allowFailure
      ? { stdio: "pipe" as const }
      : input === undefined
        ? { stdio: "inherit" as const }
        : { stdio: ["pipe", "inherit", "inherit"] as const, input }),
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw result.error ?? new Error(`hermes ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
}

if (!existsSync(tokenPath)) throw new Error("Pilot token is missing. Run npm run setup:pilot first.");
if (!existsSync(mcpCommand)) throw new Error(`MCP wrapper is missing at ${mcpCommand}`);

const profileCheck = run(["profile", "show", profile], true);
if (profileCheck.status !== 0) {
  run(["profile", "create", profile, "--no-skills", "--no-alias", "--description", "Empty isolated Valkyrie Project OS evaluation profile."]);
  mkdirSync(dirname(profileMarker), { recursive: true });
  writeFileSync(profileMarker, "Created without cloning another Hermes profile.\n", { encoding: "utf8", flag: "w", mode: 0o600 });
} else if (!existsSync(profileMarker)) {
  throw new Error(
    `Hermes profile ${profile} already exists but was not created by this isolation script. `
    + `Audit it or recreate it with: hermes profile delete ${profile} && npm run setup:hermes`,
  );
}

run(["-p", profile, "config", "set", "memory.memory_enabled", "false"]);
run(["-p", profile, "config", "set", "memory.user_profile_enabled", "false"]);
const listed = run(["-p", profile, "mcp", "list"], true);
if (`${listed.stdout}\n${listed.stderr}`.includes(serverName)) {
  run(["-p", profile, "mcp", "remove", serverName], false, "y\n");
}
run([
  "-p", profile, "mcp", "add", serverName,
  "--command", mcpCommand,
  "--connect-timeout", "10",
  "--env", `CONTROL_PLANE_API=${api}`, `CONTROL_PLANE_AUTH_TOKEN_FILE=${tokenPath}`,
], false, "y\n");

run([
  "-p", profile, "tools", "disable", "--platform", "cli",
  "web", "browser", "terminal", "file", "code_execution", "vision", "video",
  "image_gen", "video_gen", "x_search", "tts", "skills", "todo", "memory",
  "context_engine", "session_search", "clarify", "delegation", "cronjob",
  "homeassistant", "spotify", "yuanbao", "computer_use",
]);

console.log(`Configured isolated Hermes profile ${profile}; built-in memory/profile injection and all built-in CLI toolsets are disabled.`);
console.log(`Test MCP while the pilot server is running: hermes -p ${profile} mcp test ${serverName}`);
console.log(`Configure inference inside this profile: hermes -p ${profile} setup model`);
console.log(`Then start Hermes with only the Valkyrie MCP server toolset: hermes -p ${profile} chat -t ${serverName}`);
