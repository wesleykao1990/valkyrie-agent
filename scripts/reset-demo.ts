import { rmSync } from "node:fs";
import { resolve } from "node:path";

const backend = (process.env.CONTROL_PLANE_STORE ?? "sqlite").trim().toLowerCase();
if (backend !== "sqlite") {
  throw new Error("npm run reset only removes the local SQLite demo; unset CONTROL_PLANE_STORE or set it to sqlite");
}

const path = resolve(process.env.DATA_DIR ?? "./data", "control-plane.sqlite");
const removed: string[] = [];
for (const suffix of ["", "-shm", "-wal"]) {
  const candidate = `${path}${suffix}`;
  try {
    rmSync(candidate);
    removed.push(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw new Error(`Could not remove SQLite demo file ${candidate}`, { cause: error });
  }
}

if (removed.length === 0) console.log(`No SQLite demo database files found at ${path}`);
else console.log(`Removed SQLite demo database files:\n${removed.map((file) => `- ${file}`).join("\n")}`);
