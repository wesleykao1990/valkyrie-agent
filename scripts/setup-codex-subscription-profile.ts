import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function absolute(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return resolve(value);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} is not a regular directory`);
  chmodSync(path, 0o700);
}

const command = absolute("ATOMIC_FIXTURE_MODEL_CODEX_COMMAND", "/opt/homebrew/bin/codex");
const expected = process.env.ATOMIC_FIXTURE_MODEL_CODEX_EXPECTED_VERSION?.trim() || "0.147.0";
const home = absolute("ATOMIC_FIXTURE_MODEL_CODEX_HOME", resolve("data/runtime/codex-subscription-profile"));
const scratch = absolute("ATOMIC_FIXTURE_MODEL_CODEX_SCRATCH_ROOT", resolve("data/runtime/codex-subscription-scratch"));
if (home === scratch) throw new Error("Codex subscription profile and scratch root must be separate");
privateDirectory(home);
privateDirectory(scratch);

const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
const version = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
if (version.error || version.status !== 0 || version.stdout.trim() !== `codex-cli ${expected}`) {
  throw new Error(`Expected codex-cli ${expected} at ${command}`);
}
const auth = spawnSync(command, ["login", "status"], { env, encoding: "utf8", timeout: 10_000 });
if (!auth.error && auth.status === 0 && `${auth.stdout}${auth.stderr}`.trim() === "Logged in using ChatGPT") {
  console.log(`Dedicated Codex subscription profile is ready at ${home}`);
} else {
  console.log("Dedicated profile created but not authenticated.");
  console.log(`Run: CODEX_HOME=${JSON.stringify(home)} HOME=${JSON.stringify(home)} ${JSON.stringify(command)} login --device-auth`);
}
console.log(`Scratch root: ${scratch}`);
