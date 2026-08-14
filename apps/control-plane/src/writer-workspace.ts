import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { Project } from "./types.ts";
import type {
  ControlPlaneStore,
  WorkspaceLease,
  WorkspaceLeaseFence,
  WorkspaceRecord,
  WriterLeaseRequest,
} from "./store.ts";
import { id, nowIso } from "./ids.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;

/**
 * A durable exact-fence quarantine doubles as the filesystem-cleanup freeze.
 * Rotation is forbidden while this claim exists; a crash leaves operator-visible
 * evidence instead of making the run root eligible for reuse.
 */
export const WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON = "writer_filesystem_cleanup_claimed";

export interface WriterWorkspaceManagerOptions {
  store: ControlPlaneStore;
  root: string;
  gitCommand: string;
  commandTimeoutMs?: number;
  leaseTtlMs?: number;
  now?: () => Date;
}

export interface PrepareWriterWorkspaceInput {
  runId: string;
  project: Project;
  repositoryPath: string;
  ownerId: string;
  baseRef?: string;
}

export interface PreparedWriterWorkspace {
  workspaceId: string;
  runRoot: string;
  worktreePath: string;
  bareRepositoryPath: string;
  baseCommit: string;
  branchName: string;
  sourceRepositoryPath: string;
  workspace: WorkspaceRecord;
  lease: WriterLeaseRequest;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

interface WorkspaceMarker {
  schemaVersion: 1;
  runId: string;
  workspaceId: string;
  worktreeRelativePath: "worktree";
  bareRepositoryRelativePath: "repository.git";
  sourceRepositoryHash: string;
  baseCommit: string;
  branchName: string;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertContained(root: string, candidate: string, description: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${description} escaped the configured writer-workspace root`);
  }
}

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field} is not a safe bounded identifier`);
}

function assertPrivateDirectory(path: string, description: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a regular non-symlink directory`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${description} must not grant group or other permissions`);
  }
}

function safeCommandEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  };
}

export class WriterWorkspaceManager {
  private readonly store: ControlPlaneStore;
  private readonly root: string;
  private readonly gitCommand: string;
  private readonly commandTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly clock: () => Date;
  private readonly gitHome: string;

