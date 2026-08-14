import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("offline reset refuses PostgreSQL and reports SQLite deletion failures", () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-reset-test-"));
  const database = join(root, "control-plane.sqlite");
  const script = resolve("scripts/reset-demo.ts");
  const run = (backend: string) => spawnSync(
    process.execPath,
    ["--experimental-strip-types", script],
    {
      env: { ...process.env, CONTROL_PLANE_STORE: backend, DATA_DIR: root },
      encoding: "utf8",
    },
  );

  try {
    writeFileSync(database, "fixture");
    writeFileSync(`${database}-wal`, "fixture");

    const postgres = run("postgres");
    assert.notEqual(postgres.status, 0);
    assert.match(postgres.stderr, /only removes the local SQLite demo/i);
    assert.equal(existsSync(database), true);

    const sqlite = run("sqlite");
    assert.equal(sqlite.status, 0, sqlite.stderr);
    assert.match(sqlite.stdout, /Removed SQLite demo database files/);
    assert.equal(existsSync(database), false);
    assert.equal(existsSync(`${database}-wal`), false);

    mkdirSync(database);
    const failed = run("sqlite");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Could not remove SQLite demo file/);
    assert.equal(existsSync(database), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
