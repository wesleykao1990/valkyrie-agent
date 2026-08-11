import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Approval, Artifact, MemoryProposal, Project, Run, RunEvent, Task } from "./types.ts";
import { nowIso } from "./ids.ts";

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export class SqliteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        current_milestone TEXT NOT NULL,
        health TEXT NOT NULL,
        linear_team TEXT NOT NULL,
        repository TEXT NOT NULL,
        vault_path TEXT NOT NULL,
        memory_namespace TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        source TEXT NOT NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        root_runtime TEXT NOT NULL,
        workflow TEXT,
        status TEXT NOT NULL,
        stage TEXT,
        stage_index INTEGER NOT NULL DEFAULT 0,
        budget_usd REAL NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        workspace_id TEXT,
        native_run_id TEXT,
        next_action_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        path TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_leases (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        mode TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        action TEXT NOT NULL,
        exact_effect TEXT NOT NULL,
        state TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        decision TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        uri TEXT NOT NULL,
        checksum TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT REFERENCES runs(id),
        claim TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        reviewer TEXT,
        target_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status_next ON runs(status, next_action_at);
      CREATE INDEX IF NOT EXISTS idx_events_run_seq ON run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state);
      CREATE INDEX IF NOT EXISTS idx_memory_state ON memory_proposals(state);
    `);
  }

  resetOperationalData(): void {
    this.db.exec(`
      DELETE FROM workspace_leases;
      DELETE FROM workspaces;
      DELETE FROM artifacts;
      DELETE FROM approvals;
      DELETE FROM run_events;
      DELETE FROM runs;
      DELETE FROM memory_proposals;
      DELETE FROM tasks;
    `);
  }

  seedProjects(items: Array<Record<string, unknown>>): void {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO projects
      (id,name,objective,current_milestone,health,linear_team,repository,vault_path,memory_namespace,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const item of items) {
      stmt.run(
        String(item.id), String(item.name), String(item.objective), String(item.currentMilestone),
        String(item.health), String(item.linearTeam), String(item.repository), String(item.vaultPath),
        String(item.memoryNamespace), nowIso()
      );
    }
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name").all() as any[]).map(this.mapProject);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as any;
    return row ? this.mapProject(row) : null;
  }

  createTask(task: Task): void {
    this.db.prepare(`INSERT INTO tasks
      (id,project_id,source,source_id,title,objective,status,priority,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        task.id, task.projectId, task.source, task.sourceId ?? null, task.title, task.objective,
        task.status, task.priority, task.createdAt
      );
  }

  listTasks(projectId?: string): Task[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC").all(projectId)
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
    return (rows as any[]).map(this.mapTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    return row ? this.mapTask(row) : null;
  }

  findTaskBySimilarTitle(projectId: string, title: string): Task | null {
    const normalized = title.trim().toLowerCase();
    const rows = this.listTasks(projectId);
    return rows.find((t) => {
      const current = t.title.trim().toLowerCase();
      return current === normalized || current.includes(normalized) || normalized.includes(current);
    }) ?? null;
  }

  createRun(run: Run): void {
    this.db.prepare(`INSERT INTO runs
      (id,task_id,project_id,root_runtime,workflow,status,stage,stage_index,budget_usd,cost_usd,
       workspace_id,native_run_id,next_action_at,started_at,completed_at,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        run.id, run.taskId ?? null, run.projectId, run.rootRuntime, run.workflow ?? null, run.status,
        run.stage ?? null, run.stageIndex, run.budgetUsd, run.costUsd, run.workspaceId ?? null,
        run.nativeRunId ?? null, run.nextActionAt ?? null, run.startedAt ?? null, run.completedAt ?? null,
        JSON.stringify(run.metadata ?? {}), run.createdAt
      );
  }

  updateRun(id: string, patch: Partial<Run>): void {
    const mapping: Record<string, string> = {
      taskId: "task_id", projectId: "project_id", rootRuntime: "root_runtime", workflow: "workflow",
      status: "status", stage: "stage", stageIndex: "stage_index", budgetUsd: "budget_usd",
      costUsd: "cost_usd", workspaceId: "workspace_id", nativeRunId: "native_run_id",
      nextActionAt: "next_action_at", startedAt: "started_at", completedAt: "completed_at",
      metadata: "metadata_json"
    };
    const entries = Object.entries(patch).filter(([k]) => k in mapping);
    if (!entries.length) return;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of entries) {
      sets.push(`${mapping[key]}=?`);
      values.push(key === "metadata" ? JSON.stringify(value ?? {}) : value ?? null);
    }
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id=?`).run(...values);
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as any;
    return row ? this.mapRun(row) : null;
  }

  listRuns(limit = 100): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map(this.mapRun);
  }

  listRunnableRuns(now: string): Run[] {
    return (this.db.prepare(`SELECT * FROM runs
      WHERE status='running' AND next_action_at IS NOT NULL AND next_action_at<=?
      ORDER BY next_action_at ASC LIMIT 20`).all(now) as any[]).map(this.mapRun);
  }

  appendEvent(event: Omit<RunEvent, "seq">): RunEvent {
    const result = this.db.prepare(`INSERT INTO run_events
      (id,run_id,type,message,payload_json,created_at) VALUES (?,?,?,?,?,?)`).run(
        event.id, event.runId, event.type, event.message, JSON.stringify(event.payload ?? {}), event.createdAt
      ) as any;
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  listEvents(runId: string, afterSeq = 0): RunEvent[] {
    return (this.db.prepare(`SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq ASC`).all(runId, afterSeq) as any[])
      .map(this.mapEvent);
  }

  createWorkspace(workspace: { id: string; runId: string; path: string; provider: string; status: string; createdAt: string }): void {
    this.db.prepare(`INSERT INTO workspaces (id,run_id,path,provider,status,created_at) VALUES (?,?,?,?,?,?)`)
      .run(workspace.id, workspace.runId, workspace.path, workspace.provider, workspace.status, workspace.createdAt);
  }

  updateWorkspaceStatus(id: string, status: string): void {
    this.db.prepare("UPDATE workspaces SET status=? WHERE id=?").run(status, id);
  }

  createLease(lease: { workspaceId: string; runId: string; mode: string; expiresAt: string; heartbeatAt: string }): void {
    this.db.prepare(`INSERT INTO workspace_leases (workspace_id,run_id,mode,expires_at,heartbeat_at) VALUES (?,?,?,?,?)`)
      .run(lease.workspaceId, lease.runId, lease.mode, lease.expiresAt, lease.heartbeatAt);
  }

  releaseLease(workspaceId: string): void {
    this.db.prepare("DELETE FROM workspace_leases WHERE workspace_id=?").run(workspaceId);
  }

  listLeases(): any[] {
    return this.db.prepare("SELECT * FROM workspace_leases ORDER BY heartbeat_at DESC").all() as any[];
  }

  createApproval(approval: Approval): void {
    this.db.prepare(`INSERT INTO approvals
      (id,run_id,action,exact_effect,state,evidence_json,requested_at,resolved_at,resolved_by,decision)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        approval.id, approval.runId, approval.action, approval.exactEffect, approval.state,
        JSON.stringify(approval.evidence), approval.requestedAt, approval.resolvedAt ?? null,
        approval.resolvedBy ?? null, approval.decision ?? null
      );
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as any;
    return row ? this.mapApproval(row) : null;
  }

  listApprovals(state?: string): Approval[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM approvals WHERE state=? ORDER BY requested_at DESC").all(state)
      : this.db.prepare("SELECT * FROM approvals ORDER BY requested_at DESC").all();
    return (rows as any[]).map(this.mapApproval);
  }

  resolveApproval(id: string, state: string, decision: string, resolvedBy: string): void {
    this.db.prepare(`UPDATE approvals SET state=?, decision=?, resolved_by=?, resolved_at=? WHERE id=?`)
      .run(state, decision, resolvedBy, nowIso(), id);
  }

  createArtifact(artifact: Artifact): void {
    this.db.prepare(`INSERT INTO artifacts (id,run_id,kind,uri,checksum,media_type,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(artifact.id, artifact.runId, artifact.kind, artifact.uri, artifact.checksum, artifact.mediaType, artifact.createdAt);
  }

  listArtifacts(runId: string): Artifact[] {
    return (this.db.prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at").all(runId) as any[])
      .map((r) => ({ id: r.id, runId: r.run_id, kind: r.kind, uri: r.uri, checksum: r.checksum, mediaType: r.media_type, createdAt: r.created_at }));
  }

  createMemoryProposal(item: MemoryProposal): void {
    this.db.prepare(`INSERT INTO memory_proposals
      (id,project_id,run_id,claim,evidence_json,state,created_at,resolved_at,reviewer,target_note)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        item.id, item.projectId, item.runId ?? null, item.claim, JSON.stringify(item.evidence), item.state,
        item.createdAt, item.resolvedAt ?? null, item.reviewer ?? null, item.targetNote ?? null
      );
  }

  getMemoryProposal(id: string): MemoryProposal | null {
    const row = this.db.prepare("SELECT * FROM memory_proposals WHERE id=?").get(id) as any;
    return row ? this.mapMemoryProposal(row) : null;
  }

  listMemoryProposals(state?: string): MemoryProposal[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM memory_proposals WHERE state=? ORDER BY created_at DESC").all(state)
      : this.db.prepare("SELECT * FROM memory_proposals ORDER BY created_at DESC").all();
    return (rows as any[]).map(this.mapMemoryProposal);
  }

  resolveMemoryProposal(id: string, state: string, reviewer: string, targetNote?: string): void {
    this.db.prepare(`UPDATE memory_proposals SET state=?, reviewer=?, target_note=?, resolved_at=? WHERE id=?`)
      .run(state, reviewer, targetNote ?? null, nowIso(), id);
  }

  private mapProject = (r: any): Project => ({
    id: r.id, name: r.name, objective: r.objective, currentMilestone: r.current_milestone,
    health: r.health, linearTeam: r.linear_team, repository: r.repository, vaultPath: r.vault_path,
    memoryNamespace: r.memory_namespace, createdAt: r.created_at
  });

  private mapTask = (r: any): Task => ({
    id: r.id, projectId: r.project_id, source: r.source, sourceId: r.source_id, title: r.title,
    objective: r.objective, status: r.status, priority: r.priority, createdAt: r.created_at
  });

  private mapRun = (r: any): Run => ({
    id: r.id, taskId: r.task_id, projectId: r.project_id, rootRuntime: r.root_runtime,
    workflow: r.workflow, status: r.status, stage: r.stage, stageIndex: Number(r.stage_index),
    budgetUsd: Number(r.budget_usd), costUsd: Number(r.cost_usd), workspaceId: r.workspace_id,
    nativeRunId: r.native_run_id, nextActionAt: r.next_action_at, startedAt: r.started_at,
    completedAt: r.completed_at, metadata: parseJson(r.metadata_json, {}), createdAt: r.created_at
  });

  private mapEvent = (r: any): RunEvent => ({
    seq: Number(r.seq), id: r.id, runId: r.run_id, type: r.type, message: r.message,
    payload: parseJson(r.payload_json, {}), createdAt: r.created_at
  });

  private mapApproval = (r: any): Approval => ({
    id: r.id, runId: r.run_id, action: r.action, exactEffect: r.exact_effect, state: r.state,
    evidence: parseJson(r.evidence_json, []), requestedAt: r.requested_at, resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by, decision: r.decision
  });

  private mapMemoryProposal = (r: any): MemoryProposal => ({
    id: r.id, projectId: r.project_id, runId: r.run_id, claim: r.claim,
    evidence: parseJson(r.evidence_json, []), state: r.state, createdAt: r.created_at,
    resolvedAt: r.resolved_at, reviewer: r.reviewer, targetNote: r.target_note
  });
}
