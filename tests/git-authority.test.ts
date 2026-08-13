import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitAuthorityError,
  GitAuthorityProvider,
  createGitAuthorityPolicy,
} from "../apps/control-plane/src/git-authority.ts";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Git fixture command failed");
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  repository: string;
  sentinel: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-git-authority-"));
  const repository = join(root, "repository");
  const sentinel = join(root, "hook-sentinel");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "--quiet", "-b", "main"]);
  git(repository, ["config", "user.name", "Valkyrie Git Test"]);
  git(repository, ["config", "user.email", "git-authority@example.invalid"]);
  writeFileSync(join(repository, "README.md"), "baseline\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "--quiet", "-m", "baseline"]);
  git(repository, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(repository, "feature.txt"), "feature change\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["commit", "--quiet", "-m", "feature"]);
  git(repository, ["checkout", "--quiet", "main"]);
  git(repository, ["remote", "add", "origin", "https://github.com/acme/project.git"]);
  return { root, repository, sentinel };
}

function policy(item: Fixture, overrides: Record<string, unknown> = {}) {
  return createGitAuthorityPolicy({
    projectId: "project_git_test",
    repositoryPath: item.repository,
    repositoryIdentity: "github.com/acme/project",
    baseRef: "main",
    headRef: "feature",
    checkPolicy: [{ id: "git-version", executable: "/usr/bin/git", argv: ["--version"] }],
    ...overrides,
  });
}

function dispose(item: Fixture): void {
  rmSync(item.root, { recursive: true, force: true });
}

test("Git authority binds remote identity, clean refs, trees, binary full-index patch, and check policy", async () => {
  const item = fixture();
  try {
    const provider = new GitAuthorityProvider({ policy: policy(item) });
    const snapshot = await provider.read();
    assert.equal(snapshot.provider, "git");
    assert.equal(snapshot.repositoryIdentity, "github.com/acme/project");
    assert.equal(snapshot.remoteUrlIdentity, "github.com/acme/project");
    assert.equal(snapshot.baseRef, "main");
    assert.equal(snapshot.headRef, "feature");
    assert.equal(snapshot.clean, true);
    assert.match(snapshot.baseCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(snapshot.baseTree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(snapshot.headCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(snapshot.headTree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(snapshot.patchDigest, /^[a-f0-9]{64}$/u);
    assert(snapshot.patchBytes > 0);
    assert.match(snapshot.checkPolicyDigest, /^[a-f0-9]{64}$/u);
    assert.match(snapshot.policyDigest, /^[a-f0-9]{64}$/u);
  } finally {
    dispose(item);
  }
});

test("Git authority rejects dirty repositories, remote identity mismatch, and ref drift", async () => {
  const dirty = fixture();
  try {
    const provider = new GitAuthorityProvider({ policy: policy(dirty) });
    writeFileSync(join(dirty.repository, "untracked.txt"), "dirty\n");
    await assert.rejects(provider.read(), (error: unknown) => error instanceof GitAuthorityError && error.code === "GIT_REPOSITORY_DIRTY");
  } finally {
    dispose(dirty);
  }

  const mismatch = fixture();
  try {
    git(mismatch.repository, ["remote", "set-url", "origin", "https://github.com/acme/other-project.git"]);
    const provider = new GitAuthorityProvider({ policy: policy(mismatch) });
    await assert.rejects(provider.read(), (error: unknown) => error instanceof GitAuthorityError && error.code === "GIT_REMOTE_MISMATCH");
  } finally {
    dispose(mismatch);
  }

  const drift = fixture();
  try {
    const provider = new GitAuthorityProvider({ policy: policy(drift) });
    const initial = await provider.read();
    git(drift.repository, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(drift.repository, "feature.txt"), "feature change v2\n");
    git(drift.repository, ["add", "feature.txt"]);
    git(drift.repository, ["commit", "--quiet", "-m", "feature v2"]);
    git(drift.repository, ["checkout", "--quiet", "main"]);
    await assert.rejects(provider.verify(initial), (error: unknown) => error instanceof GitAuthorityError && error.code === "GIT_REF_DRIFT");
  } finally {
    dispose(drift);
  }
});

test("Git authority requires a nonempty bounded execution check policy and exact object IDs", () => {
  const item = fixture();
  try {
    assert.throws(() => createGitAuthorityPolicy({
      projectId: "project_git_test",
      repositoryPath: item.repository,
      repositoryIdentity: "github.com/acme/project",
      baseRef: "main",
      headRef: "feature",
      checkPolicy: [],
    }), (error: unknown) => error instanceof GitAuthorityError && error.code === "GIT_POLICY_INVALID");
    assert.throws(() => policy(item, { approvedBaseCommit: "a".repeat(41) }), /object ID/u);
    assert.throws(() => policy(item, { baseRef: "../attacker" }), (error: unknown) => error instanceof GitAuthorityError && error.code === "GIT_REF_INVALID");
  } finally {
    dispose(item);
  }
});

test("Git authority disables hooks/fsmonitor/external diff and preserves a stable approved policy", async () => {
  const item = fixture();
  try {
    writeFileSync(join(item.repository, ".git", "hooks", "pre-commit"), `#!/bin/sh\nprintf touched > '${item.sentinel}'\nexit 1\n`);
    chmodSync(join(item.repository, ".git", "hooks", "pre-commit"), 0o755);
    const initialProvider = new GitAuthorityProvider({ policy: policy(item) });
    const initial = await initialProvider.read();
    assert.equal(initial.clean, true);
    const approvedPolicy = policy(item, {
      approvedBaseCommit: initial.baseCommit,
      approvedBaseTree: initial.baseTree,
      approvedHeadCommit: initial.headCommit,
      approvedHeadTree: initial.headTree,
    });
    const approved = await new GitAuthorityProvider({ policy: approvedPolicy }).read();
    assert.equal(approved.policyDigest, approvedPolicy.policyDigest);
    assert.equal(approved.checkPolicyDigest, approvedPolicy.checkPolicyDigest);
    assert.equal(existsSync(item.sentinel), false);
  } finally {
    dispose(item);
  }
});
