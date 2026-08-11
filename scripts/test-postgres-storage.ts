import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a disposable PostgreSQL port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function run(command: string, args: string[], environment = process.env): void {
  const result = spawnSync(command, args, { env: environment, stdio: "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

const root = mkdtempSync("/tmp/valkyrie-postgres-storage-");
const dataDir = join(root, "data");
const socketDir = join(root, "socket");
const logPath = join(root, "postgres.log");
mkdirSync(socketDir);
const port = await reservePort();
let started = false;

try {
  run(process.env.INITDB_COMMAND ?? "initdb", [
    "--no-locale", "--encoding=UTF8", "--auth=trust", "--username=valkyrie", "-D", dataDir,
  ]);
  run(process.env.PG_CTL_COMMAND ?? "pg_ctl", [
    "-D", dataDir,
    "-l", logPath,
    "-o", `-F -h 127.0.0.1 -p ${port} -k ${socketDir}`,
    "-w", "start",
  ]);
  started = true;
  const testEnvironment = {
    ...process.env,
    TEST_DATABASE_URL: `postgresql://valkyrie@127.0.0.1:${port}/postgres`,
  };
  run(process.execPath, ["--experimental-strip-types", "--test", "tests/storage.test.ts"], testEnvironment);
} finally {
  if (started) {
    spawnSync(process.env.PG_CTL_COMMAND ?? "pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"], {
      stdio: "inherit",
      encoding: "utf8",
    });
  }
  rmSync(root, { recursive: true, force: true });
}
