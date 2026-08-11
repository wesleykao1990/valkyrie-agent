import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Approval, Artifact, MemoryProposal, Project, Run, RunEvent, Task } from "./types.ts";
import { nowIso } from "./ids.ts";
import { assertUniqueMigrationVersions, loadMigrationFiles } from "./migrations.ts";
import {
  canonicalJson,
  decodeJson,
  deterministicOutboxId,
  IdempotencyConflictError,
  StorageConflictError,
  type ApprovalResolutionInput,
  type ApprovalResolutionResult,
  type ApprovalRequestInput,
  type ApprovalRequestResult,
  type ControlPlaneStore,
  type IdempotencyInput,
  type MigrationResult,
  type MutableRunPatch,
  type OutboxEvent,
  type ReconciliationCandidates,
  type RunBundleInput,
  type RunBundleResult,
  type StoreHealth,
  type StoredIdempotencyRecord,
  type WorkspaceLease,
  type WorkspaceLeaseResult,
  type WorkspaceRecord,
} from "./store.ts";

export class SqliteStore implements ControlPlaneStore {
  readonly backend = "sqlite" as const;
  private db: DatabaseSync;
  private initialMigrationResults: MigrationResult[];

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.initialMigrationResults = this.applyMigrations();
  }

  async close(): Promise<void> { this.db.close(); }

  async migrate(): Promise<MigrationResult[]> {
    const initial = this.initialMigrationResults;
    this.initialMigrationResults = [];
    return initial.length > 0 ? initial : this.applyMigrations();
  }

  async healthCheck(): Promise<StoreHealth> {
    try {
      const expected = loadMigrationFiles("sqlite");
      const rows = this.db.prepare("SELECT version, checksum FROM schema_migrations").all() as any[];
      const applied = new Map(rows.map((row) => [Number(row.version), String(row.checksum)]));
      return {
        ok: Number((this.db.prepare("SELECT 1 AS ok").get() as any).ok) === 1,
        backend: this.backend,
        migrationsCurrent: rows.length === expected.length && expected.every((item) => applied.get(item.version) === item.checksum),
      };
    } catch {
      return { ok: false, backend: this.backend, migrationsCurrent: false };
    }
  }

  private applyMigrations(): MigrationResult[] {
    const files = loadMigrationFiles("sqlite");
    assertUniqueMigrationVersions(files);
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const knownVersions = new Set(files.map((file) => file.version));
    const unknown = (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as any[])
      .map((row) => Number(row.version))
      .filter((version) => !knownVersions.has(version));
    if (unknown.length > 0) throw new Error(`SQLite database contains unknown migration version(s): ${unknown.join(", ")}`);
    const results: MigrationResult[] = [];
    for (const file of files) {
      const existing = this.db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=?").get(file.version) as any;
      if (existing) {
        if (String(existing.checksum) !== file.checksum) {
          throw new Error(`Migration checksum mismatch for SQLite ${file.name}`);
        }
        results.push({ version: file.version, name: file.name, checksum: file.checksum, status: "already_applied" });
        continue;
      }
      this.transaction(() => {
        this.db.exec(file.sql);
        this.db.prepare("INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (?,?,?,?)")
          .run(file.version, file.name, file.checksum, nowIso());
      });
      results.push({ version: file.version, name: file.name, checksum: file.checksum, status: "applied" });
    }
    return results;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  async resetOperationalData(): Promise<void> {
    this.transaction(() => this.db.exec(`
      DELETE FROM idempotency_keys;
      DELETE FROM outbox_events;
      DELETE FROM workspace_leases;
      DELETE FROM artifacts;
      DELETE FROM approvals;
      DELETE FROM run_events;
      DELETE FROM memory_proposals;
      UPDATE runs SET workspace_id=NULL;
      DELETE FROM workspaces;
      DELETE FROM runs;
      DELETE FROM tasks;
    `));
  }

  async seedProjects(items: Array<Record<string, unknown>>): Promise<void> {
    this.transaction(() => {
      const stmt = this.db.prepare(`INSERT INTO projects
        (id,name,objective,current_milestone,health,linear_team,repository,vault_path,memory_namespace,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      for (const item of items) {
        stmt.run(
          String(item.id), String(item.name), String(item.objective), String(item.currentMilestone),
          String(item.health), String(item.linearTeam), String(item.repository), String(item.vaultPath),
          String(item.memoryNamespace), nowIso(),
        );
      }
    });
  }

  async listProjects(): Promise<Project[]> {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name").all() as any[]).map(this.mapProject);
  }

  async getProject(id: string): Promise<Project | null> {
    return this.getProjectRow(id);
  }

  private getProjectRow(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as any;
    return row ? this.mapProject(row) : null;
  }

  async createTask(task: Task): Promise<void> {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO tasks
        (id,project_id,source,source_id,title,objective,status,priority,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
          task.id, task.projectId, task.source, task.sourceId ?? null, task.title, task.objective,
          task.status, task.priority, task.createdAt,
        );
      this.insertOutbox("task.created", task.id, { taskId: task.id, projectId: task.projectId }, task.id);
    });
  }

  async listTasks(projectId?: string): Promise<Task[]> {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC").all(projectId)
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
    return (rows as any[]).map(this.mapTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    return row ? this.mapTask(row) : null;
  }

  async findTaskBySimilarTitle(projectId: string, title: string): Promise<Task | null> {
    const normalized = title.trim().toLowerCase();
    const rows = this.db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC").all(projectId) as any[];
    return rows.map(this.mapTask).find((task) => {
      const current = task.title.trim().toLowerCase();
      return current === normalized || current.includes(normalized) || normalized.includes(current);
    }) ?? null;
  }

  async createRun(run: Run): Promise<void> {
    await this.createRunBundle({ run });
  }

  async createRunBundle(input: RunBundleInput): Promise<RunBundleResult> {
    if (Boolean(input.workspace) !== Boolean(input.lease)) {
      throw new StorageConflictError("A run bundle must contain both workspace and lease, or neither");
    }
    if (input.workspace && input.lease) this.validateWorkspaceLease(input.workspace, input.lease, input.run.id);
    const effectiveRun: Run = input.workspace && !input.run.workspaceId
      ? { ...input.run, workspaceId: input.workspace.id }
      : input.run;
    if (input.workspace && effectiveRun.workspaceId !== input.workspace.id) {
      throw new StorageConflictError("Run workspace ID does not match bundled workspace");
    }

    return this.transaction(() => {
      const replay = input.idempotency ? this.replayRunBundle(input.idempotency) : null;
      if (replay) return replay;

      // Insert without the circular reference, then link ownership after the
      // workspace and lease exist. Migration triggers validate the final link.
      this.insertRun(input.workspace ? { ...effectiveRun, workspaceId: null } : effectiveRun);
      if (input.workspace && input.lease) {
        this.insertWorkspace(input.workspace);
        this.insertLease(input.lease);
        this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(input.workspace.id, effectiveRun.id);
        this.insertOutbox("workspace.lease.acquired", input.workspace.id, {
          workspaceId: input.workspace.id, runId: effectiveRun.id, mode: input.lease.mode,
        }, input.lease.workspaceId);
      }
      this.insertOutbox("run.created", effectiveRun.id, {
        runId: effectiveRun.id, projectId: effectiveRun.projectId, rootRuntime: effectiveRun.rootRuntime,
      }, effectiveRun.id);

      const result: RunBundleResult = {
        run: effectiveRun,
        workspace: input.workspace,
        lease: input.lease,
        replayed: false,
      };
      if (input.idempotency) {
        this.insertIdempotency(input.idempotency, "run", effectiveRun.id, {
          runId: effectiveRun.id,
          workspaceId: input.workspace?.id ?? null,
        });
      }
      return result;
    });
  }

  private insertRun(run: Run): void {
    this.db.prepare(`INSERT INTO runs
      (id,task_id,project_id,root_runtime,workflow,status,stage,stage_index,budget_usd,cost_usd,
       workspace_id,native_run_id,next_action_at,started_at,completed_at,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        run.id, run.taskId ?? null, run.projectId, run.rootRuntime, run.workflow ?? null, run.status,
        run.stage ?? null, run.stageIndex, run.budgetUsd, run.costUsd, run.workspaceId ?? null,
        run.nativeRunId ?? null, run.nextActionAt ?? null, run.startedAt ?? null, run.completedAt ?? null,
        JSON.stringify(run.metadata ?? {}), run.createdAt,
      );
  }

  private replayRunBundle(idempotency: IdempotencyInput): RunBundleResult | null {
    const existing = this.getIdempotencyRow(idempotency.scope, idempotency.key);
    if (!existing) return null;
    if (existing.requestHash !== idempotency.requestHash) throw new IdempotencyConflictError();
    if (existing.resourceType !== "run") throw new IdempotencyConflictError("Idempotency key refers to another resource type");
    const run = this.getRunRow(existing.resourceId);
    if (!run) throw new StorageConflictError("Idempotency record refers to a missing run");
    const workspace = run.workspaceId ? this.getWorkspaceRow(run.workspaceId) ?? undefined : undefined;
    const lease = workspace ? this.getLeaseRow(workspace.id) ?? undefined : undefined;
    return { run, workspace, lease, replayed: true };
  }

  async updateRun(id: string, patch: MutableRunPatch): Promise<void> {
    this.transaction(() => {
      if (!this.updateRunRow(id, patch)) return;
      this.insertOutbox("run.updated", id, { runId: id, patch }, canonicalJson(patch));
    });
  }

  private updateRunRow(id: string, patch: MutableRunPatch): boolean {
    const mapping: Record<string, string> = {
      status: "status", stage: "stage", stageIndex: "stage_index", costUsd: "cost_usd", nativeRunId: "native_run_id",
      nextActionAt: "next_action_at", startedAt: "started_at", completedAt: "completed_at",
      metadata: "metadata_json",
    };
    const invalid = Object.keys(patch).filter((key) => !(key in mapping));
    if (invalid.length > 0) throw new StorageConflictError(`Run identity and ownership fields are immutable: ${invalid.join(", ")}`);
    const entries = Object.entries(patch);
    if (entries.length === 0) return false;
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of entries) {
      sets.push(`${mapping[key]}=?`);
      values.push(key === "metadata" ? JSON.stringify(value ?? {}) : value ?? null);
    }
    values.push(id);
    const result = this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id=?`).run(...values) as any;
    return Number(result.changes) > 0;
  }

  async getRun(id: string): Promise<Run | null> { return this.getRunRow(id); }

  private getRunRow(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as any;
    return row ? this.mapRun(row) : null;
  }

  async listRuns(limit = 100): Promise<Run[]> {
    return (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map(this.mapRun);
  }

  async listRunnableRuns(now: string): Promise<Run[]> {
    return (this.db.prepare(`SELECT * FROM runs
      WHERE status='running' AND next_action_at IS NOT NULL AND next_action_at<=?
        AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=?)
      ORDER BY next_action_at ASC LIMIT 20`).all(now, now) as any[]).map(this.mapRun);
  }

  async claimRunnableRuns(now: string, claimUntil: string, workerId: string, limit = 20): Promise<Run[]> {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM runs
        WHERE status='running' AND next_action_at IS NOT NULL AND next_action_at<=?
          AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=?)
        ORDER BY next_action_at ASC LIMIT ?`).all(now, now, limit) as any[];
      const claimed: Run[] = [];
      const update = this.db.prepare(`UPDATE runs SET worker_claimed_by=?, worker_claim_expires_at=?
        WHERE id=? AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=?)`);
      for (const row of rows) {
        const result = update.run(workerId, claimUntil, row.id, now) as any;
        if (Number(result.changes) === 1) {
          const run = this.getRunRow(String(row.id));
          if (run) claimed.push(run);
        }
      }
      return claimed;
    });
  }

  async releaseRunClaim(runId: string, workerId: string): Promise<void> {
    this.db.prepare("UPDATE runs SET worker_claimed_by=NULL, worker_claim_expires_at=NULL WHERE id=? AND worker_claimed_by=?")
      .run(runId, workerId);
  }

  async appendEvent(event: Omit<RunEvent, "seq">): Promise<RunEvent> {
    return this.transaction(() => this.insertEvent(event));
  }

  private insertEvent(event: Omit<RunEvent, "seq">): RunEvent {
    const existing = this.db.prepare("SELECT * FROM run_events WHERE id=?").get(event.id) as any;
    if (existing) {
      const mapped = this.mapEvent(existing);
      if (mapped.runId !== event.runId || mapped.type !== event.type || mapped.message !== event.message ||
          canonicalJson(mapped.payload) !== canonicalJson(event.payload)) {
        throw new StorageConflictError(`Event ${event.id} was already used with different content`);
      }
      return mapped;
    }
    const result = this.db.prepare(`INSERT INTO run_events
      (id,run_id,type,message,payload_json,created_at) VALUES (?,?,?,?,?,?)`).run(
        event.id, event.runId, event.type, event.message, JSON.stringify(event.payload ?? {}), event.createdAt,
      ) as any;
    const stored = { ...event, seq: Number(result.lastInsertRowid) };
    this.insertOutbox("run.event.appended", event.runId, {
      eventId: event.id, runId: event.runId, type: event.type, seq: stored.seq,
    }, event.id);
    return stored;
  }

  async listEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    return (this.db.prepare("SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq ASC").all(runId, afterSeq) as any[])
      .map(this.mapEvent);
  }

  async createWorkspace(workspace: WorkspaceRecord): Promise<void> {
    this.transaction(() => {
      this.insertWorkspace(workspace);
      this.insertOutbox("workspace.created", workspace.id, { workspaceId: workspace.id, runId: workspace.runId }, workspace.id);
    });
  }

  private insertWorkspace(workspace: WorkspaceRecord): void {
    this.db.prepare("INSERT INTO workspaces (id,run_id,path,provider,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(workspace.id, workspace.runId, workspace.path, workspace.provider, workspace.status, workspace.createdAt);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> { return this.getWorkspaceRow(id); }

  private getWorkspaceRow(id: string): WorkspaceRecord | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id=?").get(id) as any;
    return row ? this.mapWorkspace(row) : null;
  }

  async getWorkspaceForRun(runId: string): Promise<WorkspaceRecord | null> {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE run_id=?").get(runId) as any;
    return row ? this.mapWorkspace(row) : null;
  }

  async updateWorkspaceStatus(id: string, status: string): Promise<void> {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE workspaces SET status=? WHERE id=?").run(status, id) as any;
      if (Number(result.changes) > 0) this.insertOutbox("workspace.updated", id, { workspaceId: id, status }, status);
    });
  }

  async createLease(lease: WorkspaceLease): Promise<void> {
    this.transaction(() => {
      const workspace = this.getWorkspaceRow(lease.workspaceId);
      if (!workspace || workspace.runId !== lease.runId) throw new StorageConflictError("Lease owner does not match workspace owner");
      const run = this.getRunRow(lease.runId);
      if (!run || (run.workspaceId && run.workspaceId !== lease.workspaceId)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      this.insertLease(lease);
      this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=? AND workspace_id IS NULL").run(lease.workspaceId, lease.runId);
      this.insertOutbox("workspace.lease.acquired", lease.workspaceId, {
        workspaceId: lease.workspaceId, runId: lease.runId, mode: lease.mode,
      }, lease.workspaceId);
    });
  }

  private insertLease(lease: WorkspaceLease): void {
    this.db.prepare("INSERT INTO workspace_leases (workspace_id,run_id,mode,expires_at,heartbeat_at) VALUES (?,?,?,?,?)")
      .run(lease.workspaceId, lease.runId, lease.mode, lease.expiresAt, lease.heartbeatAt);
  }

  async createWorkspaceLease(workspace: WorkspaceRecord, lease: WorkspaceLease): Promise<WorkspaceLeaseResult> {
    this.validateWorkspaceLease(workspace, lease, workspace.runId);
    return this.transaction(() => {
      const run = this.getRunRow(workspace.runId);
      if (!run || (run.workspaceId && run.workspaceId !== workspace.id)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      const existingWorkspace = this.getWorkspaceRow(workspace.id);
      const existingLease = this.getLeaseRow(lease.workspaceId);
      if (existingWorkspace || existingLease) {
        if (existingWorkspace?.runId === workspace.runId && existingLease?.runId === lease.runId &&
            existingLease.mode === lease.mode) {
          if (!run.workspaceId) this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(workspace.id, run.id);
          return { workspace: existingWorkspace, lease: existingLease, replayed: true };
        }
        throw new StorageConflictError("Workspace or lease ID is already owned by another run");
      }
      this.insertWorkspace(workspace);
      this.insertLease(lease);
      this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(workspace.id, run.id);
      this.insertOutbox("workspace.lease.acquired", workspace.id, {
        workspaceId: workspace.id, runId: workspace.runId, mode: lease.mode,
      }, workspace.id);
      return { workspace, lease, replayed: false };
    });
  }

  private validateWorkspaceLease(workspace: WorkspaceRecord, lease: WorkspaceLease, runId: string): void {
    if (workspace.runId !== runId || lease.runId !== runId || lease.workspaceId !== workspace.id) {
      throw new StorageConflictError("Workspace, lease, and run ownership must match");
    }
    if (lease.mode !== "writer") throw new StorageConflictError("Writing candidates require a writer lease");
  }

  async heartbeatLease(workspaceId: string, runId: string, heartbeatAt: string, expiresAt: string): Promise<boolean> {
    const result = this.db.prepare(`UPDATE workspace_leases SET heartbeat_at=?, expires_at=?
      WHERE workspace_id=? AND run_id=? AND expires_at>?`).run(heartbeatAt, expiresAt, workspaceId, runId, heartbeatAt) as any;
    return Number(result.changes) === 1;
  }

  async releaseLease(workspaceId: string): Promise<void> {
    this.transaction(() => {
      const lease = this.getLeaseRow(workspaceId);
      if (!lease) return;
      this.db.prepare("DELETE FROM workspace_leases WHERE workspace_id=?").run(workspaceId);
      this.insertOutbox("workspace.lease.released", workspaceId, {
        workspaceId, runId: lease.runId,
      }, `${workspaceId}:${lease.heartbeatAt}`);
    });
  }

  async releaseWorkspaceLease(workspaceId: string, runId: string): Promise<boolean> {
    return this.transaction(() => {
      const lease = this.getLeaseRow(workspaceId);
      if (!lease) return false;
      if (lease.runId !== runId) throw new StorageConflictError("Only the owning run may release a writer lease");
      const deleted = this.db.prepare("DELETE FROM workspace_leases WHERE workspace_id=? AND run_id=?").run(workspaceId, runId) as any;
      if (Number(deleted.changes) !== 1) return false;
      this.db.prepare("UPDATE workspaces SET status='released' WHERE id=? AND run_id=?").run(workspaceId, runId);
      this.insertOutbox("workspace.lease.released", workspaceId, { workspaceId, runId }, `${workspaceId}:${lease.heartbeatAt}`);
      return true;
    });
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    return (this.db.prepare("SELECT * FROM workspace_leases ORDER BY heartbeat_at DESC").all() as any[]).map(this.mapLease);
  }

  private getLeaseRow(workspaceId: string): WorkspaceLease | null {
    const row = this.db.prepare("SELECT * FROM workspace_leases WHERE workspace_id=?").get(workspaceId) as any;
    return row ? this.mapLease(row) : null;
  }

  async requestApprovalTransaction(input: ApprovalRequestInput): Promise<ApprovalRequestResult> {
    if (input.approval.state !== "pending") throw new StorageConflictError("A requested approval must be pending");
    if (input.event.runId !== input.approval.runId) throw new StorageConflictError("Approval request event must belong to the approval run");
    return this.transaction(() => {
      const idempotency = input.idempotency
        ? this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key)
        : null;
      if (idempotency) {
        if (idempotency.requestHash !== input.idempotency!.requestHash) throw new IdempotencyConflictError();
        if (idempotency.resourceType !== "approval" || idempotency.resourceId !== input.approval.id) {
          throw new IdempotencyConflictError("Idempotency key refers to another approval or resource type");
        }
        const approval = this.getApprovalRow(input.approval.id);
        if (!approval) throw new StorageConflictError("Idempotency record refers to a missing approval");
        this.assertApprovalRequestCompatible(approval, input.approval, true);
        const run = this.getRunRow(approval.runId);
        const eventRow = this.db.prepare("SELECT * FROM run_events WHERE id=?").get(input.event.id) as any;
        if (!run || !eventRow) throw new StorageConflictError("Approval request replay is missing its run or event");
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        return { approval, run, event, replayed: true };
      }

      const existing = this.getApprovalRow(input.approval.id);
      if (existing) {
        this.assertApprovalRequestCompatible(existing, input.approval, false);
        const run = this.getRunRow(existing.runId);
        const eventRow = this.db.prepare("SELECT * FROM run_events WHERE id=?").get(input.event.id) as any;
        if (!run || run.status !== "awaiting_approval" || !eventRow) {
          throw new StorageConflictError("Existing approval request is not in a replayable pending state");
        }
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        if (input.idempotency) {
          this.insertIdempotency(input.idempotency, "approval", existing.id, { approvalId: existing.id, runId: existing.runId });
        }
        return { approval: existing, run, event, replayed: true };
      }

      const run = this.getRunRow(input.approval.runId);
      if (!run) throw new StorageConflictError("Approval run not found");
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw new StorageConflictError("A terminal run cannot request approval");
      }
      this.insertApproval(input.approval);
      const patch: MutableRunPatch = { status: "awaiting_approval", stage: "approval", nextActionAt: null };
      if (!this.updateRunRow(run.id, patch)) throw new StorageConflictError("Approval run could not be transitioned");
      this.insertOutbox("approval.requested", input.approval.id, {
        approvalId: input.approval.id, runId: input.approval.runId, action: input.approval.action,
      }, input.approval.id);
      this.insertOutbox("run.updated", run.id, { runId: run.id, patch }, canonicalJson(patch));
      const event = this.insertEvent(input.event);
      if (input.idempotency) {
        this.insertIdempotency(input.idempotency, "approval", input.approval.id, {
          approvalId: input.approval.id, runId: input.approval.runId,
        });
      }
      return { approval: input.approval, run: this.getRunRow(run.id)!, event, replayed: false };
    });
  }

  private assertApprovalRequestCompatible(stored: Approval, requested: Approval, allowResolved: boolean): void {
    const stateCompatible = allowResolved ? true : stored.state === "pending";
    if (!stateCompatible || stored.id !== requested.id || stored.runId !== requested.runId ||
        stored.action !== requested.action || stored.exactEffect !== requested.exactEffect ||
        stored.requestedAt !== requested.requestedAt || canonicalJson(stored.evidence) !== canonicalJson(requested.evidence)) {
      throw new StorageConflictError(`Approval ${requested.id} was already used with different request content`);
    }
  }

  private assertEventCompatible(stored: RunEvent, requested: Omit<RunEvent, "seq">): void {
    if (stored.runId !== requested.runId || stored.type !== requested.type || stored.message !== requested.message ||
        canonicalJson(stored.payload) !== canonicalJson(requested.payload)) {
      throw new StorageConflictError(`Event ${requested.id} was already used with different content`);
    }
  }

  private insertApproval(approval: Approval): void {
    this.db.prepare(`INSERT INTO approvals
      (id,run_id,action,exact_effect,state,evidence_json,requested_at,resolved_at,resolved_by,decision)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        approval.id, approval.runId, approval.action, approval.exactEffect, approval.state,
        JSON.stringify(approval.evidence), approval.requestedAt, approval.resolvedAt ?? null,
        approval.resolvedBy ?? null, approval.decision ?? null,
      );
  }

  async getApproval(id: string): Promise<Approval | null> { return this.getApprovalRow(id); }

  private getApprovalRow(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as any;
    return row ? this.mapApproval(row) : null;
  }

  async listApprovals(state?: string): Promise<Approval[]> {
    const rows = state
      ? this.db.prepare("SELECT * FROM approvals WHERE state=? ORDER BY requested_at DESC").all(state)
      : this.db.prepare("SELECT * FROM approvals ORDER BY requested_at DESC").all();
    return (rows as any[]).map(this.mapApproval);
  }

  async resolveApproval(id: string, state: string, decision: string, resolvedBy: string): Promise<void> {
    await this.resolveApprovalTransaction({ approvalId: id, state, decision, resolvedBy });
  }

  async resolveApprovalTransaction(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult> {
    return this.transaction(() => {
      if (input.idempotency) {
        const record = this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key);
        if (record) {
          if (record.requestHash !== input.idempotency.requestHash) throw new IdempotencyConflictError();
          if (record.resourceType !== "approval" || record.resourceId !== input.approvalId) {
            throw new IdempotencyConflictError("Idempotency key refers to another approval or resource type");
          }
          const approval = this.getApprovalRow(input.approvalId);
          if (!approval) throw new StorageConflictError("Idempotency record refers to a missing approval");
          if (input.event && input.event.runId !== approval.runId) {
            throw new StorageConflictError("Approval resolution event must belong to the approval run");
          }
          const run = this.getRunRow(approval.runId);
          if (!run) throw new StorageConflictError("Approval refers to a missing run");
          return { approval, run, replayed: true };
        }
      }

      const current = this.getApprovalRow(input.approvalId);
      if (!current) throw new StorageConflictError("Approval not found");
      if (input.event && input.event.runId !== current.runId) {
        throw new StorageConflictError("Approval resolution event must belong to the approval run");
      }
      let replayed = false;
      if (current.state !== "pending") {
        if (current.state !== input.state || current.decision !== input.decision) {
          throw new StorageConflictError("Approval has already been resolved with a different decision");
        }
        replayed = true;
      } else {
        const result = this.db.prepare(`UPDATE approvals
          SET state=?, decision=?, resolved_by=?, resolved_at=? WHERE id=? AND state='pending'`)
          .run(input.state, input.decision, input.resolvedBy, input.resolvedAt ?? nowIso(), input.approvalId) as any;
        if (Number(result.changes) !== 1) throw new StorageConflictError("Approval resolution lost a concurrent race");
      }

      if (!replayed && input.runPatch) this.updateRunRow(current.runId, input.runPatch);
      const storedEvent = !replayed && input.event ? this.insertEvent(input.event) : undefined;
      if (!replayed) {
        this.insertOutbox("approval.resolved", input.approvalId, {
          approvalId: input.approvalId, runId: current.runId, state: input.state, decision: input.decision,
        }, input.decision);
      }
      // A compatible replay may introduce a fresh transport-level key. Bind it
      // to this exact approval even though the business transition is already complete.
      if (input.idempotency) {
        this.insertIdempotency(input.idempotency, "approval", input.approvalId, {
          approvalId: input.approvalId, runId: current.runId,
        });
      }
      const approval = this.getApprovalRow(input.approvalId)!;
      const run = this.getRunRow(current.runId)!;
      return { approval, run, event: storedEvent, replayed };
    });
  }

  async createArtifact(artifact: Artifact): Promise<void> {
    this.transaction(() => {
      this.db.prepare("INSERT INTO artifacts (id,run_id,kind,uri,checksum,media_type,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(artifact.id, artifact.runId, artifact.kind, artifact.uri, artifact.checksum, artifact.mediaType, artifact.createdAt);
      this.insertOutbox("artifact.created", artifact.id, {
        artifactId: artifact.id, runId: artifact.runId, kind: artifact.kind, checksum: artifact.checksum,
      }, artifact.id);
    });
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return (this.db.prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at").all(runId) as any[]).map(this.mapArtifact);
  }

  async createMemoryProposal(item: MemoryProposal): Promise<void> {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO memory_proposals
        (id,project_id,run_id,claim,evidence_json,state,created_at,resolved_at,reviewer,target_note)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          item.id, item.projectId, item.runId ?? null, item.claim, JSON.stringify(item.evidence), item.state,
          item.createdAt, item.resolvedAt ?? null, item.reviewer ?? null, item.targetNote ?? null,
        );
      this.insertOutbox("memory.proposed", item.id, {
        proposalId: item.id, projectId: item.projectId, runId: item.runId ?? null,
      }, item.id);
    });
  }

  async getMemoryProposal(id: string): Promise<MemoryProposal | null> { return this.getMemoryProposalRow(id); }

  private getMemoryProposalRow(id: string): MemoryProposal | null {
    const row = this.db.prepare("SELECT * FROM memory_proposals WHERE id=?").get(id) as any;
    return row ? this.mapMemoryProposal(row) : null;
  }

  async listMemoryProposals(state?: string): Promise<MemoryProposal[]> {
    const rows = state
      ? this.db.prepare("SELECT * FROM memory_proposals WHERE state=? ORDER BY created_at DESC").all(state)
      : this.db.prepare("SELECT * FROM memory_proposals ORDER BY created_at DESC").all();
    return (rows as any[]).map(this.mapMemoryProposal);
  }

  async resolveMemoryProposal(id: string, state: string, reviewer: string, targetNote?: string): Promise<void> {
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE memory_proposals
        SET state=?, reviewer=?, target_note=?, resolved_at=? WHERE id=? AND state='proposed'`)
        .run(state, reviewer, targetNote ?? null, nowIso(), id) as any;
      if (Number(result.changes) === 0) {
        const current = this.getMemoryProposalRow(id);
        if (!current || current.state !== state) throw new StorageConflictError("Memory proposal is missing or already resolved differently");
        return;
      }
      this.insertOutbox("memory.resolved", id, { proposalId: id, state, reviewer, targetNote: targetNote ?? null }, state);
    });
  }

  async getIdempotencyRecord(scope: string, key: string): Promise<StoredIdempotencyRecord | null> {
    return this.getIdempotencyRow(scope, key);
  }

  private getIdempotencyRow(scope: string, key: string): StoredIdempotencyRecord | null {
    const row = this.db.prepare("SELECT * FROM idempotency_keys WHERE scope=? AND key=?").get(scope, key) as any;
    return row ? this.mapIdempotency(row) : null;
  }

  private insertIdempotency(input: IdempotencyInput, resourceType: string, resourceId: string, response: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO idempotency_keys
      (scope,key,request_hash,resource_type,resource_id,response_json,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        input.scope, input.key, input.requestHash, resourceType, resourceId,
        JSON.stringify(response), nowIso(), input.expiresAt ?? null,
      );
  }

  private insertOutbox(topic: string, aggregateId: string, payload: Record<string, unknown>, discriminator: string): void {
    const createdAt = nowIso();
    const outboxId = deterministicOutboxId(topic, aggregateId, discriminator);
    const existing = this.db.prepare("SELECT topic,aggregate_id,payload_json FROM outbox_events WHERE id=?").get(outboxId) as any;
    if (existing) {
      if (existing.topic !== topic || existing.aggregate_id !== aggregateId ||
          canonicalJson(decodeJson(existing.payload_json, {})) !== canonicalJson(payload)) {
        throw new StorageConflictError(`Outbox ID ${outboxId} was already used with different content`);
      }
      return;
    }
    this.db.prepare(`INSERT INTO outbox_events
      (id,topic,aggregate_id,payload_json,created_at,available_at,published_at,attempts,last_error)
      VALUES (?,?,?,?,?,?,NULL,0,NULL)`).run(
        outboxId, topic, aggregateId,
        JSON.stringify(payload), createdAt, createdAt,
      );
  }

  async listPendingOutbox(limit = 100): Promise<OutboxEvent[]> {
    return (this.db.prepare(`SELECT * FROM outbox_events
      WHERE published_at IS NULL AND available_at<=? ORDER BY created_at,id LIMIT ?`).all(nowIso(), limit) as any[])
      .map(this.mapOutbox);
  }

  async markOutboxPublished(id: string, publishedAt: string): Promise<boolean> {
    const result = this.db.prepare(`UPDATE outbox_events SET published_at=?, last_error=NULL
      WHERE id=? AND published_at IS NULL`).run(publishedAt, id) as any;
    return Number(result.changes) === 1;
  }

  async markOutboxFailed(id: string, error: string, availableAt: string): Promise<boolean> {
    const result = this.db.prepare(`UPDATE outbox_events
      SET attempts=attempts+1,last_error=?,available_at=? WHERE id=? AND published_at IS NULL`)
      .run(error, availableAt, id) as any;
    return Number(result.changes) === 1;
  }

  async listReconciliationCandidates(now: string, outboxLimit = 100): Promise<ReconciliationCandidates> {
    const queuedRuns = (this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created_at").all() as any[]).map(this.mapRun);
    const strandedIds = this.db.prepare(`SELECT a.id FROM approvals a JOIN runs r ON r.id=a.run_id
      WHERE a.state<>'pending' AND r.status='awaiting_approval' ORDER BY a.resolved_at`).all() as any[];
    const strandedApprovals = strandedIds.map((row) => {
      const approval = this.getApprovalRow(String(row.id))!;
      const run = this.getRunRow(approval.runId)!;
      return { approval, run };
    });
    const terminalLeases = (this.db.prepare(`SELECT l.* FROM workspace_leases l JOIN runs r ON r.id=l.run_id
      WHERE r.status IN ('completed','failed','cancelled') ORDER BY l.heartbeat_at`).all() as any[]).map(this.mapLease);
    const expiredLeases = (this.db.prepare("SELECT * FROM workspace_leases WHERE expires_at<=? ORDER BY expires_at").all(now) as any[])
      .map(this.mapLease);
    const pendingOutbox = (this.db.prepare(`SELECT * FROM outbox_events
      WHERE published_at IS NULL AND available_at<=? ORDER BY created_at,id LIMIT ?`).all(now, outboxLimit) as any[])
      .map(this.mapOutbox);
    return { queuedRuns, strandedApprovals, terminalLeases, expiredLeases, pendingOutbox };
  }

  private mapProject = (row: any): Project => ({
    id: row.id, name: row.name, objective: row.objective, currentMilestone: row.current_milestone,
    health: row.health, linearTeam: row.linear_team, repository: row.repository, vaultPath: row.vault_path,
    memoryNamespace: row.memory_namespace, createdAt: row.created_at,
  });

  private mapTask = (row: any): Task => ({
    id: row.id, projectId: row.project_id, source: row.source, sourceId: row.source_id, title: row.title,
    objective: row.objective, status: row.status, priority: row.priority, createdAt: row.created_at,
  });

  private mapRun = (row: any): Run => ({
    id: row.id, taskId: row.task_id, projectId: row.project_id, rootRuntime: row.root_runtime,
    workflow: row.workflow, status: row.status, stage: row.stage, stageIndex: Number(row.stage_index),
    budgetUsd: Number(row.budget_usd), costUsd: Number(row.cost_usd), workspaceId: row.workspace_id,
    nativeRunId: row.native_run_id, nextActionAt: row.next_action_at, startedAt: row.started_at,
    completedAt: row.completed_at, metadata: decodeJson(row.metadata_json, {}), createdAt: row.created_at,
  });

  private mapEvent = (row: any): RunEvent => ({
    seq: Number(row.seq), id: row.id, runId: row.run_id, type: row.type, message: row.message,
    payload: decodeJson(row.payload_json, {}), createdAt: row.created_at,
  });

  private mapWorkspace = (row: any): WorkspaceRecord => ({
    id: row.id, runId: row.run_id, path: row.path, provider: row.provider, status: row.status, createdAt: row.created_at,
  });

  private mapLease = (row: any): WorkspaceLease => ({
    workspaceId: row.workspace_id, runId: row.run_id, mode: row.mode,
    expiresAt: row.expires_at, heartbeatAt: row.heartbeat_at,
  });

  private mapApproval = (row: any): Approval => ({
    id: row.id, runId: row.run_id, action: row.action, exactEffect: row.exact_effect, state: row.state,
    evidence: decodeJson(row.evidence_json, []), requestedAt: row.requested_at, resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by, decision: row.decision,
  });

  private mapArtifact = (row: any): Artifact => ({
    id: row.id, runId: row.run_id, kind: row.kind, uri: row.uri, checksum: row.checksum,
    mediaType: row.media_type, createdAt: row.created_at,
  });

  private mapMemoryProposal = (row: any): MemoryProposal => ({
    id: row.id, projectId: row.project_id, runId: row.run_id, claim: row.claim,
    evidence: decodeJson(row.evidence_json, []), state: row.state, createdAt: row.created_at,
    resolvedAt: row.resolved_at, reviewer: row.reviewer, targetNote: row.target_note,
  });

  private mapOutbox = (row: any): OutboxEvent => ({
    id: row.id, topic: row.topic, aggregateId: row.aggregate_id, payload: decodeJson(row.payload_json, {}),
    createdAt: row.created_at, availableAt: row.available_at, publishedAt: row.published_at,
    attempts: Number(row.attempts), lastError: row.last_error,
  });

  private mapIdempotency = (row: any): StoredIdempotencyRecord => ({
    scope: row.scope, key: row.key, requestHash: row.request_hash, resourceType: row.resource_type,
    resourceId: row.resource_id, response: decodeJson(row.response_json, {}), createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}
