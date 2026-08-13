import type { Approval, Artifact, MemoryProposal, Project, Run, RunEvent, Task } from "./types.ts";
import { nowIso } from "./ids.ts";
import { assertUniqueMigrationVersions, loadMigrationFiles } from "./migrations.ts";
import {
  assertRunPatchApplied,
  artifactsEqual,
  canonicalJson,
  decodeJson,
  deterministicOutboxId,
  IdempotencyConflictError,
  isoString,
  nullableIsoString,
  observeStoreClock,
  StorageConflictError,
  validateArtifactBatchInput,
  validateInferenceCapability,
  validateInferenceCompletion,
  validateInferenceReservation,
  validateComparisonCandidate,
  validateComparisonRecord,
  validateEngineeringRoutingAssessment,
  validateApprovalRequestBinding,
  validateApprovalResolutionBinding,
  validateApprovalExpiry,
  validateApprovalExpiryRunPatch,
  validateQueuedRunClaim,
  validateSandboxInstanceCreate,
  validateSandboxInstanceTransition,
  validateWorkspaceLeaseFence,
  validateWorkspaceLeaseQuarantine,
  validateWorkspaceLeaseRenewal,
  validateWriterLeaseRequest,
  validateWriterLeaseWindow,
  type ApprovalResolutionInput,
  type ApprovalResolutionResult,
  type ApprovalExpiryInput,
  type ApprovalRequestInput,
  type ApprovalRequestResult,
  type ArtifactBatchResult,
  type ControlPlaneStore,
  type IdempotencyInput,
  type InferenceCapability,
  type InferenceRequest,
  type ReserveInferenceRequestInput,
  type CompleteInferenceRequestInput,
  type CreateEngineeringRoutingAssessmentInput,
  type CreateEngineeringRoutingAssessmentResult,
  type EngineeringRoutingAssessmentRecord,
  type ComparisonCandidate,
  type ComparisonMetrics,
  type ComparisonRecord,
  type MigrationResult,
  type MutableRunPatch,
  type OutboxEvent,
  type ReconciliationCandidates,
  type RunBundleInput,
  type RunBundleResult,
  type SandboxInstance,
  type SandboxInstanceCreateInput,
  type SandboxInstanceState,
  type SandboxInstanceTransitionInput,
  type StoreHealth,
  type StoreClock,
  type StoredIdempotencyRecord,
  type WriterLeaseRequest,
  type WorkspaceLease,
  type WorkspaceLeaseFence,
  type WorkspaceLeaseQuarantine,
  type WorkspaceLeaseRenewal,
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
  now?: StoreClock;
}

export class PostgresStore implements ControlPlaneStore {
  readonly backend = "postgres" as const;
  private initialMigrationResults: MigrationResult[] = [];
  private readonly pool: PoolLike;
  private readonly clock: StoreClock;
  private readonly useDatabaseClock: boolean;

  private constructor(pool: PoolLike, clock: StoreClock, useDatabaseClock: boolean) {
    this.pool = pool;
    this.clock = clock;
    this.useDatabaseClock = useDatabaseClock;
  }

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
    const store = new PostgresStore(pool, options.now ?? (() => new Date()), options.now === undefined);
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

  private async observeApprovalClock(client: Queryable): Promise<string> {
    if (!this.useDatabaseClock) return observeStoreClock(this.clock);
    const value = (await client.query("SELECT clock_timestamp() AS observed_at")).rows[0]?.observed_at;
    const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
    if (!Number.isFinite(parsed.getTime())) throw new StorageConflictError("PostgreSQL approval clock is invalid");
    return parsed.toISOString();
  }

