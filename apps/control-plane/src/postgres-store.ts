import type { Approval, Artifact, MemoryProposal, Project, Run, RunEvent, Task } from "./types.ts";
import { nowIso } from "./ids.ts";
import { assertUniqueMigrationVersions, loadMigrationFiles } from "./migrations.ts";
import {
  canonicalJson,
  decodeJson,
  deterministicOutboxId,
  IdempotencyConflictError,
  isoString,
  nullableIsoString,
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

interface QueryResult<Row = any> {
  rows: Row[];
  rowCount: number | null;
}

interface Queryable {
  query<Row = any>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

interface PoolClient extends Queryable {
  release(): void;
}

interface PoolLike extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export interface PostgresStoreOptions {
  databaseUrl: string;
  autoMigrate?: boolean;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  ssl?: boolean | Record<string, unknown>;
}

export class PostgresStore implements ControlPlaneStore {
  readonly backend = "postgres" as const;
  private initialMigrationResults: MigrationResult[] = [];
  private readonly pool: PoolLike;

  private constructor(pool: PoolLike) { this.pool = pool; }

  static async connect(options: PostgresStoreOptions): Promise<PostgresStore> {
    if (!options.databaseUrl) throw new Error("DATABASE_URL is required when PostgreSQL storage is selected");
    // Intentionally lazy: the zero-dependency SQLite demo never resolves pg.
    const pg = await import("pg");
    const pool = new pg.Pool({
      connectionString: options.databaseUrl,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      application_name: options.applicationName ?? "wesley-agent-control-plane",
      ssl: options.ssl,
    }) as unknown as PoolLike;
    const store = new PostgresStore(pool);
    try {
      if (options.autoMigrate) store.initialMigrationResults = await store.applyMigrations();
      else await store.assertMigrationsCurrent();
      const health = await store.healthCheck();
      if (!health.ok || !health.migrationsCurrent) throw new Error("PostgreSQL storage is unavailable or migrations are not current");
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async migrate(): Promise<MigrationResult[]> {
    const initial = this.initialMigrationResults;
    this.initialMigrationResults = [];
    return initial.length > 0 ? initial : this.applyMigrations();
  }

  private async applyMigrations(): Promise<MigrationResult[]> {
    const files = loadMigrationFiles("postgres");
    assertUniqueMigrationVersions(files);
    const client = await this.pool.connect();
    const results: MigrationResult[] = [];
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('wesley-control-plane-migrations'))");
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const knownVersions = new Set(files.map((file) => file.version));
      const ledger = await client.query("SELECT version FROM schema_migrations ORDER BY version");
      const unknown = ledger.rows.map((row) => Number(row.version)).filter((version) => !knownVersions.has(version));
      if (unknown.length > 0) throw new Error(`PostgreSQL database contains unknown migration version(s): ${unknown.join(", ")}`);
      for (const file of files) {
        const existing = await client.query("SELECT name,checksum FROM schema_migrations WHERE version=$1", [file.version]);
        if (existing.rows[0]) {
          if (String(existing.rows[0].checksum) !== file.checksum) {
            throw new Error(`Migration checksum mismatch for PostgreSQL ${file.name}`);
          }
          results.push({ version: file.version, name: file.name, checksum: file.checksum, status: "already_applied" });
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(file.sql);
          await client.query("INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)", [
            file.version, file.name, file.checksum,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
        results.push({ version: file.version, name: file.name, checksum: file.checksum, status: "applied" });
      }
      return results;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('wesley-control-plane-migrations'))").catch(() => undefined);
      client.release();
    }
  }

  private async assertMigrationsCurrent(): Promise<void> {
    const files = loadMigrationFiles("postgres");
    try {
      const result = await this.pool.query("SELECT version,checksum FROM schema_migrations");
      const applied = new Map(result.rows.map((row) => [Number(row.version), String(row.checksum)]));
      if (result.rows.length !== files.length || !files.every((file) => applied.get(file.version) === file.checksum)) {
        throw new Error("PostgreSQL migrations are pending or have changed; run the explicit migration command");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("explicit migration")) throw error;
      throw new Error("PostgreSQL is not initialized; run the explicit migration command", { cause: error });
    }
  }

  async healthCheck(): Promise<StoreHealth> {
    try {
      const [probe, migrations] = await Promise.all([
        this.pool.query("SELECT 1 AS ok"),
        this.pool.query("SELECT version,checksum FROM schema_migrations"),
      ]);
      const applied = new Map(migrations.rows.map((row) => [Number(row.version), String(row.checksum)]));
      const expected = loadMigrationFiles("postgres");
      const current = migrations.rows.length === expected.length && expected.every((file) => applied.get(file.version) === file.checksum);
      return { ok: Number(probe.rows[0]?.ok) === 1, backend: this.backend, migrationsCurrent: current };
    } catch {
      return { ok: false, backend: this.backend, migrationsCurrent: false };
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resetOperationalData(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`TRUNCATE TABLE
        idempotency_keys,outbox_events,workspace_leases,artifacts,approvals,run_events,
        memory_proposals,workspaces,runs,tasks RESTART IDENTITY`);
    });
  }

  async seedProjects(items: Array<Record<string, unknown>>): Promise<void> {
    await this.transaction(async (client) => {
      for (const item of items) {
        await client.query(`INSERT INTO projects
          (id,name,objective,current_milestone,health,linear_team,repository,vault_path,memory_namespace,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`, [
          String(item.id), String(item.name), String(item.objective), String(item.currentMilestone),
          String(item.health), String(item.linearTeam), String(item.repository), String(item.vaultPath),
          String(item.memoryNamespace), nowIso(),
        ]);
      }
    });
  }

  async listProjects(): Promise<Project[]> {
    return (await this.pool.query("SELECT * FROM projects ORDER BY name")).rows.map(this.mapProject);
  }

  async getProject(id: string): Promise<Project | null> {
    const row = (await this.pool.query("SELECT * FROM projects WHERE id=$1", [id])).rows[0];
    return row ? this.mapProject(row) : null;
  }

  async createTask(task: Task): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`INSERT INTO tasks
        (id,project_id,source,source_id,title,objective,status,priority,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        task.id, task.projectId, task.source, task.sourceId ?? null, task.title, task.objective,
        task.status, task.priority, task.createdAt,
      ]);
      await this.insertOutbox(client, "task.created", task.id, { taskId: task.id, projectId: task.projectId }, task.id);
    });
  }

  async listTasks(projectId?: string): Promise<Task[]> {
    const result = projectId
      ? await this.pool.query("SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC", [projectId])
      : await this.pool.query("SELECT * FROM tasks ORDER BY created_at DESC");
    return result.rows.map(this.mapTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const row = (await this.pool.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0];
    return row ? this.mapTask(row) : null;
  }

  async findTaskBySimilarTitle(projectId: string, title: string): Promise<Task | null> {
    const normalized = title.trim().toLowerCase();
    const rows = (await this.pool.query("SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC", [projectId])).rows;
    return rows.map(this.mapTask).find((task) => {
      const current = task.title.trim().toLowerCase();
      return current === normalized || current.includes(normalized) || normalized.includes(current);
    }) ?? null;
  }

  async createRun(run: Run): Promise<void> { await this.createRunBundle({ run }); }

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

    return this.transaction(async (client) => {
      if (input.idempotency) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [input.idempotency.scope, input.idempotency.key]);
        const replay = await this.replayRunBundle(client, input.idempotency);
        if (replay) return replay;
      }
      await this.insertRun(client, effectiveRun);
      if (input.workspace && input.lease) {
        await this.insertWorkspace(client, input.workspace);
        await this.insertLease(client, input.lease);
        await this.insertOutbox(client, "workspace.lease.acquired", input.workspace.id, {
          workspaceId: input.workspace.id, runId: effectiveRun.id, mode: input.lease.mode,
        }, input.lease.workspaceId);
      }
      await this.insertOutbox(client, "run.created", effectiveRun.id, {
        runId: effectiveRun.id, projectId: effectiveRun.projectId, rootRuntime: effectiveRun.rootRuntime,
      }, effectiveRun.id);
      if (input.idempotency) {
        await this.insertIdempotency(client, input.idempotency, "run", effectiveRun.id, {
          runId: effectiveRun.id, workspaceId: input.workspace?.id ?? null,
        });
      }
      return { run: effectiveRun, workspace: input.workspace, lease: input.lease, replayed: false };
    });
  }

  private async insertRun(client: Queryable, run: Run): Promise<void> {
    await client.query(`INSERT INTO runs
      (id,task_id,project_id,root_runtime,workflow,status,stage,stage_index,budget_usd,cost_usd,
       workspace_id,native_run_id,next_action_at,started_at,completed_at,metadata_json,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
      run.id, run.taskId ?? null, run.projectId, run.rootRuntime, run.workflow ?? null, run.status,
      run.stage ?? null, run.stageIndex, run.budgetUsd, run.costUsd, run.workspaceId ?? null,
      run.nativeRunId ?? null, run.nextActionAt ?? null, run.startedAt ?? null, run.completedAt ?? null,
      run.metadata ?? {}, run.createdAt,
    ]);
  }

  private async replayRunBundle(client: Queryable, input: IdempotencyInput): Promise<RunBundleResult | null> {
    const existing = await this.getIdempotencyRow(client, input.scope, input.key);
    if (!existing) return null;
    if (existing.requestHash !== input.requestHash) throw new IdempotencyConflictError();
    if (existing.resourceType !== "run") throw new IdempotencyConflictError("Idempotency key refers to another resource type");
    const run = await this.getRunRow(client, existing.resourceId);
    if (!run) throw new StorageConflictError("Idempotency record refers to a missing run");
    const workspace = run.workspaceId ? await this.getWorkspaceRow(client, run.workspaceId) ?? undefined : undefined;
    const lease = workspace ? await this.getLeaseRow(client, workspace.id) ?? undefined : undefined;
    return { run, workspace, lease, replayed: true };
  }

  async updateRun(id: string, patch: MutableRunPatch): Promise<void> {
    await this.transaction(async (client) => {
      if (!await this.updateRunRow(client, id, patch)) return;
      await this.insertOutbox(client, "run.updated", id, { runId: id, patch }, canonicalJson(patch));
    });
  }

  private async updateRunRow(client: Queryable, id: string, patch: MutableRunPatch): Promise<boolean> {
    const mapping: Record<string, string> = {
      status: "status", stage: "stage", stageIndex: "stage_index", costUsd: "cost_usd", nativeRunId: "native_run_id",
      nextActionAt: "next_action_at", startedAt: "started_at", completedAt: "completed_at",
      metadata: "metadata_json",
    };
    const invalid = Object.keys(patch).filter((key) => !(key in mapping));
    if (invalid.length > 0) throw new StorageConflictError(`Run identity and ownership fields are immutable: ${invalid.join(", ")}`);
    const entries = Object.entries(patch);
    if (entries.length === 0) return false;
    const values = entries.map(([key, value]) => key === "metadata" ? value ?? {} : value ?? null);
    values.push(id);
    const sets = entries.map(([key], index) => `${mapping[key]}=$${index + 1}`);
    const result = await client.query(`UPDATE runs SET ${sets.join(", ")} WHERE id=$${values.length}`, values);
    return result.rowCount === 1;
  }

  async getRun(id: string): Promise<Run | null> { return this.getRunRow(this.pool, id); }

  private async getRunRow(client: Queryable, id: string): Promise<Run | null> {
    const row = (await client.query("SELECT * FROM runs WHERE id=$1", [id])).rows[0];
    return row ? this.mapRun(row) : null;
  }

  async listRuns(limit = 100): Promise<Run[]> {
    return (await this.pool.query("SELECT * FROM runs ORDER BY created_at DESC LIMIT $1", [limit])).rows.map(this.mapRun);
  }

  async listRunnableRuns(now: string): Promise<Run[]> {
    return (await this.pool.query(`SELECT * FROM runs
      WHERE status='running' AND next_action_at IS NOT NULL AND next_action_at<=$1
        AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=$1)
      ORDER BY next_action_at LIMIT 20`, [now])).rows.map(this.mapRun);
  }

  async claimRunnableRuns(now: string, claimUntil: string, workerId: string, limit = 20): Promise<Run[]> {
    const result = await this.transaction((client) => client.query(`WITH candidates AS (
      SELECT id FROM runs
      WHERE status='running' AND next_action_at IS NOT NULL AND next_action_at<=$1
        AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=$1)
      ORDER BY next_action_at FOR UPDATE SKIP LOCKED LIMIT $2
    )
    UPDATE runs r SET worker_claimed_by=$3,worker_claim_expires_at=$4
    FROM candidates c WHERE r.id=c.id RETURNING r.*`, [now, limit, workerId, claimUntil]));
    return result.rows.map(this.mapRun);
  }

  async releaseRunClaim(runId: string, workerId: string): Promise<void> {
    await this.pool.query("UPDATE runs SET worker_claimed_by=NULL,worker_claim_expires_at=NULL WHERE id=$1 AND worker_claimed_by=$2", [runId, workerId]);
  }

  async appendEvent(event: Omit<RunEvent, "seq">): Promise<RunEvent> {
    return this.transaction((client) => this.insertEvent(client, event));
  }

  private async insertEvent(client: Queryable, event: Omit<RunEvent, "seq">): Promise<RunEvent> {
    const inserted = await client.query(`INSERT INTO run_events
      (id,run_id,type,message,payload_json,created_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO NOTHING RETURNING *`, [
      event.id, event.runId, event.type, event.message, event.payload ?? {}, event.createdAt,
    ]);
    const row = inserted.rows[0] ?? (await client.query("SELECT * FROM run_events WHERE id=$1", [event.id])).rows[0];
    if (!row) throw new StorageConflictError(`Event ${event.id} could not be inserted or replayed`);
    const stored = this.mapEvent(row);
    if (stored.runId !== event.runId || stored.type !== event.type || stored.message !== event.message ||
        canonicalJson(stored.payload) !== canonicalJson(event.payload)) {
      throw new StorageConflictError(`Event ${event.id} was already used with different content`);
    }
    await this.insertOutbox(client, "run.event.appended", event.runId, {
      eventId: event.id, runId: event.runId, type: event.type, seq: stored.seq,
    }, event.id);
    return stored;
  }

  async listEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    return (await this.pool.query("SELECT * FROM run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq", [runId, afterSeq])).rows.map(this.mapEvent);
  }

  async createWorkspace(workspace: WorkspaceRecord): Promise<void> {
    await this.transaction(async (client) => {
      await this.insertWorkspace(client, workspace);
      await this.insertOutbox(client, "workspace.created", workspace.id, {
        workspaceId: workspace.id, runId: workspace.runId,
      }, workspace.id);
    });
  }

  private async insertWorkspace(client: Queryable, workspace: WorkspaceRecord): Promise<void> {
    await client.query(`INSERT INTO workspaces (id,run_id,path,provider,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6)`, [
      workspace.id, workspace.runId, workspace.path, workspace.provider, workspace.status, workspace.createdAt,
    ]);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> { return this.getWorkspaceRow(this.pool, id); }

  private async getWorkspaceRow(client: Queryable, id: string): Promise<WorkspaceRecord | null> {
    const row = (await client.query("SELECT * FROM workspaces WHERE id=$1", [id])).rows[0];
    return row ? this.mapWorkspace(row) : null;
  }

  async getWorkspaceForRun(runId: string): Promise<WorkspaceRecord | null> {
    const row = (await this.pool.query("SELECT * FROM workspaces WHERE run_id=$1", [runId])).rows[0];
    return row ? this.mapWorkspace(row) : null;
  }

  async updateWorkspaceStatus(id: string, status: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query("UPDATE workspaces SET status=$1 WHERE id=$2", [status, id]);
      if (result.rowCount === 1) {
        await this.insertOutbox(client, "workspace.updated", id, { workspaceId: id, status }, status);
      }
    });
  }

  async createLease(lease: WorkspaceLease): Promise<void> {
    await this.transaction(async (client) => {
      const workspace = await this.getWorkspaceRow(client, lease.workspaceId);
      if (!workspace || workspace.runId !== lease.runId) throw new StorageConflictError("Lease owner does not match workspace owner");
      const runRow = (await client.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [lease.runId])).rows[0];
      const run = runRow ? this.mapRun(runRow) : null;
      if (!run || (run.workspaceId && run.workspaceId !== lease.workspaceId)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      await this.insertLease(client, lease);
      await client.query("UPDATE runs SET workspace_id=$1 WHERE id=$2 AND workspace_id IS NULL", [lease.workspaceId, lease.runId]);
      await this.insertOutbox(client, "workspace.lease.acquired", lease.workspaceId, {
        workspaceId: lease.workspaceId, runId: lease.runId, mode: lease.mode,
      }, lease.workspaceId);
    });
  }

  private async insertLease(client: Queryable, lease: WorkspaceLease): Promise<void> {
    await client.query(`INSERT INTO workspace_leases (workspace_id,run_id,mode,expires_at,heartbeat_at)
      VALUES ($1,$2,$3,$4,$5)`, [lease.workspaceId, lease.runId, lease.mode, lease.expiresAt, lease.heartbeatAt]);
  }

  async createWorkspaceLease(workspace: WorkspaceRecord, lease: WorkspaceLease): Promise<WorkspaceLeaseResult> {
    this.validateWorkspaceLease(workspace, lease, workspace.runId);
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('workspace-lease'),hashtext($1))", [workspace.runId]);
      const runRow = (await client.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [workspace.runId])).rows[0];
      const run = runRow ? this.mapRun(runRow) : null;
      if (!run || (run.workspaceId && run.workspaceId !== workspace.id)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      const found = await client.query("SELECT * FROM workspaces WHERE id=$1 OR run_id=$2 FOR UPDATE", [workspace.id, workspace.runId]);
      if (found.rows[0]) {
        const existingWorkspace = this.mapWorkspace(found.rows[0]);
        const existingLease = await this.getLeaseRow(client, existingWorkspace.id);
        if (existingWorkspace.id === workspace.id && existingWorkspace.runId === workspace.runId &&
            existingLease?.runId === lease.runId && existingLease.mode === lease.mode) {
          if (!run.workspaceId) await client.query("UPDATE runs SET workspace_id=$1 WHERE id=$2", [workspace.id, run.id]);
          return { workspace: existingWorkspace, lease: existingLease, replayed: true };
        }
        throw new StorageConflictError("Workspace or run already owns another workspace lease");
      }
      await this.insertWorkspace(client, workspace);
      await this.insertLease(client, lease);
      await client.query("UPDATE runs SET workspace_id=$1 WHERE id=$2", [workspace.id, run.id]);
      await this.insertOutbox(client, "workspace.lease.acquired", workspace.id, {
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
    const result = await this.pool.query(`UPDATE workspace_leases SET heartbeat_at=$1,expires_at=$2
      WHERE workspace_id=$3 AND run_id=$4 AND expires_at>$1`, [heartbeatAt, expiresAt, workspaceId, runId]);
    return result.rowCount === 1;
  }

  async releaseLease(workspaceId: string): Promise<void> {
    await this.transaction(async (client) => {
      const lease = await this.getLeaseRow(client, workspaceId);
      if (!lease) return;
      await client.query("DELETE FROM workspace_leases WHERE workspace_id=$1", [workspaceId]);
      await this.insertOutbox(client, "workspace.lease.released", workspaceId, {
        workspaceId, runId: lease.runId,
      }, `${workspaceId}:${lease.heartbeatAt}`);
    });
  }

  async releaseWorkspaceLease(workspaceId: string, runId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const lease = await this.getLeaseRow(client, workspaceId, true);
      if (!lease) return false;
      if (lease.runId !== runId) throw new StorageConflictError("Only the owning run may release a writer lease");
      const deleted = await client.query("DELETE FROM workspace_leases WHERE workspace_id=$1 AND run_id=$2", [workspaceId, runId]);
      if (deleted.rowCount !== 1) return false;
      await client.query("UPDATE workspaces SET status='released' WHERE id=$1 AND run_id=$2", [workspaceId, runId]);
      await this.insertOutbox(client, "workspace.lease.released", workspaceId, { workspaceId, runId }, `${workspaceId}:${lease.heartbeatAt}`);
      return true;
    });
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    return (await this.pool.query("SELECT * FROM workspace_leases ORDER BY heartbeat_at DESC")).rows.map(this.mapLease);
  }

  private async getLeaseRow(client: Queryable, workspaceId: string, lock = false): Promise<WorkspaceLease | null> {
    const row = (await client.query(`SELECT * FROM workspace_leases WHERE workspace_id=$1${lock ? " FOR UPDATE" : ""}`, [workspaceId])).rows[0];
    return row ? this.mapLease(row) : null;
  }

  async requestApprovalTransaction(input: ApprovalRequestInput): Promise<ApprovalRequestResult> {
    if (input.approval.state !== "pending") throw new StorageConflictError("A requested approval must be pending");
    if (input.event.runId !== input.approval.runId) throw new StorageConflictError("Approval request event must belong to the approval run");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('approval-request'),hashtext($1))", [input.approval.id]);
      if (input.idempotency) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [input.idempotency.scope, input.idempotency.key]);
        const idempotency = await this.getIdempotencyRow(client, input.idempotency.scope, input.idempotency.key);
        if (idempotency) {
          if (idempotency.requestHash !== input.idempotency.requestHash) throw new IdempotencyConflictError();
          if (idempotency.resourceType !== "approval" || idempotency.resourceId !== input.approval.id) {
            throw new IdempotencyConflictError("Idempotency key refers to another approval or resource type");
          }
          const approval = await this.getApprovalRow(client, input.approval.id);
          if (!approval) throw new StorageConflictError("Idempotency record refers to a missing approval");
          this.assertApprovalRequestCompatible(approval, input.approval, true);
          const run = await this.getRunRow(client, approval.runId);
          const eventRow = (await client.query("SELECT * FROM run_events WHERE id=$1", [input.event.id])).rows[0];
          if (!run || !eventRow) throw new StorageConflictError("Approval request replay is missing its run or event");
          const event = this.mapEvent(eventRow);
          this.assertEventCompatible(event, input.event);
          return { approval, run, event, replayed: true };
        }
      }

      const existing = await this.getApprovalRow(client, input.approval.id, true);
      if (existing) {
        this.assertApprovalRequestCompatible(existing, input.approval, false);
        const run = await this.getRunRow(client, existing.runId);
        const eventRow = (await client.query("SELECT * FROM run_events WHERE id=$1", [input.event.id])).rows[0];
        if (!run || run.status !== "awaiting_approval" || !eventRow) {
          throw new StorageConflictError("Existing approval request is not in a replayable pending state");
        }
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        if (input.idempotency) {
          await this.insertIdempotency(client, input.idempotency, "approval", existing.id, {
            approvalId: existing.id, runId: existing.runId,
          });
        }
        return { approval: existing, run, event, replayed: true };
      }

      const runResult = await client.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [input.approval.runId]);
      const run = runResult.rows[0] ? this.mapRun(runResult.rows[0]) : null;
      if (!run) throw new StorageConflictError("Approval run not found");
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw new StorageConflictError("A terminal run cannot request approval");
      }
      await this.insertApproval(client, input.approval);
      const patch: MutableRunPatch = { status: "awaiting_approval", stage: "approval", nextActionAt: null };
      if (!await this.updateRunRow(client, run.id, patch)) throw new StorageConflictError("Approval run could not be transitioned");
      await this.insertOutbox(client, "approval.requested", input.approval.id, {
        approvalId: input.approval.id, runId: input.approval.runId, action: input.approval.action,
      }, input.approval.id);
      await this.insertOutbox(client, "run.updated", run.id, { runId: run.id, patch }, canonicalJson(patch));
      const event = await this.insertEvent(client, input.event);
      if (input.idempotency) {
        await this.insertIdempotency(client, input.idempotency, "approval", input.approval.id, {
          approvalId: input.approval.id, runId: input.approval.runId,
        });
      }
      return { approval: input.approval, run: (await this.getRunRow(client, run.id))!, event, replayed: false };
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

  private async insertApproval(client: Queryable, approval: Approval): Promise<void> {
    await client.query(`INSERT INTO approvals
      (id,run_id,action,exact_effect,state,evidence_json,requested_at,resolved_at,resolved_by,decision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      approval.id, approval.runId, approval.action, approval.exactEffect, approval.state,
      JSON.stringify(approval.evidence), approval.requestedAt, approval.resolvedAt ?? null,
      approval.resolvedBy ?? null, approval.decision ?? null,
    ]);
  }

  async getApproval(id: string): Promise<Approval | null> { return this.getApprovalRow(this.pool, id); }

  private async getApprovalRow(client: Queryable, id: string, lock = false): Promise<Approval | null> {
    const row = (await client.query(`SELECT * FROM approvals WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
    return row ? this.mapApproval(row) : null;
  }

  async listApprovals(state?: string): Promise<Approval[]> {
    const result = state
      ? await this.pool.query("SELECT * FROM approvals WHERE state=$1 ORDER BY requested_at DESC", [state])
      : await this.pool.query("SELECT * FROM approvals ORDER BY requested_at DESC");
    return result.rows.map(this.mapApproval);
  }

  async resolveApproval(id: string, state: string, decision: string, resolvedBy: string): Promise<void> {
    await this.resolveApprovalTransaction({ approvalId: id, state, decision, resolvedBy });
  }

  async resolveApprovalTransaction(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult> {
    return this.transaction(async (client) => {
      if (input.idempotency) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [input.idempotency.scope, input.idempotency.key]);
        const record = await this.getIdempotencyRow(client, input.idempotency.scope, input.idempotency.key);
        if (record) {
          if (record.requestHash !== input.idempotency.requestHash) throw new IdempotencyConflictError();
          if (record.resourceType !== "approval" || record.resourceId !== input.approvalId) {
            throw new IdempotencyConflictError("Idempotency key refers to another approval or resource type");
          }
          const approval = await this.getApprovalRow(client, input.approvalId);
          if (!approval) throw new StorageConflictError("Idempotency record refers to a missing approval");
          if (input.event && input.event.runId !== approval.runId) {
            throw new StorageConflictError("Approval resolution event must belong to the approval run");
          }
          const run = await this.getRunRow(client, approval.runId);
          if (!run) throw new StorageConflictError("Approval refers to a missing run");
          return { approval, run, replayed: true };
        }
      }

      const current = await this.getApprovalRow(client, input.approvalId, true);
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
        const result = await client.query(`UPDATE approvals
          SET state=$1,decision=$2,resolved_by=$3,resolved_at=$4 WHERE id=$5 AND state='pending'`, [
          input.state, input.decision, input.resolvedBy, input.resolvedAt ?? nowIso(), input.approvalId,
        ]);
        if (result.rowCount !== 1) throw new StorageConflictError("Approval resolution lost a concurrent race");
      }

      if (!replayed && input.runPatch) await this.updateRunRow(client, current.runId, input.runPatch);
      const storedEvent = !replayed && input.event ? await this.insertEvent(client, input.event) : undefined;
      if (!replayed) {
        await this.insertOutbox(client, "approval.resolved", input.approvalId, {
          approvalId: input.approvalId, runId: current.runId, state: input.state, decision: input.decision,
        }, input.decision);
      }
      // Bind a fresh transport idempotency key even when the compatible
      // business decision was completed before this retry arrived.
      if (input.idempotency) {
        await this.insertIdempotency(client, input.idempotency, "approval", input.approvalId, {
          approvalId: input.approvalId, runId: current.runId,
        });
      }
      const approval = (await this.getApprovalRow(client, input.approvalId))!;
      const run = (await this.getRunRow(client, current.runId))!;
      return { approval, run, event: storedEvent, replayed };
    });
  }

  async createArtifact(artifact: Artifact): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`INSERT INTO artifacts (id,run_id,kind,uri,checksum,media_type,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        artifact.id, artifact.runId, artifact.kind, artifact.uri, artifact.checksum, artifact.mediaType, artifact.createdAt,
      ]);
      await this.insertOutbox(client, "artifact.created", artifact.id, {
        artifactId: artifact.id, runId: artifact.runId, kind: artifact.kind, checksum: artifact.checksum,
      }, artifact.id);
    });
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return (await this.pool.query("SELECT * FROM artifacts WHERE run_id=$1 ORDER BY created_at", [runId])).rows.map(this.mapArtifact);
  }

  async createMemoryProposal(item: MemoryProposal): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`INSERT INTO memory_proposals
        (id,project_id,run_id,claim,evidence_json,state,created_at,resolved_at,reviewer,target_note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        item.id, item.projectId, item.runId ?? null, item.claim, JSON.stringify(item.evidence), item.state,
        item.createdAt, item.resolvedAt ?? null, item.reviewer ?? null, item.targetNote ?? null,
      ]);
      await this.insertOutbox(client, "memory.proposed", item.id, {
        proposalId: item.id, projectId: item.projectId, runId: item.runId ?? null,
      }, item.id);
    });
  }

  async getMemoryProposal(id: string): Promise<MemoryProposal | null> { return this.getMemoryProposalRow(this.pool, id); }

  private async getMemoryProposalRow(client: Queryable, id: string): Promise<MemoryProposal | null> {
    const row = (await client.query("SELECT * FROM memory_proposals WHERE id=$1", [id])).rows[0];
    return row ? this.mapMemoryProposal(row) : null;
  }

  async listMemoryProposals(state?: string): Promise<MemoryProposal[]> {
    const result = state
      ? await this.pool.query("SELECT * FROM memory_proposals WHERE state=$1 ORDER BY created_at DESC", [state])
      : await this.pool.query("SELECT * FROM memory_proposals ORDER BY created_at DESC");
    return result.rows.map(this.mapMemoryProposal);
  }

  async resolveMemoryProposal(id: string, state: string, reviewer: string, targetNote?: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(`UPDATE memory_proposals
        SET state=$1,reviewer=$2,target_note=$3,resolved_at=$4 WHERE id=$5 AND state='proposed'`, [
        state, reviewer, targetNote ?? null, nowIso(), id,
      ]);
      if (result.rowCount === 0) {
        const current = await this.getMemoryProposalRow(client, id);
        if (!current || current.state !== state) throw new StorageConflictError("Memory proposal is missing or already resolved differently");
        return;
      }
      await this.insertOutbox(client, "memory.resolved", id, {
        proposalId: id, state, reviewer, targetNote: targetNote ?? null,
      }, state);
    });
  }

  async getIdempotencyRecord(scope: string, key: string): Promise<StoredIdempotencyRecord | null> {
    return this.getIdempotencyRow(this.pool, scope, key);
  }

  private async getIdempotencyRow(client: Queryable, scope: string, key: string): Promise<StoredIdempotencyRecord | null> {
    const row = (await client.query("SELECT * FROM idempotency_keys WHERE scope=$1 AND key=$2", [scope, key])).rows[0];
    return row ? this.mapIdempotency(row) : null;
  }

  private async insertIdempotency(
    client: Queryable,
    input: IdempotencyInput,
    resourceType: string,
    resourceId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await client.query(`INSERT INTO idempotency_keys
      (scope,key,request_hash,resource_type,resource_id,response_json,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      input.scope, input.key, input.requestHash, resourceType, resourceId,
      response, nowIso(), input.expiresAt ?? null,
    ]);
  }

  private async insertOutbox(
    client: Queryable,
    topic: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    discriminator: string,
  ): Promise<void> {
    const outboxId = deterministicOutboxId(topic, aggregateId, discriminator);
    const createdAt = nowIso();
    const inserted = await client.query(`INSERT INTO outbox_events
      (id,topic,aggregate_id,payload_json,created_at,available_at,published_at,attempts,last_error)
      VALUES ($1,$2,$3,$4,$5,$5,NULL,0,NULL)
      ON CONFLICT(id) DO NOTHING RETURNING id`, [outboxId, topic, aggregateId, payload, createdAt]);
    if (inserted.rowCount === 1) return;
    const existing = (await client.query("SELECT topic,aggregate_id,payload_json FROM outbox_events WHERE id=$1", [outboxId])).rows[0];
    if (!existing || existing.topic !== topic || existing.aggregate_id !== aggregateId ||
        canonicalJson(decodeJson(existing.payload_json, {})) !== canonicalJson(payload)) {
      throw new StorageConflictError(`Outbox ID ${outboxId} was already used with different content`);
    }
  }

  async listPendingOutbox(limit = 100): Promise<OutboxEvent[]> {
    return (await this.pool.query(`SELECT * FROM outbox_events
      WHERE published_at IS NULL AND available_at<=now() ORDER BY created_at,id LIMIT $1`, [limit])).rows.map(this.mapOutbox);
  }

  async markOutboxPublished(id: string, publishedAt: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE outbox_events SET published_at=$1,last_error=NULL
      WHERE id=$2 AND published_at IS NULL`, [publishedAt, id]);
    return result.rowCount === 1;
  }

  async markOutboxFailed(id: string, error: string, availableAt: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE outbox_events
      SET attempts=attempts+1,last_error=$1,available_at=$2 WHERE id=$3 AND published_at IS NULL`, [error, availableAt, id]);
    return result.rowCount === 1;
  }

  async listReconciliationCandidates(now: string, outboxLimit = 100): Promise<ReconciliationCandidates> {
    const [queued, strandedIds, terminal, expired, pending] = await Promise.all([
      this.pool.query("SELECT * FROM runs WHERE status='queued' ORDER BY created_at"),
      this.pool.query(`SELECT a.id FROM approvals a JOIN runs r ON r.id=a.run_id
        WHERE a.state<>'pending' AND r.status='awaiting_approval' ORDER BY a.resolved_at`),
      this.pool.query(`SELECT l.* FROM workspace_leases l JOIN runs r ON r.id=l.run_id
        WHERE r.status IN ('completed','failed','cancelled') ORDER BY l.heartbeat_at`),
      this.pool.query("SELECT * FROM workspace_leases WHERE expires_at<=$1 ORDER BY expires_at", [now]),
      this.pool.query(`SELECT * FROM outbox_events WHERE published_at IS NULL AND available_at<=$1
        ORDER BY created_at,id LIMIT $2`, [now, outboxLimit]),
    ]);
    const strandedApprovals = await Promise.all(strandedIds.rows.map(async (row) => {
      const approval = (await this.getApproval(String(row.id)))!;
      const run = (await this.getRun(approval.runId))!;
      return { approval, run };
    }));
    return {
      queuedRuns: queued.rows.map(this.mapRun),
      strandedApprovals,
      terminalLeases: terminal.rows.map(this.mapLease),
      expiredLeases: expired.rows.map(this.mapLease),
      pendingOutbox: pending.rows.map(this.mapOutbox),
    };
  }

  private mapProject = (row: any): Project => ({
    id: row.id, name: row.name, objective: row.objective, currentMilestone: row.current_milestone,
    health: row.health, linearTeam: row.linear_team, repository: row.repository, vaultPath: row.vault_path,
    memoryNamespace: row.memory_namespace, createdAt: isoString(row.created_at),
  });

  private mapTask = (row: any): Task => ({
    id: row.id, projectId: row.project_id, source: row.source, sourceId: row.source_id, title: row.title,
    objective: row.objective, status: row.status, priority: row.priority, createdAt: isoString(row.created_at),
  });

  private mapRun = (row: any): Run => ({
    id: row.id, taskId: row.task_id, projectId: row.project_id, rootRuntime: row.root_runtime,
    workflow: row.workflow, status: row.status, stage: row.stage, stageIndex: Number(row.stage_index),
    budgetUsd: Number(row.budget_usd), costUsd: Number(row.cost_usd), workspaceId: row.workspace_id,
    nativeRunId: row.native_run_id, nextActionAt: nullableIsoString(row.next_action_at),
    startedAt: nullableIsoString(row.started_at), completedAt: nullableIsoString(row.completed_at),
    metadata: decodeJson(row.metadata_json, {}), createdAt: isoString(row.created_at),
  });

  private mapEvent = (row: any): RunEvent => ({
    seq: Number(row.seq), id: row.id, runId: row.run_id, type: row.type, message: row.message,
    payload: decodeJson(row.payload_json, {}), createdAt: isoString(row.created_at),
  });

  private mapWorkspace = (row: any): WorkspaceRecord => ({
    id: row.id, runId: row.run_id, path: row.path, provider: row.provider, status: row.status,
    createdAt: isoString(row.created_at),
  });

  private mapLease = (row: any): WorkspaceLease => ({
    workspaceId: row.workspace_id, runId: row.run_id, mode: row.mode,
    expiresAt: isoString(row.expires_at), heartbeatAt: isoString(row.heartbeat_at),
  });

  private mapApproval = (row: any): Approval => ({
    id: row.id, runId: row.run_id, action: row.action, exactEffect: row.exact_effect, state: row.state,
    evidence: decodeJson(row.evidence_json, []), requestedAt: isoString(row.requested_at),
    resolvedAt: nullableIsoString(row.resolved_at), resolvedBy: row.resolved_by, decision: row.decision,
  });

  private mapArtifact = (row: any): Artifact => ({
    id: row.id, runId: row.run_id, kind: row.kind, uri: row.uri, checksum: row.checksum,
    mediaType: row.media_type, createdAt: isoString(row.created_at),
  });

  private mapMemoryProposal = (row: any): MemoryProposal => ({
    id: row.id, projectId: row.project_id, runId: row.run_id, claim: row.claim,
    evidence: decodeJson(row.evidence_json, []), state: row.state, createdAt: isoString(row.created_at),
    resolvedAt: nullableIsoString(row.resolved_at), reviewer: row.reviewer, targetNote: row.target_note,
  });

  private mapOutbox = (row: any): OutboxEvent => ({
    id: row.id, topic: row.topic, aggregateId: row.aggregate_id, payload: decodeJson(row.payload_json, {}),
    createdAt: isoString(row.created_at), availableAt: isoString(row.available_at),
    publishedAt: nullableIsoString(row.published_at), attempts: Number(row.attempts), lastError: row.last_error,
  });

  private mapIdempotency = (row: any): StoredIdempotencyRecord => ({
    scope: row.scope, key: row.key, requestHash: row.request_hash, resourceType: row.resource_type,
    resourceId: row.resource_id, response: decodeJson(row.response_json, {}), createdAt: isoString(row.created_at),
    expiresAt: nullableIsoString(row.expires_at),
  });
}
