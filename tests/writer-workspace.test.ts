import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import {
  WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON,
  WriterWorkspaceManager,
} from "../apps/control-plane/src/writer-workspace.ts";
import type { Project, Run } from "../apps/control-plane/src/types.ts";

const git = "/usr/bin/git";

function gitRun(repository: string, args: string[]): string {
  const result = spawnSync(git, ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Valkyrie Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Valkyrie Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return result.stdout.trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-writer-workspace-")));
  const source = join(root, "source");
  mkdirSync(source);
  gitRun(source, ["init", "--initial-branch=main"]);
  writeFileSync(join(source, "fixture.txt"), "base\n", "utf8");
  gitRun(source, ["add", "fixture.txt"]);
  gitRun(source, ["commit", "-m", "fixture base"]);
  gitRun(source, ["switch", "-c", "private-history"]);
  writeFileSync(join(source, "private-history.txt"), "not part of the selected base\n", "utf8");
  gitRun(source, ["add", "private-history.txt"]);
  gitRun(source, ["commit", "-m", "unrelated private history"]);
  const unrelatedCommit = gitRun(source, ["rev-parse", "HEAD"]);
  gitRun(source, ["switch", "main"]);
  const store = new SqliteStore(join(root, "store.sqlite"));
  const project: Project = {
    id: "fixture",
    name: "Fixture",
    objective: "Exercise strict writer workspaces",
    currentMilestone: "M4",
    health: "on_track",
    linearTeam: "FIX",
    repository: "fixture/repo",
    vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  return { root, source, store, project, unrelatedCommit };
}

function runRecord(id: string, projectId: string): Run {
  return {
    id,
    projectId,
    rootRuntime: "codex",
    workflow: "issue-to-pr-pilot",
    status: "queued",
    stage: null,
    stageIndex: 0,
    budgetUsd: 1,
    costUsd: 0,
    workspaceId: null,
    nativeRunId: null,
    nextActionAt: null,
    startedAt: null,
    completedAt: null,
    metadata: {},
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

test("strict writer preparation creates an independent relative Git worktree", async () => {
  const item = fixture();
  try {
    const hookSentinel = join(item.root, "source-hook-ran.txt");
    const hookPath = join(item.source, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, `#!/bin/sh\nprintf hook > '${hookSentinel}'\n`, "utf8");
    chmodSync(hookPath, 0o755);
    const fsmonitorSentinel = join(item.root, "source-fsmonitor-ran.txt");
    const fsmonitorPath = join(item.root, "fsmonitor-hook.sh");
    writeFileSync(fsmonitorPath, `#!/bin/sh\nprintf fsmonitor > '${fsmonitorSentinel}'\n`, "utf8");
    chmodSync(fsmonitorPath, 0o755);
    gitRun(item.source, ["config", "core.fsmonitor", fsmonitorPath]);
    const manager = new WriterWorkspaceManager({
      store: item.store,
      root: join(item.root, "writers"),
      gitCommand: git,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });
    assert.doesNotThrow(() => new WriterWorkspaceManager({
      store: item.store,
      root: join(item.root, "writers"),
      gitCommand: git,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    }), "a restarted manager must reuse the same validated private control root");
    const prepared = await manager.prepare({
      runId: "run_writer_one",
      project: item.project,
      repositoryPath: item.source,
      ownerId: "worker_fixture",
    });

    assert.equal(prepared.workspace.provider, "isolated-git-worktree");
    assert.equal(prepared.workspace.path, prepared.worktreePath);
    assert.equal(prepared.lease.ownerId, "worker_fixture");
    assert.equal(prepared.lease.mode, "writer");
    assert.equal(gitRun(prepared.worktreePath, ["rev-parse", "HEAD"]), gitRun(item.source, ["rev-parse", "HEAD"]));
    assert.equal(gitRun(prepared.worktreePath, ["branch", "--show-current"]), prepared.branchName);
    const pointer = readFileSync(join(prepared.worktreePath, ".git"), "utf8").trim();
    assert.match(pointer, /^gitdir: \.\.\//);
    assert.equal(pointer.includes(item.source), false);
    assert.equal(existsSync(hookSentinel), false);
    assert.equal(existsSync(fsmonitorSentinel), false);
    const unrelatedObject = spawnSync(git, ["-C", prepared.bareRepositoryPath, "cat-file", "-e", `${item.unrelatedCommit}^{commit}`]);
    assert.notEqual(unrelatedObject.status, 0);
    assert.equal(existsSync(join(prepared.worktreePath, "private-history.txt")), false);

    writeFileSync(join(prepared.worktreePath, "fixture.txt"), "candidate\n", "utf8");
    assert.equal(readFileSync(join(item.source, "fixture.txt"), "utf8"), "base\n");
    await manager.discard(prepared);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("separate writer runs never share their Git root, branch, or changes", async () => {
  const item = fixture();
  try {
    const manager = new WriterWorkspaceManager({ store: item.store, root: join(item.root, "writers"), gitCommand: git });
    const first = await manager.prepare({ runId: "run_writer_a", project: item.project, repositoryPath: item.source, ownerId: "worker_a" });
    const second = await manager.prepare({ runId: "run_writer_b", project: item.project, repositoryPath: item.source, ownerId: "worker_b" });
    assert.notEqual(first.runRoot, second.runRoot);
    assert.notEqual(first.bareRepositoryPath, second.bareRepositoryPath);
    assert.notEqual(first.branchName, second.branchName);
    writeFileSync(join(first.worktreePath, "fixture.txt"), "candidate-a\n", "utf8");
    assert.equal(readFileSync(join(second.worktreePath, "fixture.txt"), "utf8"), "base\n");
    await manager.discard(first);
    await manager.discard(second);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("dirty sources and Git creation failures never fall back to a prototype directory", async () => {
  const item = fixture();
  try {
    const writerRoot = join(item.root, "writers");
    const manager = new WriterWorkspaceManager({ store: item.store, root: writerRoot, gitCommand: git });
    writeFileSync(join(item.source, "dirty.txt"), "untracked\n", "utf8");
    await assert.rejects(manager.prepare({
      runId: "run_dirty",
      project: item.project,
      repositoryPath: item.source,
      ownerId: "worker_dirty",
    }), /must be clean/);

    rmSync(join(item.source, "dirty.txt"));
    const failing = new WriterWorkspaceManager({ store: item.store, root: join(item.root, "failing"), gitCommand: "/usr/bin/false" });
    await assert.rejects(failing.prepare({
      runId: "run_git_failure",
      project: item.project,
      repositoryPath: item.source,
      ownerId: "worker_failure",
    }), /Git command failed/);

    const linkedSource = join(item.root, "linked-source");
    symlinkSync(item.source, linkedSource);
    await assert.rejects(manager.prepare({
      runId: "run_symlink_source",
      project: item.project,
      repositoryPath: linkedSource,
      ownerId: "worker_symlink",
    }), /non-symlink/);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("persisted cleanup requires a frozen exact fence and never invokes host Git on writer-controlled metadata", async () => {
  const item = fixture();
  try {
    await item.store.seedProjects([{ ...item.project }]);
    await item.store.createRun(runRecord("run_cleanup", item.project.id));
    const manager = new WriterWorkspaceManager({ store: item.store, root: join(item.root, "writers"), gitCommand: git });
    const created = await manager.create({
      runId: "run_cleanup",
      project: item.project,
      repositoryPath: item.source,
      ownerId: "worker_cleanup",
    });
    await assert.rejects(manager.removeFilesystem(created, {
      workspaceId: created.workspaceId,
      runId: "run_cleanup",
      ownerId: "worker_cleanup",
      fencingToken: created.persistedLease.fencingToken + 1,
    }), /exact frozen lease fence/);
    assert.equal(readFileSync(join(created.worktreePath, "fixture.txt"), "utf8"), "base\n");

    const claimedAt = new Date(Date.parse(created.persistedLease.acquiredAt) + 1).toISOString();
    const claimed = await item.store.quarantineWorkspaceLease({
      workspaceId: created.workspaceId,
      runId: "run_cleanup",
      ownerId: "worker_cleanup",
      fencingToken: created.persistedLease.fencingToken,
      quarantinedAt: claimedAt,
      reason: WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON,
    });
    assert.ok(claimed);
    await assert.rejects(item.store.rotateWorkspaceLease({
      workspaceId: created.workspaceId,
      runId: "run_cleanup",
      ownerId: "worker_successor",
      mode: "writer",
      heartbeatAt: new Date(Date.parse(created.persistedLease.expiresAt) + 1).toISOString(),
      expiresAt: new Date(Date.parse(created.persistedLease.expiresAt) + 60_001).toISOString(),
    }), /quarantined/);

    // Simulate a writer replacing its private bare store with a symlink to an
    // outside repository. Cleanup must unlink the run root without asking host
    // Git to interpret any writer-controlled repository metadata.
    rmSync(created.bareRepositoryPath, { recursive: true, force: true });
    symlinkSync(item.source, created.bareRepositoryPath);
    await manager.removeFilesystem(created, {
      workspaceId: created.workspaceId,
      runId: "run_cleanup",
      ownerId: "worker_cleanup",
      fencingToken: created.persistedLease.fencingToken,
    });
    assert.equal(existsSync(item.source), true);
    assert.equal(readFileSync(join(item.source, "fixture.txt"), "utf8"), "base\n");
    assert.equal(await item.store.releaseWorkspaceLease({
      workspaceId: created.workspaceId,
      runId: "run_cleanup",
      ownerId: "worker_cleanup",
      fencingToken: created.persistedLease.fencingToken,
    }), true);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
