import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Project } from "./types.ts";
import type { SqliteStore } from "./store.ts";
import { id, nowIso } from "./ids.ts";

export class WorkspaceManager {
  private store: SqliteStore;
  private root: string;
  constructor(store: SqliteStore, root: string) {
    this.store = store;
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  create(runId: string, project: Project): { workspaceId: string; path: string; provider: string } {
    const workspaceId = id("ws");
    const path = join(this.root, runId);
    mkdirSync(path, { recursive: true });
    let provider = "prototype-directory";

    const localRepo = process.env[`REPOSITORY_PATH_${project.id.toUpperCase().replace(/-/g, "_")}`];
    if (localRepo && existsSync(join(localRepo, ".git"))) {
      const result = spawnSync("git", ["-C", localRepo, "worktree", "add", "-b", `agent/${runId}`, path], { encoding: "utf8" });
      if (result.status === 0) provider = "git-worktree";
      else writeFileSync(join(path, "WORKSPACE_ERROR.txt"), String(result.stderr || result.stdout), "utf8");
    } else {
      writeFileSync(join(path, "WORKSPACE_PROTOTYPE.md"),
        `# Prototype workspace\n\nRun: ${runId}\nProject: ${project.name}\nRepository target: ${project.repository}\n\nNo repository path was configured, so this is a simulated isolated workspace.\n`, "utf8");
    }

    this.store.createWorkspace({ id: workspaceId, runId, path, provider, status: "leased", createdAt: nowIso() });
    const heartbeat = nowIso();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    this.store.createLease({ workspaceId, runId, mode: "writer", expiresAt, heartbeatAt: heartbeat });
    return { workspaceId, path, provider };
  }

  release(workspaceId: string): void {
    this.store.releaseLease(workspaceId);
    this.store.updateWorkspaceStatus(workspaceId, "released");
  }
}
