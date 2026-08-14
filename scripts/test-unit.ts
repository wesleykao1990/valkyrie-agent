import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildIsolatedSmokeEnvironment } from "./smoke-environment.ts";

const environment = buildIsolatedSmokeEnvironment();

const testFiles = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("tests", name));

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", "--test-concurrency=1", ...testFiles],
  { env: environment, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