  constructor(options: WriterWorkspaceManagerOptions) {
    this.store = options.store;
    this.root = resolve(options.root);
    this.gitCommand = resolve(options.gitCommand);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 20_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.clock = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 100 || this.commandTimeoutMs > 5 * 60_000) {
      throw new Error("Writer Git command timeout must be between 100ms and 5 minutes");
    }
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 5_000 || this.leaseTtlMs > 5 * 60_000) {
      throw new Error("Writer lease TTL must be between 5 seconds and 5 minutes");
    }
    if (!this.gitCommand.startsWith(`${sep}`)) throw new Error("Writer Git command must be an absolute path");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(this.root, "Writer workspace root");
    this.gitHome = join(this.root, ".git-home");
    mkdirSync(this.gitHome, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(this.gitHome, "Writer Git home");
  }

  async prepare(input: PrepareWriterWorkspaceInput): Promise<PreparedWriterWorkspace> {
    assertSafeId(input.runId, "Writer run ID");
    assertSafeId(input.ownerId, "Writer lease owner ID");
    const requestedSource = resolve(input.repositoryPath);
    const requestedStat = lstatSync(requestedSource);
    if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
      throw new Error("Writer source repository must be a regular non-symlink directory");
    }
    const sourceRepositoryPath = realpathSync(requestedSource);
    if (!existsSync(join(sourceRepositoryPath, ".git"))) {
      throw new Error("Writer source repository must be a non-bare Git working tree");
    }
    const gitEntry = lstatSync(join(sourceRepositoryPath, ".git"));
    if (gitEntry.isSymbolicLink() || (!gitEntry.isDirectory() && !gitEntry.isFile())) {
      throw new Error("Writer source .git entry must be a regular file or directory, never a symbolic link");
    }

    const baseRef = input.baseRef ?? "HEAD";
    if (!baseRef || baseRef.length > 256 || /[\u0000-\u001f\u007f]/.test(baseRef) || baseRef.startsWith("-")) {
      throw new Error("Writer base ref is invalid");
    }
    const inside = (await this.git(["-C", sourceRepositoryPath, "rev-parse", "--is-inside-work-tree"])).stdout.trim();
    if (inside !== "true") throw new Error("Writer source is not a Git working tree");
    const dirty = (await this.git([
      "-C", sourceRepositoryPath,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "status", "--porcelain=v1", "--untracked-files=normal",
    ])).stdout;
    if (dirty.length > 0) throw new Error("Writer source repository must be clean before snapshotting");
    const baseCommit = (await this.git([
      "-C", sourceRepositoryPath,
      "rev-parse", "--verify", `${baseRef}^{commit}`,
    ])).stdout.trim().toLowerCase();
    if (!COMMIT_SHA.test(baseCommit)) throw new Error("Writer source returned an invalid base commit");

    const rootReal = realpathSync(this.root);
    const runRoot = resolve(rootReal, sha(input.runId).slice(0, 32));
    assertContained(rootReal, runRoot, "Writer run root");
    mkdirSync(runRoot, { mode: 0o700 });
    const bareRepositoryPath = join(runRoot, "repository.git");
    const worktreePath = join(runRoot, "worktree");
    const branchName = `agent/${sha(input.runId).slice(0, 24)}`;
    const workspaceId = id("ws");

    try {
      await this.git(["-c", "core.hooksPath=/dev/null", "init", "--bare", bareRepositoryPath]);
      await this.git([
        "-C", bareRepositoryPath,
        "-c", "core.hooksPath=/dev/null",
        "-c", "protocol.file.allow=always",
        "fetch", "--no-tags", "--depth=1", sourceRepositoryPath, baseCommit,
      ]);
      await this.git([
        "-C", bareRepositoryPath,
        "-c", "core.hooksPath=/dev/null",
        "worktree", "add", "--relative-paths", "-b", branchName, worktreePath, baseCommit,
      ]);
      await this.git([
        "-C", bareRepositoryPath,
        "-c", "core.hooksPath=/dev/null",
        "worktree", "lock", "--reason", `valkyrie:${input.runId}`, worktreePath,
      ]);
      const gitFile = join(worktreePath, ".git");
      const gitStat = lstatSync(gitFile);
      if (!gitStat.isFile() || gitStat.isSymbolicLink()) throw new Error("Writer worktree .git pointer is not a regular file");
      const gitPointer = readFileSync(gitFile, "utf8").trim();
      if (!gitPointer.startsWith("gitdir: ../") || gitPointer.includes(runRoot)) {
        throw new Error("Writer worktree must use a relative Git directory pointer");
      }
      const checkedCommit = (await this.git(["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim().toLowerCase();
      const checkedBranch = (await this.git(["-C", worktreePath, "branch", "--show-current"])).stdout.trim();
      if (checkedCommit !== baseCommit || checkedBranch !== branchName) {
        throw new Error("Writer worktree identity does not match its requested base and branch");
      }

      const marker: WorkspaceMarker = {
        schemaVersion: 1,
        runId: input.runId,
        workspaceId,
        worktreeRelativePath: "worktree",
        bareRepositoryRelativePath: "repository.git",
        sourceRepositoryHash: sha(sourceRepositoryPath),
        baseCommit,
        branchName,
      };
      writeFileSync(join(runRoot, ".valkyrie-workspace.json"), `${JSON.stringify(marker)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });

      const heartbeat = this.clock();
      const heartbeatAt = heartbeat.toISOString();
      const expiresAt = new Date(heartbeat.getTime() + this.leaseTtlMs).toISOString();
      return {
        workspaceId,
        runRoot,
        worktreePath,
        bareRepositoryPath,
        baseCommit,
        branchName,
        sourceRepositoryPath,
        workspace: {
          id: workspaceId,
          runId: input.runId,
          path: worktreePath,
          provider: "isolated-git-worktree",
          status: "leased",
          createdAt: heartbeatAt,
        },
        lease: {
          workspaceId,
          runId: input.runId,
          ownerId: input.ownerId,
          mode: "writer",
          heartbeatAt,
          expiresAt,
        },
      };
    } catch (error) {
      rmSync(runRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async create(input: PrepareWriterWorkspaceInput): Promise<PreparedWriterWorkspace & { persistedLease: WorkspaceLease }> {
    const prepared = await this.prepare(input);
    try {
      const created = await this.store.createWorkspaceLease(prepared.workspace, prepared.lease);
      return { ...prepared, persistedLease: created.lease };
    } catch (error) {
      await this.discard(prepared);
      throw error;
    }
  }

  async removeFilesystem(prepared: PreparedWriterWorkspace, fence: WorkspaceLeaseFence): Promise<void> {
    if (
      fence.workspaceId !== prepared.workspaceId
      || fence.runId !== prepared.workspace.runId
      || fence.ownerId !== prepared.lease.ownerId
    ) {
      throw new Error("Writer workspace cleanup fence does not match the prepared workspace");
    }
    const current = await this.store.getWorkspaceLease(prepared.workspaceId);
    if (!current
      || current.state !== "quarantined"
      || current.quarantineReason !== WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON
      || current.runId !== fence.runId
      || current.ownerId !== fence.ownerId
      || current.fencingToken !== fence.fencingToken) {
      throw new Error("Writer workspace cleanup requires the current exact frozen lease fence");
    }
    this.assertMarker(prepared);
    // The bare store and its worktree are both disposable children of runRoot.
    // Never invoke host Git on repository metadata that the writer could modify.
    rmSync(prepared.runRoot, { recursive: true, force: true });
    if (existsSync(prepared.runRoot)) throw new Error("Writer run root still exists after cleanup");
  }

  async discard(prepared: PreparedWriterWorkspace): Promise<void> {
    if (await this.store.getWorkspace(prepared.workspaceId)) {
      throw new Error("Cannot discard a persisted writer workspace without an exact lease fence");
    }
    const root = realpathSync(this.root);
    const candidate = resolve(prepared.runRoot);
    assertContained(root, candidate, "Writer discard target");
    if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
  }

  private assertMarker(prepared: PreparedWriterWorkspace): void {
    const root = realpathSync(this.root);
    const runRoot = realpathSync(prepared.runRoot);
    assertContained(root, runRoot, "Writer cleanup target");
    const markerPath = join(runRoot, ".valkyrie-workspace.json");
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("Writer workspace marker is not a regular file");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<WorkspaceMarker>;
    if (
      marker.schemaVersion !== 1
      || marker.runId !== prepared.workspace.runId
      || marker.workspaceId !== prepared.workspaceId
      || marker.sourceRepositoryHash !== sha(prepared.sourceRepositoryPath)
      || marker.baseCommit !== prepared.baseCommit
      || marker.branchName !== prepared.branchName
      || marker.worktreeRelativePath !== basename(prepared.worktreePath)
      || marker.bareRepositoryRelativePath !== basename(prepared.bareRepositoryPath)
    ) {
      throw new Error("Writer workspace marker does not match the cleanup target");
    }
  }

  private git(args: readonly string[]): Promise<GitResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.gitCommand, [...args], {
        env: safeCommandEnvironment(this.gitHome),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let outputExceeded = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref();
      };
      const timeout = setTimeout(() => {
        if (!settled) terminate();
      }, this.commandTimeoutMs);
      timeout.unref();

      const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
        if (stream === "stdout") stdoutBytes += chunk.byteLength;
        else stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > MAX_GIT_OUTPUT_BYTES) {
          outputExceeded = true;
          terminate();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        rejectPromise(new Error(`Writer Git command could not start: ${error instanceof Error ? error.message : "unknown error"}`));
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (outputExceeded) {
          rejectPromise(new Error("Writer Git command exceeded its output bound"));
        } else if (code !== 0) {
          const summary = stderrText.trim().slice(0, 512).replace(/[\u0000-\u001f\u007f]+/g, " ");
          rejectPromise(new Error(`Writer Git command failed (code=${code}, signal=${signal})${summary ? `: ${summary}` : ""}`));
        } else {
          resolvePromise({ stdout: stdoutText, stderr: stderrText });
        }
      });
    });
  }
}
