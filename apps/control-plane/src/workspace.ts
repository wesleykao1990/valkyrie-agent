import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Project } from "./types.ts";
import type {
  ControlPlaneStore,
  WorkspaceLease,
  WorkspaceLeaseFence,
  WorkspaceRecord,
  WriterLeaseRequest,
} from "./store.ts";
import { id } from "./ids.ts";

export interface PreparedWorkspace {
  workspaceId: string;
  path: string;
  provider: string;
  workspace: WorkspaceRecord;
  lease: WriterLeaseRequest;
  repositoryPath?: string;
}

export interface PersistedWorkspace extends Omit<PreparedWorkspace, "lease"> {
  lease: WorkspaceLease;
}

export class WorkspaceManager {
  private store: ControlPlaneStore;
  private root: string;
  private now: () => Date;
  private leaseTtlMs: number;
  constructor(store: ControlPlaneStore, root: string, options: { now?: () => Date; leaseTtlMs?: number } = {}) {
    this.store = store;
    this.root = root;
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 1_000 || this.leaseTtlMs > 24 * 60 * 60 * 1000) {
      throw new Error("Workspace lease TTL must be between 1 second and 24 hours");
    }
    mkdirSync(root, { recursive: true });
  }

  prepare(runId: string, project: Project): PreparedWorkspace {
    const workspaceId = id("ws");
    const path = join(this.root, runId);
    mkdirSync(path, { recursive: true });
    let provider = "prototype-directory";
    let repositoryPath: string | undefined;

    const localRepo = process.env[`REPOSITORY_PATH_${project.id.toUpperCase().replace(/-/g, "_")}`];
    if (localRepo && existsSync(join(localRepo, ".git"))) {
      const result = spawnSync("git", ["-C", localRepo, "worktree", "add", "-b", `agent/${runId}`, path], { encoding: "utf8" });
      if (result.status === 0) {
        provider = "git-worktree";
        repositoryPath = localRepo;
      }
      else writeFileSync(join(path, "WORKSPACE_ERROR.txt"), String(result.stderr || result.stdout), "utf8");
    } else {
      writeFileSync(join(path, "WORKSPACE_PROTOTYPE.md"),
        `# Prototype workspace\n\nRun: ${runId}\nProject: ${project.name}\nRepository target: ${project.repository}\n\nNo repository path was configured, so this is a simulated isolated workspace.\n`, "utf8");
    }

    const heartbeatTime = this.now();
    const heartbeat = heartbeatTime.toISOString();
    const expiresAt = new Date(heartbeatTime.getTime() + this.leaseTtlMs).toISOString();
    return {
      workspaceId,
      path,
      provider,
      workspace: { id: workspaceId, runId, path, provider, status: "leased", createdAt: heartbeat },
      lease: { workspaceId, runId, ownerId: runId, mode: "writer", expiresAt, heartbeatAt: heartbeat },
      repositoryPath,
    };
  }

  async create(runId: string, project: Project): Promise<PersistedWorkspace> {
    const prepared = this.prepare(runId, project);
    const created = await this.store.createWorkspaceLease(prepared.workspace, prepared.lease);
    return { ...prepared, lease: created.lease };
  }

  /**
   * Compatibility release for the simulated/read-only adapters whose lease owner
   * is always the run ID. Strict writer code must retain and pass its original
   * WorkspaceLeaseFence directly to releaseFence().
   */
  async release(workspaceId: string, runId?: string): Promise<boolean> {
    const ownerRunId = runId ?? (await this.store.getWorkspace(workspaceId))?.runId;
    if (!ownerRunId) return false;
    const lease = await this.store.getWorkspaceLease(workspaceId);
    if (!lease || lease.runId !== ownerRunId || lease.ownerId !== ownerRunId) return false;
    return this.releaseFence(lease);
  }

  releaseFence(fence: WorkspaceLeaseFence): Promise<boolean> {
    return this.store.releaseWorkspaceLease(fence);
  }

  async discard(prepared: PreparedWorkspace): Promise<boolean> {
    if (await this.store.getWorkspace(prepared.workspaceId)) return false;

    const root = resolve(this.root);
    const path = resolve(prepared.path);
    if (path === root || !path.startsWith(`${root}${sep}`)) {
      throw new Error("Refusing to discard a workspace outside the configured workspace root");
    }

    if (prepared.provider === "git-worktree") {
      if (!prepared.repositoryPath) return false;
      const result = spawnSync(
        "git",
        ["-C", prepared.repositoryPath, "worktree", "remove", "--force", prepared.path],
        { encoding: "utf8" },
      );
      return result.status === 0;
    }

    rmSync(path, { recursive: true, force: true });
    return true;
  }
}
