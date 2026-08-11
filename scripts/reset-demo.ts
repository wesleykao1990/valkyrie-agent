import { rmSync } from "node:fs";
import { resolve } from "node:path";
const path = resolve(process.env.DATA_DIR ?? "./data", "control-plane.sqlite");
for (const suffix of ["", "-shm", "-wal"]) {
  try { rmSync(`${path}${suffix}`); } catch {}
}
console.log(`Removed demo database at ${path}`);