  async resetOperationalData(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`TRUNCATE TABLE
        idempotency_keys,outbox_events,inference_requests,inference_capabilities,engineering_routing_assessments,comparison_candidates,comparisons,sandbox_instances,workspace_leases,artifacts,approvals,run_events,
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
      if (input.admission) {
        if (input.admission.workflow !== effectiveRun.workflow || input.admission.maxNonterminal !== 1) {
          throw new StorageConflictError("Run admission must bind the exact workflow with maxNonterminal=1");
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext('run.workflow.admission'),hashtext($1))", [
          input.admission.workflow,
        ]);
        const active = await client.query(`SELECT COUNT(*)::integer AS count FROM runs
          WHERE workflow=$1 AND status IN ('queued','running','paused','awaiting_approval')`, [
          input.admission.workflow,
        ]);
        if (Number(active.rows[0]?.count ?? 0) >= input.admission.maxNonterminal) {
          throw new StorageConflictError(`Run admission limit reached for workflow ${input.admission.workflow}`);
        }
      }
      await this.insertRun(client, effectiveRun);
      let persistedLease: WorkspaceLease | undefined;
      if (input.workspace && input.lease) {
        await this.insertWorkspace(client, input.workspace);
        persistedLease = await this.insertLease(client, input.lease, observeStoreClock(this.clock));
        await this.insertOutbox(client, "workspace.lease.acquired", input.workspace.id, {
          workspaceId: input.workspace.id, runId: effectiveRun.id, ownerId: persistedLease.ownerId,
          mode: persistedLease.mode, fencingToken: persistedLease.fencingToken,
        }, `${persistedLease.workspaceId}:${persistedLease.fencingToken}`);
      }
      await this.insertOutbox(client, "run.created", effectiveRun.id, {
        runId: effectiveRun.id, projectId: effectiveRun.projectId, rootRuntime: effectiveRun.rootRuntime,
      }, effectiveRun.id);
      if (input.idempotency) {
        await this.insertIdempotency(client, input.idempotency, "run", effectiveRun.id, {
          runId: effectiveRun.id, workspaceId: input.workspace?.id ?? null,
        });
      }
      return { run: effectiveRun, workspace: input.workspace, lease: persistedLease, replayed: false };
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

  async claimQueuedRunForStart(runId: string, workerId: string, claimUntil: string): Promise<Run | null> {
    const observedAt = observeStoreClock(this.clock);
    validateQueuedRunClaim(workerId, claimUntil, observedAt);
    const result = await this.pool.query(`UPDATE runs
      SET worker_claimed_by=$1,worker_claim_expires_at=$2
      WHERE id=$3 AND status='queued'
        AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=$4)
      RETURNING *`, [workerId, claimUntil, runId, observedAt]);
    return result.rows[0] ? this.mapRun(result.rows[0]) : null;
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

  async createLease(lease: WriterLeaseRequest): Promise<WorkspaceLease> {
    validateWriterLeaseRequest(lease);
    return this.transaction(async (client) => {
      const observedAt = observeStoreClock(this.clock);
      validateWriterLeaseWindow(lease, observedAt);
      const workspace = await this.getWorkspaceRow(client, lease.workspaceId);
      if (!workspace || workspace.runId !== lease.runId) throw new StorageConflictError("Lease owner does not match workspace owner");
      const runRow = (await client.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [lease.runId])).rows[0];
      const run = runRow ? this.mapRun(runRow) : null;
      if (!run || (run.workspaceId && run.workspaceId !== lease.workspaceId)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      const persisted = await this.insertLease(client, lease, observedAt);
      await client.query("UPDATE runs SET workspace_id=$1 WHERE id=$2 AND workspace_id IS NULL", [lease.workspaceId, lease.runId]);
      await this.insertOutbox(client, "workspace.lease.acquired", lease.workspaceId, {
        workspaceId: lease.workspaceId, runId: lease.runId, ownerId: lease.ownerId,
        mode: lease.mode, fencingToken: persisted.fencingToken,
      }, `${lease.workspaceId}:${persisted.fencingToken}`);
      return persisted;
    });
  }

  private async nextFencingToken(client: Queryable, workspaceId: string, runId: string): Promise<number> {
    const result = await client.query(`UPDATE workspaces SET lease_epoch=lease_epoch+1
      WHERE id=$1 AND run_id=$2 AND lease_epoch<9007199254740991
      RETURNING lease_epoch`, [workspaceId, runId]);
    if (result.rowCount !== 1) throw new StorageConflictError("Workspace lease epoch is unavailable or exhausted");
    const token = Number(result.rows[0].lease_epoch);
    if (!Number.isSafeInteger(token) || token < 1) throw new StorageConflictError("Workspace lease epoch is invalid");
    return token;
  }

  private async insertLease(client: Queryable, lease: WriterLeaseRequest, observedAt: string): Promise<WorkspaceLease> {
    validateWriterLeaseRequest(lease);
    validateWriterLeaseWindow(lease, observedAt);
    const fencingToken = await this.nextFencingToken(client, lease.workspaceId, lease.runId);
    const result = await client.query(`INSERT INTO workspace_leases
      (workspace_id,run_id,owner_id,mode,fencing_token,state,expires_at,heartbeat_at,acquired_at,quarantined_at,quarantine_reason)
      VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$7,NULL,NULL) RETURNING *`, [
      lease.workspaceId, lease.runId, lease.ownerId, lease.mode, fencingToken, lease.expiresAt, lease.heartbeatAt,
    ]);
    return this.mapLease(result.rows[0]);
  }

  async createWorkspaceLease(workspace: WorkspaceRecord, lease: WriterLeaseRequest): Promise<WorkspaceLeaseResult> {
    this.validateWorkspaceLease(workspace, lease, workspace.runId);
    return this.transaction(async (client) => {
      const observedAt = observeStoreClock(this.clock);
      validateWriterLeaseWindow(lease, observedAt);
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
            existingLease?.runId === lease.runId && existingLease.ownerId === lease.ownerId &&
            existingLease.mode === lease.mode && existingLease.state === "active" &&
            existingLease.heartbeatAt === lease.heartbeatAt && existingLease.expiresAt === lease.expiresAt) {
          if (!run.workspaceId) await client.query("UPDATE runs SET workspace_id=$1 WHERE id=$2", [workspace.id, run.id]);
          return { workspace: existingWorkspace, lease: existingLease, replayed: true };
        }
        throw new StorageConflictError("Workspace or run already owns another workspace lease");
      }
      if (run.status !== "queued") {
        throw new StorageConflictError("A new writer workspace can be claimed only by a queued run");
      }
      await this.insertWorkspace(client, workspace);
      const persisted = await this.insertLease(client, lease, observedAt);
      await client.query("UPDATE runs SET workspace_id=$1 WHERE id=$2", [workspace.id, run.id]);
      await this.insertOutbox(client, "workspace.lease.acquired", workspace.id, {
        workspaceId: workspace.id, runId: workspace.runId, ownerId: lease.ownerId,
        mode: lease.mode, fencingToken: persisted.fencingToken,
      }, `${workspace.id}:${persisted.fencingToken}`);
      return { workspace, lease: persisted, replayed: false };
    });
  }

  private validateWorkspaceLease(workspace: WorkspaceRecord, lease: WriterLeaseRequest, runId: string): void {
    validateWriterLeaseRequest(lease);
    if (workspace.runId !== runId || lease.runId !== runId || lease.workspaceId !== workspace.id) {
      throw new StorageConflictError("Workspace, lease, and run ownership must match");
    }
  }

  async rotateWorkspaceLease(lease: WriterLeaseRequest): Promise<WorkspaceLease> {
    validateWriterLeaseRequest(lease);
    return this.transaction(async (client) => {
      const observedAt = observeStoreClock(this.clock);
      validateWriterLeaseWindow(lease, observedAt);
      const runRow = (await client.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [lease.runId])).rows[0];
      const run = runRow ? this.mapRun(runRow) : null;
      if (!run || run.workspaceId !== lease.workspaceId) {
        throw new StorageConflictError("Run does not own the workspace being rotated");
      }
      const workspaceRow = (await client.query("SELECT * FROM workspaces WHERE id=$1 FOR UPDATE", [lease.workspaceId])).rows[0];
      const workspace = workspaceRow ? this.mapWorkspace(workspaceRow) : null;
      if (!workspace || workspace.runId !== lease.runId) {
        throw new StorageConflictError("Lease owner does not match workspace owner");
      }
      const previous = await this.getLeaseRow(client, lease.workspaceId, true);
      if (previous?.state === "quarantined") {
        throw new StorageConflictError("A quarantined writer lease requires explicit fenced release before reacquisition");
      }
      if (previous && Date.parse(previous.expiresAt) > Date.parse(observedAt)) {
        throw new StorageConflictError("An unexpired writer lease cannot be rotated");
      }

      const fencingToken = await this.nextFencingToken(client, lease.workspaceId, lease.runId);
      let result: QueryResult;
      if (previous) {
        result = await client.query(`UPDATE workspace_leases
          SET owner_id=$1,mode=$2,fencing_token=$3,state='active',expires_at=$4,heartbeat_at=$5,acquired_at=$5,
              quarantined_at=NULL,quarantine_reason=NULL
          WHERE workspace_id=$6 AND run_id=$7 AND fencing_token=$8 RETURNING *`, [
          lease.ownerId, lease.mode, fencingToken, lease.expiresAt, lease.heartbeatAt,
          lease.workspaceId, lease.runId, previous.fencingToken,
        ]);
      } else {
        result = await client.query(`INSERT INTO workspace_leases
          (workspace_id,run_id,owner_id,mode,fencing_token,state,expires_at,heartbeat_at,acquired_at,quarantined_at,quarantine_reason)
          VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$7,NULL,NULL) RETURNING *`, [
          lease.workspaceId, lease.runId, lease.ownerId, lease.mode, fencingToken,
          lease.expiresAt, lease.heartbeatAt,
        ]);
      }
      if (result.rowCount !== 1) throw new StorageConflictError("Writer lease rotation lost its ownership race");
      await client.query("UPDATE workspaces SET status='leased' WHERE id=$1 AND run_id=$2", [lease.workspaceId, lease.runId]);
      await this.insertOutbox(client, previous ? "workspace.lease.rotated" : "workspace.lease.acquired", lease.workspaceId, {
        workspaceId: lease.workspaceId, runId: lease.runId, ownerId: lease.ownerId,
        fencingToken, previousOwnerId: previous?.ownerId ?? null,
        previousFencingToken: previous?.fencingToken ?? null, previousExpiresAt: previous?.expiresAt ?? null,
      }, `${lease.workspaceId}:${fencingToken}`);
      return this.mapLease(result.rows[0]);
    });
  }

  async renewWorkspaceLease(input: WorkspaceLeaseRenewal): Promise<WorkspaceLease | null> {
    validateWorkspaceLeaseRenewal(input);
    const observedAt = observeStoreClock(this.clock);
    validateWriterLeaseWindow(input, observedAt);
    const result = await this.pool.query(`UPDATE workspace_leases SET heartbeat_at=$1,expires_at=$2
      WHERE workspace_id=$3 AND run_id=$4 AND owner_id=$5 AND fencing_token=$6 AND state='active'
        AND expires_at>$7 AND heartbeat_at<=$1 AND expires_at<=$2 RETURNING *`, [
      input.heartbeatAt, input.expiresAt, input.workspaceId, input.runId, input.ownerId, input.fencingToken, observedAt,
    ]);
    return result.rowCount === 1 ? this.mapLease(result.rows[0]) : null;
  }

  async quarantineWorkspaceLease(input: WorkspaceLeaseQuarantine): Promise<WorkspaceLease | null> {
    validateWorkspaceLeaseQuarantine(input);
    return this.transaction(async (client) => {
      const workspace = await client.query("SELECT id FROM workspaces WHERE id=$1 AND run_id=$2 FOR UPDATE", [
        input.workspaceId, input.runId,
      ]);
      if (workspace.rowCount !== 1) return null;
      const lease = await this.getLeaseRow(client, input.workspaceId, true);
      if (!lease || lease.runId !== input.runId || lease.ownerId !== input.ownerId ||
          lease.fencingToken !== input.fencingToken) return null;
      if (Date.parse(input.quarantinedAt) < Date.parse(lease.acquiredAt)) {
        throw new StorageConflictError("Writer lease quarantine time cannot precede acquisition");
      }
      if (lease.state === "quarantined") {
        if (lease.quarantinedAt === input.quarantinedAt && lease.quarantineReason === input.reason) return lease;
        throw new StorageConflictError("Writer lease was already quarantined with different evidence");
      }
      const updated = await client.query(`UPDATE workspace_leases
        SET state='quarantined',quarantined_at=$1,quarantine_reason=$2
        WHERE workspace_id=$3 AND run_id=$4 AND owner_id=$5 AND fencing_token=$6 AND state='active' RETURNING *`, [
        input.quarantinedAt, input.reason, input.workspaceId, input.runId, input.ownerId, input.fencingToken,
      ]);
      if (updated.rowCount !== 1) return null;
      await client.query("UPDATE workspaces SET status='quarantined' WHERE id=$1 AND run_id=$2", [input.workspaceId, input.runId]);
      await this.insertOutbox(client, "workspace.lease.quarantined", input.workspaceId, {
        workspaceId: input.workspaceId, runId: input.runId, ownerId: input.ownerId,
        fencingToken: input.fencingToken, quarantinedAt: input.quarantinedAt, reason: input.reason,
      }, `${input.workspaceId}:${input.fencingToken}:quarantined`);
      return this.mapLease(updated.rows[0]);
    });
  }

  async releaseWorkspaceLease(fence: WorkspaceLeaseFence): Promise<boolean> {
    validateWorkspaceLeaseFence(fence);
    return this.transaction(async (client) => {
      const workspace = await client.query("SELECT id FROM workspaces WHERE id=$1 AND run_id=$2 FOR UPDATE", [
        fence.workspaceId, fence.runId,
      ]);
      if (workspace.rowCount !== 1) return false;
      const lease = await this.getLeaseRow(client, fence.workspaceId, true);
      if (!lease) return false;
      if (lease.runId !== fence.runId || lease.ownerId !== fence.ownerId || lease.fencingToken !== fence.fencingToken) {
        return false;
      }
      const deleted = await client.query(`DELETE FROM workspace_leases
        WHERE workspace_id=$1 AND run_id=$2 AND owner_id=$3 AND fencing_token=$4`, [
        fence.workspaceId, fence.runId, fence.ownerId, fence.fencingToken,
      ]);
      if (deleted.rowCount !== 1) return false;
      await client.query("UPDATE workspaces SET status='released' WHERE id=$1 AND run_id=$2", [fence.workspaceId, fence.runId]);
      await this.insertOutbox(client, "workspace.lease.released", fence.workspaceId, {
        workspaceId: fence.workspaceId, runId: fence.runId, ownerId: fence.ownerId,
        fencingToken: fence.fencingToken, priorState: lease.state,
        quarantinedAt: lease.quarantinedAt, quarantineReason: lease.quarantineReason,
      }, `${fence.workspaceId}:${fence.fencingToken}:released`);
      return true;
    });
  }

  async getWorkspaceLease(workspaceId: string): Promise<WorkspaceLease | null> {
    return this.getLeaseRow(this.pool, workspaceId);
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    return (await this.pool.query("SELECT * FROM workspace_leases WHERE state='active' ORDER BY heartbeat_at DESC")).rows
      .map(this.mapLease);
  }

  async createSandboxInstance(input: SandboxInstanceCreateInput): Promise<SandboxInstance> {
    validateSandboxInstanceCreate(input);
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sandbox-instance'),hashtext($1))", [input.runId]);
      const existing = await this.getSandboxInstanceRow(client, input.runId, true);
      if (existing) {
        if (existing.state === "provisioning" && existing.engineId === null && existing.cleanupAttempts === 0
            && existing.workspaceId === input.workspaceId && existing.leaseOwnerId === input.leaseOwnerId
            && existing.fencingToken === input.fencingToken && existing.provider === input.provider
            && existing.imageRef === input.imageRef && existing.policyHash === input.policyHash
            && existing.workspaceDigest === input.workspaceDigest && existing.contextDigest === input.contextDigest
            && existing.contextContentHash === input.contextContentHash && existing.workdirDigest === input.workdirDigest
            && existing.createdAt === input.createdAt
            && existing.updatedAt === input.updatedAt) return existing;
        throw new StorageConflictError("Sandbox instance already exists with different lifecycle evidence");
      }
      const run = (await client.query("SELECT workspace_id FROM runs WHERE id=$1 FOR UPDATE", [input.runId])).rows[0];
      const workspace = (await client.query("SELECT run_id FROM workspaces WHERE id=$1 FOR UPDATE", [input.workspaceId])).rows[0];
      const lease = await this.getLeaseRow(client, input.workspaceId, true);
      if (!run || run.workspace_id !== input.workspaceId || !workspace || workspace.run_id !== input.runId
          || !lease || lease.state !== "active" || lease.runId !== input.runId
          || lease.ownerId !== input.leaseOwnerId || lease.fencingToken !== input.fencingToken) {
        throw new StorageConflictError("Sandbox instance does not own the current exact writer lease");
      }
      const result = await client.query(`INSERT INTO sandbox_instances
        (run_id,workspace_id,lease_owner_id,fencing_token,provider,engine_id,image_ref,policy_hash,
         workspace_digest,context_digest,context_content_hash,workdir_digest,state,cleanup_attempts,last_cleanup_at,
         quarantine_reason,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,'provisioning',0,NULL,NULL,$12,$13) RETURNING *`, [
        input.runId, input.workspaceId, input.leaseOwnerId, input.fencingToken, input.provider,
        input.imageRef, input.policyHash, input.workspaceDigest, input.contextDigest, input.contextContentHash, input.workdirDigest,
        input.createdAt, input.updatedAt,
      ]);
      await this.insertOutbox(client, "sandbox.instance.provisioning", input.runId, {
        runId: input.runId, workspaceId: input.workspaceId, ownerId: input.leaseOwnerId,
        fencingToken: input.fencingToken, provider: input.provider, policyHash: input.policyHash,
      }, `${input.runId}:provisioning`);
      return this.mapSandboxInstance(result.rows[0]);
    });
  }

  async getSandboxInstance(runId: string): Promise<SandboxInstance | null> {
    return this.getSandboxInstanceRow(this.pool, runId);
  }

  async listSandboxInstances(states?: SandboxInstanceState[]): Promise<SandboxInstance[]> {
    if (states && states.length === 0) return [];
    const allowed: SandboxInstanceState[] = ["provisioning", "ready", "running", "freezing", "exporting", "cleaned", "quarantined"];
    if (states?.some((state) => !allowed.includes(state))) throw new StorageConflictError("Unknown sandbox instance state");
    const result = states
      ? await this.pool.query("SELECT * FROM sandbox_instances WHERE state = ANY($1::text[]) ORDER BY created_at,run_id", [states])
      : await this.pool.query("SELECT * FROM sandbox_instances ORDER BY created_at,run_id");
    return result.rows.map(this.mapSandboxInstance);
  }

  async transitionSandboxInstance(input: SandboxInstanceTransitionInput): Promise<SandboxInstance | null> {
    validateSandboxInstanceTransition(input);
    return this.transaction(async (client) => {
      const current = await this.getSandboxInstanceRow(client, input.runId, true);
      if (!current || current.workspaceId !== input.workspaceId || current.leaseOwnerId !== input.ownerId
          || current.fencingToken !== input.fencingToken || current.state !== input.expectedState) return null;
      if (Date.parse(input.updatedAt) < Date.parse(current.updatedAt)) {
        throw new StorageConflictError("Sandbox transition time cannot move backwards");
      }
      if (current.engineId && input.engineId && current.engineId !== input.engineId) {
        throw new StorageConflictError("Sandbox engine ID is immutable once observed");
      }
      const engineId = input.engineId ?? current.engineId;
      if (!["provisioning", "quarantined"].includes(input.state) && !engineId) {
        throw new StorageConflictError("Sandbox lifecycle requires an immutable engine ID after provisioning");
      }
      const cleanupAttempts = current.cleanupAttempts + (input.cleanupAttemptedAt ? 1 : 0);
      if (cleanupAttempts > 1_000) throw new StorageConflictError("Sandbox cleanup retry bound was exhausted");
      const updated = await client.query(`UPDATE sandbox_instances
        SET state=$1,engine_id=$2,cleanup_attempts=$3,last_cleanup_at=COALESCE($4,last_cleanup_at),
            quarantine_reason=$5,updated_at=$6
        WHERE run_id=$7 AND workspace_id=$8 AND lease_owner_id=$9 AND fencing_token=$10 AND state=$11 RETURNING *`, [
        input.state, engineId, cleanupAttempts, input.cleanupAttemptedAt ?? null,
        input.state === "quarantined" ? input.quarantineReason : null, input.updatedAt,
        input.runId, input.workspaceId, input.ownerId, input.fencingToken, input.expectedState,
      ]);
      if (updated.rowCount !== 1) return null;
      await this.insertOutbox(client, `sandbox.instance.${input.state}`, input.runId, {
        runId: input.runId, workspaceId: input.workspaceId, ownerId: input.ownerId,
        fencingToken: input.fencingToken, state: input.state, engineId,
        cleanupAttempts, quarantineReason: input.quarantineReason ?? null,
      }, `${input.runId}:${input.state}`);
      return this.mapSandboxInstance(updated.rows[0]);
    });
  }

  private async getSandboxInstanceRow(client: Queryable, runId: string, lock = false): Promise<SandboxInstance | null> {
    const row = (await client.query(`SELECT * FROM sandbox_instances WHERE run_id=$1${lock ? " FOR UPDATE" : ""}`, [runId])).rows[0];
    return row ? this.mapSandboxInstance(row) : null;
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
          const observedAt = await this.observeApprovalClock(client);
          validateApprovalRequestBinding(input.approval, run, observedAt);
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
        const observedAt = await this.observeApprovalClock(client);
        validateApprovalRequestBinding(input.approval, run, observedAt);
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
      const observedAt = await this.observeApprovalClock(client);
      validateApprovalRequestBinding(input.approval, run, observedAt);
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
        stored.requestedAt !== requested.requestedAt || canonicalJson(stored.evidence) !== canonicalJson(requested.evidence) ||
        (stored.projectId ?? null) !== (requested.projectId ?? null) ||
        (stored.workflow ?? null) !== (requested.workflow ?? null) ||
        (stored.evidenceDigest ?? null) !== (requested.evidenceDigest ?? null) ||
        (stored.policyHash ?? null) !== (requested.policyHash ?? null) ||
        (stored.expiresAt ?? null) !== (requested.expiresAt ?? null)) {
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
      (id,run_id,action,exact_effect,state,evidence_json,requested_at,resolved_at,resolved_by,decision,
       project_id,workflow,evidence_digest,policy_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [
      approval.id, approval.runId, approval.action, approval.exactEffect, approval.state,
      JSON.stringify(approval.evidence), approval.requestedAt, approval.resolvedAt ?? null,
      approval.resolvedBy ?? null, approval.decision ?? null, approval.projectId ?? null,
      approval.workflow ?? null, approval.evidenceDigest ?? null, approval.policyHash ?? null,
      approval.expiresAt ?? null,
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

  async listExpiredApprovals(projectId: string, workflow: string, observedAt: string, limit = 100): Promise<Approval[]> {
    const at = isoString(observedAt);
    if (!projectId.trim() || !workflow.trim()) throw new StorageConflictError("Expired approval query requires project and workflow");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Expired approval query limit must be between 1 and 1000");
    }
    const result = await this.pool.query(`SELECT * FROM approvals
      WHERE project_id=$1 AND workflow=$2 AND state='pending' AND expires_at<=$3
      ORDER BY expires_at,id LIMIT $4`, [projectId, workflow, at, limit]);
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
          const observedAt = await this.observeApprovalClock(client);
          validateApprovalResolutionBinding(approval, input.expectedBinding, observedAt);
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
      const observedAt = await this.observeApprovalClock(client);
      validateApprovalResolutionBinding(current, input.expectedBinding, observedAt);
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
        const result = this.useDatabaseClock
          ? await client.query(`UPDATE approvals
            SET state=$1,decision=$2,resolved_by=$3,resolved_at=$4
            WHERE id=$5 AND state='pending' AND (expires_at IS NULL OR expires_at>clock_timestamp())`, [
            input.state, input.decision, input.resolvedBy, input.resolvedAt ?? observedAt, input.approvalId,
          ])
          : await client.query(`UPDATE approvals
            SET state=$1,decision=$2,resolved_by=$3,resolved_at=$4
            WHERE id=$5 AND state='pending' AND (expires_at IS NULL OR expires_at>$6)`, [
            input.state, input.decision, input.resolvedBy, input.resolvedAt ?? observedAt, input.approvalId, observedAt,
          ]);
        if (result.rowCount !== 1) throw new StorageConflictError("Approval has expired or resolution lost a concurrent race");
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

  async expireApprovalTransaction(input: ApprovalExpiryInput): Promise<ApprovalResolutionResult> {
    validateApprovalExpiryRunPatch(input.runPatch);
    return this.transaction(async (client) => {
      const replayResult = async (approval: Approval, run: Run): Promise<ApprovalResolutionResult> => {
        if (approval.state !== "denied" || approval.decision !== "expired" || approval.resolvedBy !== "control-plane") {
          throw new StorageConflictError("Approval was resolved by a different decision");
        }
        if (input.event.runId !== approval.runId) {
          throw new StorageConflictError("Approval expiry event must belong to the approval run");
        }
        assertRunPatchApplied(run, input.runPatch);
        const eventRow = (await client.query("SELECT * FROM run_events WHERE id=$1", [input.event.id])).rows[0];
        if (!eventRow) throw new StorageConflictError("Expired approval replay is missing its event");
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        return { approval, run, event, replayed: true };
      };

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
          const observedAt = await this.observeApprovalClock(client);
          validateApprovalExpiry(approval, observedAt);
          const run = await this.getRunRow(client, approval.runId);
          if (!run) throw new StorageConflictError("Approval refers to a missing run");
          return replayResult(approval, run);
        }
      }

      const current = await this.getApprovalRow(client, input.approvalId, true);
      if (!current) throw new StorageConflictError("Approval not found");
      const observedAt = await this.observeApprovalClock(client);
      validateApprovalExpiry(current, observedAt);
      if (input.event.runId !== current.runId) {
        throw new StorageConflictError("Approval expiry event must belong to the approval run");
      }

      if (current.state !== "pending") {
        const run = await this.getRunRow(client, current.runId);
        if (!run) throw new StorageConflictError("Approval refers to a missing run");
        const result = await replayResult(current, run);
        if (input.idempotency) {
          await this.insertIdempotency(client, input.idempotency, "approval", input.approvalId, {
            approvalId: input.approvalId, runId: current.runId,
          });
        }
        return result;
      }

      const updated = this.useDatabaseClock
        ? await client.query(`UPDATE approvals
          SET state='denied',decision='expired',resolved_by='control-plane',resolved_at=$1
          WHERE id=$2 AND state='pending' AND expires_at<=clock_timestamp()`, [observedAt, input.approvalId])
        : await client.query(`UPDATE approvals
          SET state='denied',decision='expired',resolved_by='control-plane',resolved_at=$1
          WHERE id=$2 AND state='pending' AND expires_at<=$3`, [observedAt, input.approvalId, observedAt]);
      if (updated.rowCount !== 1) throw new StorageConflictError("Approval expiry lost a concurrent race");
      if (!await this.updateRunRow(client, current.runId, input.runPatch)) {
        throw new StorageConflictError("Approval expiry could not apply its terminal run patch");
      }
      const event = await this.insertEvent(client, input.event);
      await this.insertOutbox(client, "approval.resolved", input.approvalId, {
        approvalId: input.approvalId, runId: current.runId, state: "denied", decision: "expired",
      }, "expired");
      if (input.idempotency) {
        await this.insertIdempotency(client, input.idempotency, "approval", input.approvalId, {
          approvalId: input.approvalId, runId: current.runId,
        });
      }
      return {
        approval: (await this.getApprovalRow(client, input.approvalId))!,
        run: (await this.getRunRow(client, current.runId))!,
        event,
        replayed: false,
      };
    });
  }

  async createInferenceCapability(capability: InferenceCapability): Promise<InferenceCapability> {
    return this.transaction(async (client) => {
      const observedAt = await this.observeApprovalClock(client);
      validateInferenceCapability(capability, observedAt);
      const existing = (await client.query("SELECT * FROM inference_capabilities WHERE id=$1 OR token_hash=$2 FOR UPDATE", [capability.id, capability.tokenHash])).rows[0];
      if (existing) {
        const mapped = this.mapInferenceCapability(existing);
        if (canonicalJson(mapped) !== canonicalJson(capability)) {
          throw new StorageConflictError("Inference capability identity was already used with different content");
        }
        return mapped;
      }
      await client.query(`INSERT INTO inference_capabilities
        (id,run_id,project_id,workflow,token_hash,provider,model,api,roles_json,max_requests,max_input_tokens,
         max_output_tokens,max_cost_micros,max_elapsed_ms,issued_at,expires_at,state,policy_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [
        capability.id, capability.runId, capability.projectId, capability.workflow, capability.tokenHash,
        capability.provider, capability.model, capability.api, JSON.stringify(capability.roles), capability.maxRequests,
        capability.maxInputTokens, capability.maxOutputTokens, capability.maxCostMicros, capability.maxElapsedMs,
        capability.issuedAt, capability.expiresAt, capability.state, capability.policyHash,
      ]);
      await this.insertOutbox(client, "inference.capability.created", capability.id, {
        capabilityId: capability.id, runId: capability.runId, provider: capability.provider,
        model: capability.model, policyHash: capability.policyHash,
      }, capability.policyHash);
      return capability;
    });
  }

  async getInferenceCapability(id: string): Promise<InferenceCapability | null> {
    const row = (await this.pool.query("SELECT * FROM inference_capabilities WHERE id=$1", [id])).rows[0];
    return row ? this.mapInferenceCapability(row) : null;
  }

  async getInferenceCapabilityByTokenHash(tokenHash: string): Promise<InferenceCapability | null> {
    const row = (await this.pool.query("SELECT * FROM inference_capabilities WHERE token_hash=$1", [tokenHash])).rows[0];
    return row ? this.mapInferenceCapability(row) : null;
  }

  async reserveInferenceRequest(input: ReserveInferenceRequestInput): Promise<{ capability: InferenceCapability; request: InferenceRequest; replayed: boolean }> {
    validateInferenceReservation(input);
    return this.transaction(async (client) => {
      const row = (await client.query("SELECT * FROM inference_capabilities WHERE token_hash=$1 FOR UPDATE", [input.tokenHash])).rows[0];
      if (!row) throw new StorageConflictError("Inference capability is not recognized");
      const capability = this.mapInferenceCapability(row);
      const observedAt = input.reservedAt ?? await this.observeApprovalClock(client);
      const existing = (await client.query(`SELECT * FROM inference_requests
        WHERE id=$1 OR (capability_id=$2 AND role=$3 AND request_hash=$4) FOR UPDATE`,
      [input.id, capability.id, input.role, input.requestHash])).rows[0];
      if (existing) {
        const request = this.mapInferenceRequest(existing);
        if (request.id !== input.id || request.capabilityId !== capability.id || request.runId !== input.runId
            || request.role !== input.role || request.requestHash !== input.requestHash) {
          throw new StorageConflictError("Inference request identity was already used with different content");
        }
        return { capability, request, replayed: true };
      }
      if (capability.state !== "active" || capability.expiresAt <= observedAt) {
        throw new StorageConflictError("Inference capability is not active");
      }
      if (capability.runId !== input.runId || !capability.roles.includes(input.role)) {
        throw new StorageConflictError("Inference request is outside its run or role scope");
      }
      const activeRoleRequest = (await client.query(`SELECT id FROM inference_requests
        WHERE capability_id=$1 AND role=$2 AND state='reserved' LIMIT 1`, [capability.id, input.role])).rows[0];
      if (activeRoleRequest) {
        throw new StorageConflictError("Inference role already has an active request");
      }
      const count = Number((await client.query("SELECT count(*) AS count FROM inference_requests WHERE capability_id=$1", [capability.id])).rows[0].count);
      if (count >= capability.maxRequests) throw new StorageConflictError("Inference request count budget is exhausted");
      const request: InferenceRequest = {
        id: input.id, capabilityId: capability.id, runId: input.runId, role: input.role,
        requestHash: input.requestHash, state: "reserved", providerRequestId: null, responseHash: null,
        inputTokens: 0, outputTokens: 0, costMicros: 0, reservedAt: observedAt, completedAt: null, failureCode: null,
        providerSessionId: null, providerSessionReused: false,
      };
      await client.query(`INSERT INTO inference_requests
        (id,capability_id,run_id,role,request_hash,state,provider_request_id,response_hash,input_tokens,output_tokens,
         cost_micros,reserved_at,completed_at,failure_code,provider_session_id,provider_session_reused)
         VALUES ($1,$2,$3,$4,$5,'reserved',NULL,NULL,0,0,0,$6,NULL,NULL,NULL,false)`,
      [request.id, request.capabilityId, request.runId, request.role, request.requestHash, request.reservedAt]);
      await this.insertOutbox(client, "inference.request.reserved", request.id, {
        requestId: request.id, capabilityId: capability.id, runId: request.runId, role: request.role,
      }, request.requestHash);
      return { capability, request, replayed: false };
    });
  }

  async completeInferenceRequest(input: CompleteInferenceRequestInput): Promise<{ capability: InferenceCapability; request: InferenceRequest; replayed: boolean }> {
    validateInferenceCompletion(input);
    return this.transaction(async (client) => {
      const row = (await client.query("SELECT * FROM inference_requests WHERE id=$1 FOR UPDATE", [input.id])).rows[0];
      if (!row) throw new StorageConflictError("Inference request was not reserved");
      const request = this.mapInferenceRequest(row);
      const capabilityRow = (await client.query("SELECT * FROM inference_capabilities WHERE id=$1 FOR UPDATE", [request.capabilityId])).rows[0];
      if (!capabilityRow) throw new StorageConflictError("Inference capability is missing");
      const capability = this.mapInferenceCapability(capabilityRow);
      const completedAt = input.completedAt ?? await this.observeApprovalClock(client);
      if (request.state !== "reserved") {
        const providerSessionId = input.providerSessionId ?? null;
        const providerSessionReused = input.providerSessionReused ?? false;
        const matches = request.state === input.state && request.responseHash === (input.responseHash ?? null)
          && request.providerRequestId === (input.providerRequestId ?? null) && request.inputTokens === input.inputTokens
          && request.outputTokens === input.outputTokens && request.costMicros === input.costMicros
          && request.failureCode === (input.failureCode ?? null)
          && request.providerSessionId === providerSessionId
          && request.providerSessionReused === providerSessionReused;
        if (!matches) throw new StorageConflictError("Inference request was already completed differently");
        return { capability, request, replayed: true };
      }
      const totals = (await client.query(`SELECT coalesce(sum(input_tokens),0) AS input_tokens,
        coalesce(sum(output_tokens),0) AS output_tokens,coalesce(sum(cost_micros),0) AS cost_micros
        FROM inference_requests WHERE capability_id=$1 AND state='completed'`, [capability.id])).rows[0];
      if (Number(totals.input_tokens) + input.inputTokens > capability.maxInputTokens
          || Number(totals.output_tokens) + input.outputTokens > capability.maxOutputTokens
          || Number(totals.cost_micros) + input.costMicros > capability.maxCostMicros) {
        throw new StorageConflictError("Inference completion exceeds its aggregate token or cost budget");
      }
      await client.query(`UPDATE inference_requests SET state=$1,provider_request_id=$2,response_hash=$3,input_tokens=$4,
        output_tokens=$5,cost_micros=$6,completed_at=$7,failure_code=$8,provider_session_id=$9,provider_session_reused=$10
        WHERE id=$11 AND state='reserved'`, [
        input.state, input.providerRequestId ?? null, input.responseHash ?? null, input.inputTokens,
        input.outputTokens, input.costMicros, completedAt, input.failureCode ?? null,
        input.providerSessionId ?? null, input.providerSessionReused ?? false, input.id,
      ]);
      const count = Number((await client.query("SELECT count(*) AS count FROM inference_requests WHERE capability_id=$1", [capability.id])).rows[0].count);
      const costTotal = Number(totals.cost_micros) + input.costMicros;
      if (count >= capability.maxRequests || (capability.maxCostMicros > 0 && costTotal >= capability.maxCostMicros)) {
        await client.query("UPDATE inference_capabilities SET state='exhausted' WHERE id=$1 AND state='active'", [capability.id]);
      }
      await this.insertOutbox(client, `inference.request.${input.state}`, input.id, {
        requestId: input.id, capabilityId: capability.id, runId: request.runId, role: request.role,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens, costMicros: input.costMicros,
        providerSessionId: input.providerSessionId ?? null,
        providerSessionReused: input.providerSessionReused ?? false,
      }, input.responseHash ?? input.failureCode!);
      const finalRequest = this.mapInferenceRequest((await client.query("SELECT * FROM inference_requests WHERE id=$1", [input.id])).rows[0]);
      const finalCapability = this.mapInferenceCapability((await client.query("SELECT * FROM inference_capabilities WHERE id=$1", [capability.id])).rows[0]);
      return { capability: finalCapability, request: finalRequest, replayed: false };
    });
  }

  async revokeInferenceCapability(id: string, observedAt?: string): Promise<InferenceCapability | null> {
    return this.transaction(async (client) => {
      const row = (await client.query("SELECT * FROM inference_capabilities WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) return null;
      const current = this.mapInferenceCapability(row);
      const now = observedAt ?? await this.observeApprovalClock(client);
      const nextState = current.state === "active" ? (current.expiresAt <= now ? "expired" : "revoked") : current.state;
      if (nextState !== current.state) {
        await client.query("UPDATE inference_capabilities SET state=$1 WHERE id=$2 AND state='active'", [nextState, id]);
        await this.insertOutbox(client, "inference.capability.closed", id, { capabilityId: id, runId: current.runId, state: nextState }, nextState);
      }
      return this.mapInferenceCapability((await client.query("SELECT * FROM inference_capabilities WHERE id=$1", [id])).rows[0]);
    });
  }

  async expireInferenceCapabilities(observedAt: string, limit = 100): Promise<InferenceCapability[]> {
    const at = isoString(observedAt);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Inference capability expiry limit must be between 1 and 1000");
    }
    return this.transaction(async (client) => {
      const rows = (await client.query(`SELECT * FROM inference_capabilities
        WHERE state='active' AND expires_at<=$1 ORDER BY expires_at,id
        FOR UPDATE SKIP LOCKED LIMIT $2`, [at, limit])).rows;
      const expired: InferenceCapability[] = [];
      for (const row of rows) {
        const capability = this.mapInferenceCapability(row);
        const updated = await client.query(`UPDATE inference_capabilities SET state='expired'
          WHERE id=$1 AND state='active' AND expires_at<=$2`, [capability.id, at]);
        if (updated.rowCount !== 1) continue;
        await this.insertOutbox(client, "inference.capability.closed", capability.id, {
          capabilityId: capability.id, runId: capability.runId, state: "expired",
        }, "expired");
        expired.push({ ...capability, state: "expired" });
      }
      return expired;
    });
  }

  async listInferenceRequests(runId: string): Promise<InferenceRequest[]> {
    return (await this.pool.query("SELECT * FROM inference_requests WHERE run_id=$1 ORDER BY reserved_at,id", [runId])).rows
      .map(this.mapInferenceRequest);
  }

  async createEngineeringRoutingAssessment(
    inputOrAssessment: CreateEngineeringRoutingAssessmentInput | EngineeringRoutingAssessmentRecord,
    idempotency?: IdempotencyInput,
  ): Promise<CreateEngineeringRoutingAssessmentResult> {
    const isRecord = "id" in inputOrAssessment;
    const assessment = (isRecord
      ? inputOrAssessment
      : inputOrAssessment.assessment ?? inputOrAssessment.record) as EngineeringRoutingAssessmentRecord | undefined;
    const effectiveIdempotency = isRecord ? idempotency : inputOrAssessment.idempotency;
    if (!assessment) throw new StorageConflictError("Routing assessment record is required");
    return this.transaction(async (client) => {
      // Serialize same-assessment creation even when the caller did not supply
      // a transport idempotency key; the ID itself is an immutable replay key.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('engineering-routing-assessment'),hashtext($1))", [assessment.id]);
      if (effectiveIdempotency) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [effectiveIdempotency.scope, effectiveIdempotency.key]);
      }
      const existingLedger = effectiveIdempotency
        ? await this.getIdempotencyRow(client, effectiveIdempotency.scope, effectiveIdempotency.key)
        : null;
      if (existingLedger) {
        if (existingLedger.requestHash !== effectiveIdempotency!.requestHash) throw new IdempotencyConflictError();
        if (existingLedger.resourceType !== "engineering-routing-assessment") {
          throw new IdempotencyConflictError("Idempotency key refers to another resource type");
        }
        const existing = (await client.query("SELECT * FROM engineering_routing_assessments WHERE id=$1 FOR UPDATE", [existingLedger.resourceId])).rows[0];
        if (!existing) throw new StorageConflictError("Routing assessment idempotency record refers to a missing assessment");
        const mapped = this.mapEngineeringRoutingAssessment(existing);
        return { assessment: mapped, replayed: true };
      }

      validateEngineeringRoutingAssessment(assessment);

      const existing = (await client.query("SELECT * FROM engineering_routing_assessments WHERE id=$1 FOR UPDATE", [assessment.id])).rows[0];
      if (existing) {
        const mapped = this.mapEngineeringRoutingAssessment(existing);
        if (canonicalJson(mapped) !== canonicalJson(assessment)) {
          throw new StorageConflictError("Routing assessment ID was reused with different content");
        }
        if (effectiveIdempotency) {
          await this.insertIdempotency(client, effectiveIdempotency, "engineering-routing-assessment", mapped.id, {
            assessmentId: mapped.id,
          });
        }
        return { assessment: mapped, replayed: true };
      }

      const project = (await client.query("SELECT id FROM projects WHERE id=$1", [assessment.projectId])).rows[0];
      if (!project) throw new StorageConflictError("Routing assessment project was not found");
      if (assessment.taskId !== null) {
        const task = (await client.query("SELECT project_id FROM tasks WHERE id=$1", [assessment.taskId])).rows[0];
        if (!task) throw new StorageConflictError("Routing assessment task was not found");
        if (String(task.project_id) !== assessment.projectId) {
          throw new StorageConflictError("Routing assessment task belongs to another project");
        }
      }
      await client.query(`INSERT INTO engineering_routing_assessments
        (id,project_id,task_id,literal_request,request_hash,context_digest,context_sources_json,dimensions_json,
         hard_signals_json,preference,final_action,baseline_shape,selected_shape,score,reasons_json,policy_version,
         execution_supported,unsupported_reasons_json,status,run_id,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18::jsonb,$19,$20,$21,$22)`, [
        assessment.id, assessment.projectId, assessment.taskId, assessment.literalRequest, assessment.requestHash,
        assessment.contextDigest, JSON.stringify(assessment.contextSources), JSON.stringify(assessment.dimensions),
        JSON.stringify(assessment.hardSignals),
        assessment.preference, assessment.finalAction, assessment.baselineShape, assessment.selectedShape,
        assessment.score, JSON.stringify(assessment.reasons),
        assessment.policyVersion, assessment.executionSupported, JSON.stringify(assessment.unsupportedReasons), assessment.status,
        assessment.runId, assessment.createdAt, assessment.expiresAt,
      ]);
      await this.insertOutbox(client, "engineering.routing.assessment.created", assessment.id, {
        assessmentId: assessment.id, projectId: assessment.projectId, taskId: assessment.taskId,
        requestHash: assessment.requestHash, contextDigest: assessment.contextDigest,
        contextSources: assessment.contextSources, dimensions: assessment.dimensions, hardSignals: assessment.hardSignals,
        preference: assessment.preference, finalAction: assessment.finalAction,
        baselineShape: assessment.baselineShape, selectedShape: assessment.selectedShape,
        score: assessment.score, reasons: assessment.reasons, policyVersion: assessment.policyVersion,
        executionSupported: assessment.executionSupported, unsupportedReasons: assessment.unsupportedReasons,
        status: assessment.status, runId: assessment.runId,
      }, assessment.id);
      if (effectiveIdempotency) {
        await this.insertIdempotency(client, effectiveIdempotency, "engineering-routing-assessment", assessment.id, {
          assessmentId: assessment.id,
        });
      }
      return { assessment, replayed: false };
    });
  }

  async getEngineeringRoutingAssessment(id: string): Promise<EngineeringRoutingAssessmentRecord | null> {
    const row = (await this.pool.query("SELECT * FROM engineering_routing_assessments WHERE id=$1", [id])).rows[0];
    return row ? this.mapEngineeringRoutingAssessment(row) : null;
  }

  async listEngineeringRoutingAssessments(projectId?: string, limit = 100): Promise<EngineeringRoutingAssessmentRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Routing assessment list limit must be between 1 and 1000");
    }
    if (projectId !== undefined && (typeof projectId !== "string" || !projectId || projectId.length > 128
        || /[\u0000-\u001f\u007f]/.test(projectId))) {
      throw new StorageConflictError("Routing assessment project ID is invalid");
    }
    const result = projectId
      ? await this.pool.query(`SELECT * FROM engineering_routing_assessments
        WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [projectId, limit])
      : await this.pool.query(`SELECT * FROM engineering_routing_assessments
        ORDER BY created_at DESC,id DESC LIMIT $1`, [limit]);
    return result.rows.map(this.mapEngineeringRoutingAssessment);
  }

  async createComparison(comparison: ComparisonRecord): Promise<ComparisonRecord> {
    validateComparisonRecord(comparison);
    return this.transaction(async (client) => {
      const existing = (await client.query("SELECT * FROM comparisons WHERE id=$1 FOR UPDATE", [comparison.id])).rows[0];
      if (existing) {
        const mapped = this.mapComparison(existing);
        if (canonicalJson(mapped) !== canonicalJson(comparison)) throw new StorageConflictError("Comparison ID was reused with different content");
        return mapped;
      }
      await client.query(`INSERT INTO comparisons
        (id,project_id,task_id,objective,contract_hash,status,selection_policy,created_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        comparison.id, comparison.projectId, comparison.taskId, comparison.objective, comparison.contractHash,
        comparison.status, comparison.selectionPolicy, comparison.createdAt, comparison.completedAt,
      ]);
      await this.insertOutbox(client, "comparison.created", comparison.id, { comparisonId: comparison.id, projectId: comparison.projectId }, comparison.id);
      return comparison;
    });
  }

  async getComparison(id: string): Promise<ComparisonRecord | null> {
    const row = (await this.pool.query("SELECT * FROM comparisons WHERE id=$1", [id])).rows[0];
    return row ? this.mapComparison(row) : null;
  }

  async completeComparison(id: string, status: "complete" | "failed", completedAt: string): Promise<ComparisonRecord> {
    return this.transaction(async (client) => {
      const row = (await client.query("SELECT * FROM comparisons WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new StorageConflictError("Comparison was not found");
      const current = this.mapComparison(row);
      if (current.status !== "running") {
        if (current.status !== status || current.completedAt !== completedAt) throw new StorageConflictError("Comparison terminal replay changed content");
        return current;
      }
      await client.query("UPDATE comparisons SET status=$1,completed_at=$2 WHERE id=$3 AND status='running'", [status, completedAt, id]);
      await this.insertOutbox(client, "comparison.completed", id, { comparisonId: id, status }, status);
      return { ...current, status, completedAt };
    });
  }

  async attachComparisonCandidate(candidate: ComparisonCandidate): Promise<ComparisonCandidate> {
    validateComparisonCandidate(candidate, false);
    return this.transaction(async (client) => {
      const existing = (await client.query(`SELECT * FROM comparison_candidates
        WHERE comparison_id=$1 AND run_id=$2 FOR UPDATE`, [candidate.comparisonId, candidate.runId])).rows[0];
      if (existing) {
        const mapped = this.mapComparisonCandidate(existing);
        if (canonicalJson(mapped) !== canonicalJson(candidate)) throw new StorageConflictError("Comparison candidate replay changed content");
        return mapped;
      }
      await client.query(`INSERT INTO comparison_candidates
        (comparison_id,run_id,runtime,workflow,ordinal,status,metrics_json,evidence_digest,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        candidate.comparisonId, candidate.runId, candidate.runtime, candidate.workflow, candidate.ordinal,
        candidate.status, null, null, candidate.createdAt, candidate.updatedAt,
      ]);
      await this.insertOutbox(client, "comparison.candidate.attached", candidate.runId, { comparisonId: candidate.comparisonId, runId: candidate.runId }, candidate.comparisonId);
      return candidate;
    });
  }

  async finalizeComparisonCandidate(candidate: ComparisonCandidate): Promise<ComparisonCandidate> {
    validateComparisonCandidate(candidate, true);
    return this.transaction(async (client) => {
      const row = (await client.query(`SELECT * FROM comparison_candidates
        WHERE comparison_id=$1 AND run_id=$2 FOR UPDATE`, [candidate.comparisonId, candidate.runId])).rows[0];
      if (!row) throw new StorageConflictError("Comparison candidate was not attached");
      const existing = this.mapComparisonCandidate(row);
      if (existing.status !== "running") {
        if (canonicalJson(existing) !== canonicalJson(candidate)) throw new StorageConflictError("Final comparison candidate replay changed content");
        return existing;
      }
      if (existing.runtime !== candidate.runtime || existing.workflow !== candidate.workflow || existing.ordinal !== candidate.ordinal
          || existing.createdAt !== candidate.createdAt) throw new StorageConflictError("Comparison candidate identity changed during finalization");
      await client.query(`UPDATE comparison_candidates SET status=$1,metrics_json=$2,evidence_digest=$3,updated_at=$4
        WHERE comparison_id=$5 AND run_id=$6`, [
        candidate.status, candidate.metrics, candidate.evidenceDigest, candidate.updatedAt,
        candidate.comparisonId, candidate.runId,
      ]);
      await this.insertOutbox(client, "comparison.candidate.finalized", candidate.runId, { comparisonId: candidate.comparisonId, runId: candidate.runId, status: candidate.status }, candidate.evidenceDigest!);
      return candidate;
    });
  }

  async listComparisonCandidates(comparisonId: string): Promise<ComparisonCandidate[]> {
    return (await this.pool.query(`SELECT * FROM comparison_candidates
      WHERE comparison_id=$1 ORDER BY ordinal,run_id`, [comparisonId])).rows.map(this.mapComparisonCandidate);
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

  async createArtifactBatch(artifacts: Artifact[]): Promise<ArtifactBatchResult> {
    const runId = validateArtifactBatchInput(artifacts);
    return this.transaction(async (client) => {
      const run = await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [runId]);
      if (run.rowCount !== 1) throw new StorageConflictError("Artifact batch run not found");
      let inserted = 0;
      const persisted: Artifact[] = [];
      for (const artifact of artifacts) {
        const row = (await client.query("SELECT * FROM artifacts WHERE id=$1 FOR UPDATE", [artifact.id])).rows[0];
        if (row) {
          const existing = this.mapArtifact(row);
          if (!artifactsEqual(existing, artifact)) {
            throw new StorageConflictError(`Artifact ${artifact.id} was already used with different content`);
          }
          persisted.push(existing);
        } else {
          const created = await client.query(`INSERT INTO artifacts
            (id,run_id,kind,uri,checksum,media_type,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
            artifact.id, artifact.runId, artifact.kind, artifact.uri, artifact.checksum,
            artifact.mediaType, artifact.createdAt,
          ]);
          persisted.push(this.mapArtifact(created.rows[0]));
          inserted += 1;
        }
        await this.insertOutbox(client, "artifact.created", artifact.id, {
          artifactId: artifact.id, runId: artifact.runId, kind: artifact.kind, checksum: artifact.checksum,
        }, artifact.id);
      }
      return { artifacts: persisted, replayed: inserted === 0 };
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
    const [queued, strandedIds, terminal, expired, quarantined, pending] = await Promise.all([
      this.pool.query("SELECT * FROM runs WHERE status='queued' ORDER BY created_at"),
      this.pool.query(`SELECT a.id FROM approvals a JOIN runs r ON r.id=a.run_id
        WHERE a.state<>'pending' AND r.status='awaiting_approval' ORDER BY a.resolved_at`),
      this.pool.query(`SELECT l.* FROM workspace_leases l JOIN runs r ON r.id=l.run_id
        WHERE l.state='active' AND r.status IN ('completed','failed','cancelled') ORDER BY l.heartbeat_at`),
      this.pool.query("SELECT * FROM workspace_leases WHERE state='active' AND expires_at<=$1 ORDER BY expires_at", [now]),
      this.pool.query(`SELECT * FROM workspace_leases
        WHERE state='quarantined' ORDER BY quarantined_at,workspace_id`),
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
      quarantinedLeases: quarantined.rows.map(this.mapLease),
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
    workspaceId: row.workspace_id, runId: row.run_id, ownerId: row.owner_id, mode: row.mode,
    fencingToken: Number(row.fencing_token), state: row.state,
    expiresAt: isoString(row.expires_at), heartbeatAt: isoString(row.heartbeat_at),
    acquiredAt: isoString(row.acquired_at), quarantinedAt: nullableIsoString(row.quarantined_at),
    quarantineReason: row.quarantine_reason,
  });

  private mapSandboxInstance = (row: any): SandboxInstance => ({
    runId: String(row.run_id), workspaceId: String(row.workspace_id), leaseOwnerId: String(row.lease_owner_id),
    fencingToken: Number(row.fencing_token), provider: "docker-compatible", engineId: row.engine_id ? String(row.engine_id) : null,
    imageRef: String(row.image_ref), policyHash: String(row.policy_hash), workspaceDigest: String(row.workspace_digest),
    contextDigest: String(row.context_digest), contextContentHash: String(row.context_content_hash),
    workdirDigest: String(row.workdir_digest), state: String(row.state) as SandboxInstanceState,
    cleanupAttempts: Number(row.cleanup_attempts), lastCleanupAt: nullableIsoString(row.last_cleanup_at),
    quarantineReason: row.quarantine_reason ? String(row.quarantine_reason) : null,
    createdAt: isoString(row.created_at), updatedAt: isoString(row.updated_at),
  });

  private mapApproval = (row: any): Approval => ({
    id: row.id, runId: row.run_id, action: row.action, exactEffect: row.exact_effect, state: row.state,
    evidence: decodeJson(row.evidence_json, []), requestedAt: isoString(row.requested_at),
    resolvedAt: nullableIsoString(row.resolved_at), resolvedBy: row.resolved_by, decision: row.decision,
    projectId: row.project_id ?? null, workflow: row.workflow ?? null,
    evidenceDigest: row.evidence_digest ?? null, policyHash: row.policy_hash ?? null,
    expiresAt: nullableIsoString(row.expires_at),
  });

  private mapInferenceCapability = (row: any): InferenceCapability => ({
    id: String(row.id), runId: String(row.run_id), projectId: String(row.project_id), workflow: String(row.workflow),
    tokenHash: String(row.token_hash), provider: String(row.provider), model: String(row.model), api: "openai-completions",
    roles: decodeJson(row.roles_json, []) as InferenceCapability["roles"], maxRequests: Number(row.max_requests),
    maxInputTokens: Number(row.max_input_tokens), maxOutputTokens: Number(row.max_output_tokens),
    maxCostMicros: Number(row.max_cost_micros), maxElapsedMs: Number(row.max_elapsed_ms), issuedAt: isoString(row.issued_at),
    expiresAt: isoString(row.expires_at), state: String(row.state) as InferenceCapability["state"], policyHash: String(row.policy_hash),
  });

  private mapInferenceRequest = (row: any): InferenceRequest => ({
    id: String(row.id), capabilityId: String(row.capability_id), runId: String(row.run_id),
    role: String(row.role) as InferenceRequest["role"], requestHash: String(row.request_hash),
    state: String(row.state) as InferenceRequest["state"], providerRequestId: row.provider_request_id ? String(row.provider_request_id) : null,
    responseHash: row.response_hash ? String(row.response_hash) : null, inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens), costMicros: Number(row.cost_micros), reservedAt: isoString(row.reserved_at),
    completedAt: nullableIsoString(row.completed_at), failureCode: row.failure_code ? String(row.failure_code) : null,
    providerSessionId: row.provider_session_id ? String(row.provider_session_id) : null,
    providerSessionReused: row.provider_session_reused === true || row.provider_session_reused === 1,
  });

  private mapEngineeringRoutingAssessment = (row: any): EngineeringRoutingAssessmentRecord => ({
    id: String(row.id), projectId: String(row.project_id), taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    literalRequest: String(row.literal_request), requestHash: String(row.request_hash), contextDigest: String(row.context_digest),
    contextSources: decodeJson(row.context_sources_json, {}) as EngineeringRoutingAssessmentRecord["contextSources"],
    dimensions: decodeJson(row.dimensions_json, {}) as EngineeringRoutingAssessmentRecord["dimensions"],
    hardSignals: decodeJson(row.hard_signals_json, {}) as EngineeringRoutingAssessmentRecord["hardSignals"],
    preference: String(row.preference) as EngineeringRoutingAssessmentRecord["preference"],
    finalAction: String(row.final_action) as EngineeringRoutingAssessmentRecord["finalAction"],
    baselineShape: String(row.baseline_shape) as EngineeringRoutingAssessmentRecord["baselineShape"],
    selectedShape: String(row.selected_shape) as EngineeringRoutingAssessmentRecord["selectedShape"], score: Number(row.score),
    reasons: decodeJson(row.reasons_json, []) as string[], policyVersion: String(row.policy_version),
    executionSupported: row.execution_supported === true || row.execution_supported === 1,
    unsupportedReasons: decodeJson(row.unsupported_reasons_json, []) as string[],
    status: String(row.status) as EngineeringRoutingAssessmentRecord["status"],
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    createdAt: isoString(row.created_at), expiresAt: isoString(row.expires_at),
  });

  private mapComparison = (row: any): ComparisonRecord => ({
    id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), objective: String(row.objective),
    contractHash: String(row.contract_hash), status: String(row.status) as ComparisonRecord["status"],
    selectionPolicy: String(row.selection_policy), createdAt: isoString(row.created_at), completedAt: nullableIsoString(row.completed_at),
  });

  private mapComparisonCandidate = (row: any): ComparisonCandidate => ({
    comparisonId: String(row.comparison_id), runId: String(row.run_id), runtime: String(row.runtime),
    workflow: String(row.workflow), ordinal: Number(row.ordinal), status: String(row.status) as ComparisonCandidate["status"],
    metrics: row.metrics_json ? decodeJson(row.metrics_json, null as ComparisonMetrics | null) : null,
    evidenceDigest: row.evidence_digest ? String(row.evidence_digest) : null,
    createdAt: isoString(row.created_at), updatedAt: isoString(row.updated_at),
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
