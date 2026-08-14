import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAtomicFixtureRepository } from "../scripts/setup-atomic-fixture.ts";

function git(repository: string, args: string[]): void {
  const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Valkyrie Fixture Test",
      GIT_AUTHOR_EMAIL: "fixture-test@example.invalid",
      GIT_COMMITTER_NAME: "Valkyrie Fixture Test",
      GIT_COMMITTER_EMAIL: "fixture-test@example.invalid",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Git fixture mutation failed");
}

test("Atomic fixture setup creates one reviewed repository and replays only while it remains exact and clean", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-fixture-")));
  const repository = join(root, "source");
  try {
    const created = setupAtomicFixtureRepository(repository);
    assert.equal(created.replayed, false);
    assert.match(created.commit, /^[a-f0-9]{40,64}$/);
    assert.match(created.templateHash, /^[a-f0-9]{64}$/);
    assert.match(readFileSync(join(repository, "src", "normalize-project-slug.js"), "utf8"), /TODO/);

    const replayed = setupAtomicFixtureRepository(repository);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.commit, created.commit);
    assert.equal(replayed.templateHash, created.templateHash);

    writeFileSync(join(repository, "src", "normalize-project-slug.js"), "tampered\n", "utf8");
    assert.throws(() => setupAtomicFixtureRepository(repository), /not clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atomic fixture replay rejects a clean committed content replacement or addition", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-fixture-committed-")));
  try {
    const replaced = join(root, "replaced");
    setupAtomicFixtureRepository(replaced);
    writeFileSync(join(replaced, "src", "normalize-project-slug.js"), "committed tamper\n", "utf8");
    git(replaced, ["add", "--all"]);
    git(replaced, ["commit", "-m", "Replace reviewed fixture content"]);
    assert.throws(
      () => setupAtomicFixtureRepository(replaced),
      /committed content changed: src\/normalize-project-slug\.js/,
    );

    const extended = join(root, "extended");
    setupAtomicFixtureRepository(extended);
    writeFileSync(join(extended, "unexpected.txt"), "not reviewed\n", "utf8");
    git(extended, ["add", "--all"]);
    git(extended, ["commit", "-m", "Add unreviewed fixture content"]);
    assert.throws(
      () => setupAtomicFixtureRepository(extended),
      /committed tree does not match the reviewed fixture manifest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atomic fixture replay rejects filesystem extras that Git status does not report", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-fixture-extra-")));
  const repository = join(root, "source");
  try {
    setupAtomicFixtureRepository(repository);
    mkdirSync(join(repository, "unexpected-empty-directory"));
    assert.throws(
      () => setupAtomicFixtureRepository(repository),
      /unexpected directory: unexpected-empty-directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atomic fixture replay rejects an ignored symbolic-link extra", { skip: process.platform === "win32" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-fixture-symlink-")));
  const repository = join(root, "source");
  try {
    setupAtomicFixtureRepository(repository);
    writeFileSync(join(repository, ".git", "info", "exclude"), "ignored-link\n", "utf8");
    symlinkSync("README.md", join(repository, "ignored-link"));
    assert.throws(
      () => setupAtomicFixtureRepository(repository),
      /contains a symbolic link: ignored-link/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
