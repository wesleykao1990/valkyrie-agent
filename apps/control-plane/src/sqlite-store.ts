import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Approval, Artifact, MemoryProposal, Project, Run, RunEvent, Task } from "./types.ts";
import { nowIso } from "./ids.ts";
import { assertUniqueMigrationVersions, loadMigrationFiles } from "./migrations.ts";
import {
  assertRunPatchApplied,
  canonicalJson,
  artifactsEqual,
  decodeJson,
  deterministicOutboxId,
  IdempotencyConflictError,
  isoString,
  observeStoreClock,
  StorageConflictError,
  validateArtifactBatchInput,
  validateAuthorityBinding,
  validateAuthorityRefresh,
  validateProviderReceipt,
  validateDeliveryIdentity,
  validateOutboxDeliveryClaim,
  validateOutboxDeliveryFence,
  validateOutboxDeliveryFailure,
  validateOutboxDeliveryReplay,
  validateOutboxDeliveryPrune,
  validateExternalActionPlan,
  validateExternalActionPlanRequest,
  validateExternalActionReceipt,
  validateExternalActionReconciliation,
  validateExternalActionDeliveryFence,
  validateExternalActionError,
  externalActionAuthorizedOutboxId,
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
  type AuthorityBinding,
  type AuthorityBindingRefreshInput,
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
  type OutboxDelivery,
  type OutboxDeliveryAckInput,
  type OutboxDeliveryAttemptEvidence,
  type OutboxDeliveryClaimInput,
  type OutboxDeliveryFailureInput,
  type OutboxDeliveryPruneInput,
  type OutboxDeliveryReplayInput,
  type OutboxDeliveryState,
  type ExternalActionPlan,
  type ExternalActionPlanRequestInput,
  type ExternalActionPlanRequestResult,
  type ExternalActionApprovalInput,
  type ExternalActionApprovalResult,
  type ExternalActionPlanExpiryInput,
  type BeginExternalActionAttemptInput,
  type CompleteExternalActionAttemptInput,
  type FailExternalActionAttemptInput,
  type ReconcileExternalActionPlanInput,
  type ExternalActionPlanListInput,
  type ExternalActionPlanState,
  MAX_OUTBOX_DELIVERY_ATTEMPTS,
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

export interface SqliteStoreOptions {
  now?: StoreClock;
}

export class SqliteStore implements ControlPlaneStore {
  readonly backend = "sqlite" as const;
  private db: DatabaseSync;
  private initialMigrationResults: MigrationResult[];
  private readonly clock: StoreClock;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.clock = options.now ?? (() => new Date());
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
      DELETE FROM external_action_plans;
      DELETE FROM outbox_deliveries;
      DELETE FROM outbox_events;
      DELETE FROM authority_bindings;
      DELETE FROM inference_requests;
      DELETE FROM inference_capabilities;
      DELETE FROM engineering_routing_assessments;
      DELETE FROM comparison_candidates;
      DELETE FROM comparisons;
      DELETE FROM sandbox_instances;
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

      if (input.admission) {
        if (input.admission.workflow !== effectiveRun.workflow || input.admission.maxNonterminal !== 1) {
          throw new StorageConflictError("Run admission must bind the exact workflow with maxNonterminal=1");
        }
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM runs
          WHERE workflow=? AND status IN ('queued','running','paused','awaiting_approval')`).get(
          input.admission.workflow,
        ) as { count: number };
        if (Number(row.count) >= input.admission.maxNonterminal) {
          throw new StorageConflictError(`Run admission limit reached for workflow ${input.admission.workflow}`);
        }
      }

      // Insert without the circular reference, then link ownership after the
      // workspace and lease exist. Migration triggers validate the final link.
      this.insertRun(input.workspace ? { ...effectiveRun, workspaceId: null } : effectiveRun);
      let persistedLease: WorkspaceLease | undefined;
      if (input.workspace && input.lease) {
        this.insertWorkspace(input.workspace);
        persistedLease = this.insertLease(input.lease, observeStoreClock(this.clock));
        this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(input.workspace.id, effectiveRun.id);
        this.insertOutbox("workspace.lease.acquired", input.workspace.id, {
          workspaceId: input.workspace.id, runId: effectiveRun.id, ownerId: persistedLease.ownerId,
          mode: persistedLease.mode, fencingToken: persistedLease.fencingToken,
        }, `${persistedLease.workspaceId}:${persistedLease.fencingToken}`);
      }
      this.insertOutbox("run.created", effectiveRun.id, {
        runId: effectiveRun.id, projectId: effectiveRun.projectId, rootRuntime: effectiveRun.rootRuntime,
      }, effectiveRun.id);

      const result: RunBundleResult = {
        run: effectiveRun,
        workspace: input.workspace,
        lease: persistedLease,
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

  async claimQueuedRunForStart(runId: string, workerId: string, claimUntil: string): Promise<Run | null> {
    const observedAt = observeStoreClock(this.clock);
    validateQueuedRunClaim(workerId, claimUntil, observedAt);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE runs
        SET worker_claimed_by=?, worker_claim_expires_at=?
        WHERE id=? AND status='queued'
          AND (worker_claim_expires_at IS NULL OR worker_claim_expires_at<=?)`)
        .run(workerId, claimUntil, runId, observedAt) as any;
      if (Number(result.changes) !== 1) return null;
      return this.getRunRow(runId);
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

  async createLease(lease: WriterLeaseRequest): Promise<WorkspaceLease> {
    validateWriterLeaseRequest(lease);
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      validateWriterLeaseWindow(lease, observedAt);
      const workspace = this.getWorkspaceRow(lease.workspaceId);
      if (!workspace || workspace.runId !== lease.runId) throw new StorageConflictError("Lease owner does not match workspace owner");
      const run = this.getRunRow(lease.runId);
      if (!run || (run.workspaceId && run.workspaceId !== lease.workspaceId)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      const persisted = this.insertLease(lease, observedAt);
      this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=? AND workspace_id IS NULL").run(lease.workspaceId, lease.runId);
      this.insertOutbox("workspace.lease.acquired", lease.workspaceId, {
        workspaceId: lease.workspaceId, runId: lease.runId, ownerId: lease.ownerId,
        mode: lease.mode, fencingToken: persisted.fencingToken,
      }, `${lease.workspaceId}:${persisted.fencingToken}`);
      return persisted;
    });
  }

  private nextFencingToken(workspaceId: string, runId: string): number {
    const row = this.db.prepare(`UPDATE workspaces SET lease_epoch=lease_epoch+1
      WHERE id=? AND run_id=? AND lease_epoch<9007199254740991
      RETURNING lease_epoch`).get(workspaceId, runId) as any;
    if (!row) throw new StorageConflictError("Workspace lease epoch is unavailable or exhausted");
    const token = Number(row.lease_epoch);
    if (!Number.isSafeInteger(token) || token < 1) throw new StorageConflictError("Workspace lease epoch is invalid");
    return token;
  }

  private insertLease(lease: WriterLeaseRequest, observedAt: string): WorkspaceLease {
    validateWriterLeaseRequest(lease);
    validateWriterLeaseWindow(lease, observedAt);
    const fencingToken = this.nextFencingToken(lease.workspaceId, lease.runId);
    this.db.prepare(`INSERT INTO workspace_leases
      (workspace_id,run_id,owner_id,mode,fencing_token,state,expires_at,heartbeat_at,acquired_at,quarantined_at,quarantine_reason)
      VALUES (?,?,?,?,?,'active',?,?,?,NULL,NULL)`).run(
        lease.workspaceId, lease.runId, lease.ownerId, lease.mode, fencingToken,
        lease.expiresAt, lease.heartbeatAt, lease.heartbeatAt,
      );
    return this.getLeaseRow(lease.workspaceId)!;
  }

  async createWorkspaceLease(workspace: WorkspaceRecord, lease: WriterLeaseRequest): Promise<WorkspaceLeaseResult> {
    this.validateWorkspaceLease(workspace, lease, workspace.runId);
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      validateWriterLeaseWindow(lease, observedAt);
      const run = this.getRunRow(workspace.runId);
      if (!run || (run.workspaceId && run.workspaceId !== workspace.id)) {
        throw new StorageConflictError("Run already owns another workspace or is missing");
      }
      const existingWorkspace = this.getWorkspaceRow(workspace.id);
      const existingLease = this.getLeaseRow(lease.workspaceId);
      if (existingWorkspace || existingLease) {
        if (existingWorkspace?.runId === workspace.runId && existingLease?.runId === lease.runId &&
            existingLease.ownerId === lease.ownerId && existingLease.mode === lease.mode &&
            existingLease.state === "active" && existingLease.heartbeatAt === lease.heartbeatAt &&
            existingLease.expiresAt === lease.expiresAt) {
          if (!run.workspaceId) this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(workspace.id, run.id);
          return { workspace: existingWorkspace, lease: existingLease, replayed: true };
        }
        throw new StorageConflictError("Workspace or lease ID is already owned by another run");
      }
      if (run.status !== "queued") {
        throw new StorageConflictError("A new writer workspace can be claimed only by a queued run");
      }
      this.insertWorkspace(workspace);
      const persisted = this.insertLease(lease, observedAt);
      this.db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(workspace.id, run.id);
      this.insertOutbox("workspace.lease.acquired", workspace.id, {
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
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      validateWriterLeaseWindow(lease, observedAt);
      const workspace = this.getWorkspaceRow(lease.workspaceId);
      if (!workspace || workspace.runId !== lease.runId) {
        throw new StorageConflictError("Lease owner does not match workspace owner");
      }
      const run = this.getRunRow(lease.runId);
      if (!run || run.workspaceId !== lease.workspaceId) {
        throw new StorageConflictError("Run does not own the workspace being rotated");
      }
      const previous = this.getLeaseRow(lease.workspaceId);
      if (previous?.state === "quarantined") {
        throw new StorageConflictError("A quarantined writer lease requires explicit fenced release before reacquisition");
      }
      if (previous && Date.parse(previous.expiresAt) > Date.parse(observedAt)) {
        throw new StorageConflictError("An unexpired writer lease cannot be rotated");
      }

      const fencingToken = this.nextFencingToken(lease.workspaceId, lease.runId);
      if (previous) {
        this.db.prepare(`UPDATE workspace_leases
          SET owner_id=?,mode=?,fencing_token=?,state='active',expires_at=?,heartbeat_at=?,acquired_at=?,
              quarantined_at=NULL,quarantine_reason=NULL
          WHERE workspace_id=? AND run_id=? AND fencing_token=?`).run(
            lease.ownerId, lease.mode, fencingToken, lease.expiresAt, lease.heartbeatAt, lease.heartbeatAt,
            lease.workspaceId, lease.runId, previous.fencingToken,
          );
      } else {
        this.db.prepare(`INSERT INTO workspace_leases
          (workspace_id,run_id,owner_id,mode,fencing_token,state,expires_at,heartbeat_at,acquired_at,quarantined_at,quarantine_reason)
          VALUES (?,?,?,?,?,'active',?,?,?,NULL,NULL)`).run(
            lease.workspaceId, lease.runId, lease.ownerId, lease.mode, fencingToken,
            lease.expiresAt, lease.heartbeatAt, lease.heartbeatAt,
          );
      }
      this.db.prepare("UPDATE workspaces SET status='leased' WHERE id=? AND run_id=?")
        .run(lease.workspaceId, lease.runId);
      const persisted = this.getLeaseRow(lease.workspaceId)!;
      this.insertOutbox(previous ? "workspace.lease.rotated" : "workspace.lease.acquired", lease.workspaceId, {
        workspaceId: lease.workspaceId, runId: lease.runId, ownerId: lease.ownerId,
        fencingToken, previousOwnerId: previous?.ownerId ?? null,
        previousFencingToken: previous?.fencingToken ?? null, previousExpiresAt: previous?.expiresAt ?? null,
      }, `${lease.workspaceId}:${fencingToken}`);
      return persisted;
    });
  }

  async renewWorkspaceLease(input: WorkspaceLeaseRenewal): Promise<WorkspaceLease | null> {
    validateWorkspaceLeaseRenewal(input);
    const observedAt = observeStoreClock(this.clock);
    validateWriterLeaseWindow(input, observedAt);
    const row = this.db.prepare(`UPDATE workspace_leases SET heartbeat_at=?,expires_at=?
      WHERE workspace_id=? AND run_id=? AND owner_id=? AND fencing_token=? AND state='active'
        AND expires_at>? AND heartbeat_at<=? AND expires_at<=? RETURNING *`).get(
          input.heartbeatAt, input.expiresAt, input.workspaceId, input.runId, input.ownerId, input.fencingToken,
          observedAt, input.heartbeatAt, input.expiresAt,
        ) as any;
    return row ? this.mapLease(row) : null;
  }

  async quarantineWorkspaceLease(input: WorkspaceLeaseQuarantine): Promise<WorkspaceLease | null> {
    validateWorkspaceLeaseQuarantine(input);
    return this.transaction(() => {
      const lease = this.getLeaseRow(input.workspaceId);
      if (!lease || lease.runId !== input.runId || lease.ownerId !== input.ownerId ||
          lease.fencingToken !== input.fencingToken) return null;
      if (Date.parse(input.quarantinedAt) < Date.parse(lease.acquiredAt)) {
        throw new StorageConflictError("Writer lease quarantine time cannot precede acquisition");
      }
      if (lease.state === "quarantined") {
        if (lease.quarantinedAt === input.quarantinedAt && lease.quarantineReason === input.reason) return lease;
        throw new StorageConflictError("Writer lease was already quarantined with different evidence");
      }
      const updated = this.db.prepare(`UPDATE workspace_leases
        SET state='quarantined',quarantined_at=?,quarantine_reason=?
        WHERE workspace_id=? AND run_id=? AND owner_id=? AND fencing_token=? AND state='active'`).run(
          input.quarantinedAt, input.reason, input.workspaceId, input.runId, input.ownerId, input.fencingToken,
        ) as any;
      if (Number(updated.changes) !== 1) return null;
      this.db.prepare("UPDATE workspaces SET status='quarantined' WHERE id=? AND run_id=?")
        .run(input.workspaceId, input.runId);
      this.insertOutbox("workspace.lease.quarantined", input.workspaceId, {
        workspaceId: input.workspaceId, runId: input.runId, ownerId: input.ownerId,
        fencingToken: input.fencingToken, quarantinedAt: input.quarantinedAt, reason: input.reason,
      }, `${input.workspaceId}:${input.fencingToken}:quarantined`);
      return this.getLeaseRow(input.workspaceId);
    });
  }

  async releaseWorkspaceLease(fence: WorkspaceLeaseFence): Promise<boolean> {
    validateWorkspaceLeaseFence(fence);
    return this.transaction(() => {
      const lease = this.getLeaseRow(fence.workspaceId);
      if (!lease) return false;
      if (lease.runId !== fence.runId || lease.ownerId !== fence.ownerId || lease.fencingToken !== fence.fencingToken) {
        return false;
      }
      const deleted = this.db.prepare(`DELETE FROM workspace_leases
        WHERE workspace_id=? AND run_id=? AND owner_id=? AND fencing_token=?`).run(
          fence.workspaceId, fence.runId, fence.ownerId, fence.fencingToken,
        ) as any;
      if (Number(deleted.changes) !== 1) return false;
      this.db.prepare("UPDATE workspaces SET status='released' WHERE id=? AND run_id=?").run(fence.workspaceId, fence.runId);
      this.insertOutbox("workspace.lease.released", fence.workspaceId, {
        workspaceId: fence.workspaceId, runId: fence.runId, ownerId: fence.ownerId,
        fencingToken: fence.fencingToken, priorState: lease.state,
        quarantinedAt: lease.quarantinedAt, quarantineReason: lease.quarantineReason,
      }, `${fence.workspaceId}:${fence.fencingToken}:released`);
      return true;
    });
  }

  async getWorkspaceLease(workspaceId: string): Promise<WorkspaceLease | null> {
    return this.getLeaseRow(workspaceId);
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    return (this.db.prepare("SELECT * FROM workspace_leases WHERE state='active' ORDER BY heartbeat_at DESC").all() as any[])
      .map(this.mapLease);
  }

  async createSandboxInstance(input: SandboxInstanceCreateInput): Promise<SandboxInstance> {
    validateSandboxInstanceCreate(input);
    return this.transaction(() => {
      const existing = this.getSandboxInstanceRow(input.runId);
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
      const run = this.getRunRow(input.runId);
      const workspace = this.getWorkspaceRow(input.workspaceId);
      const lease = this.getLeaseRow(input.workspaceId);
      if (!run || run.workspaceId !== input.workspaceId || !workspace || workspace.runId !== input.runId
          || !lease || lease.state !== "active" || lease.runId !== input.runId
          || lease.ownerId !== input.leaseOwnerId || lease.fencingToken !== input.fencingToken) {
        throw new StorageConflictError("Sandbox instance does not own the current exact writer lease");
      }
      this.db.prepare(`INSERT INTO sandbox_instances
        (run_id,workspace_id,lease_owner_id,fencing_token,provider,engine_id,image_ref,policy_hash,
         workspace_digest,context_digest,context_content_hash,workdir_digest,state,cleanup_attempts,last_cleanup_at,
         quarantine_reason,created_at,updated_at)
        VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,'provisioning',0,NULL,NULL,?,?)`).run(
        input.runId, input.workspaceId, input.leaseOwnerId, input.fencingToken, input.provider,
        input.imageRef, input.policyHash, input.workspaceDigest, input.contextDigest, input.contextContentHash, input.workdirDigest,
        input.createdAt, input.updatedAt,
      );
      this.insertOutbox("sandbox.instance.provisioning", input.runId, {
        runId: input.runId, workspaceId: input.workspaceId, ownerId: input.leaseOwnerId,
        fencingToken: input.fencingToken, provider: input.provider, policyHash: input.policyHash,
      }, `${input.runId}:provisioning`);
      return this.getSandboxInstanceRow(input.runId)!;
    });
  }

  async getSandboxInstance(runId: string): Promise<SandboxInstance | null> {
    return this.getSandboxInstanceRow(runId);
  }

  async listSandboxInstances(states?: SandboxInstanceState[]): Promise<SandboxInstance[]> {
    if (states && states.length === 0) return [];
    if (!states) return (this.db.prepare("SELECT * FROM sandbox_instances ORDER BY created_at,run_id").all() as any[])
      .map(this.mapSandboxInstance);
    const allowed: SandboxInstanceState[] = ["provisioning", "ready", "running", "freezing", "exporting", "cleaned", "quarantined"];
    if (states.some((state) => !allowed.includes(state))) throw new StorageConflictError("Unknown sandbox instance state");
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM sandbox_instances WHERE state IN (${placeholders}) ORDER BY created_at,run_id`)
      .all(...states) as any[]).map(this.mapSandboxInstance);
  }

  async transitionSandboxInstance(input: SandboxInstanceTransitionInput): Promise<SandboxInstance | null> {
    validateSandboxInstanceTransition(input);
    return this.transaction(() => {
      const current = this.getSandboxInstanceRow(input.runId);
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
      this.db.prepare(`UPDATE sandbox_instances
        SET state=?,engine_id=?,cleanup_attempts=?,last_cleanup_at=COALESCE(?,last_cleanup_at),
            quarantine_reason=?,updated_at=?
        WHERE run_id=? AND workspace_id=? AND lease_owner_id=? AND fencing_token=? AND state=?`).run(
        input.state, engineId, cleanupAttempts, input.cleanupAttemptedAt ?? null,
        input.state === "quarantined" ? input.quarantineReason ?? null : null, input.updatedAt,
        input.runId, input.workspaceId, input.ownerId, input.fencingToken, input.expectedState,
      );
      this.insertOutbox(`sandbox.instance.${input.state}`, input.runId, {
        runId: input.runId, workspaceId: input.workspaceId, ownerId: input.ownerId,
        fencingToken: input.fencingToken, state: input.state, engineId,
        cleanupAttempts, quarantineReason: input.quarantineReason ?? null,
      }, `${input.runId}:${input.state}`);
      return this.getSandboxInstanceRow(input.runId);
    });
  }

  private getSandboxInstanceRow(runId: string): SandboxInstance | null {
    const row = this.db.prepare("SELECT * FROM sandbox_instances WHERE run_id=?").get(runId) as any;
    return row ? this.mapSandboxInstance(row) : null;
  }

  private getLeaseRow(workspaceId: string): WorkspaceLease | null {
    const row = this.db.prepare("SELECT * FROM workspace_leases WHERE workspace_id=?").get(workspaceId) as any;
    return row ? this.mapLease(row) : null;
  }

  async requestApprovalTransaction(input: ApprovalRequestInput): Promise<ApprovalRequestResult> {
    if (input.approval.state !== "pending") throw new StorageConflictError("A requested approval must be pending");
    if (input.event.runId !== input.approval.runId) throw new StorageConflictError("Approval request event must belong to the approval run");
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
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
        validateApprovalRequestBinding(input.approval, run, observedAt);
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
        validateApprovalRequestBinding(input.approval, run, observedAt);
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        if (input.idempotency) {
          this.insertIdempotency(input.idempotency, "approval", existing.id, { approvalId: existing.id, runId: existing.runId });
        }
        return { approval: existing, run, event, replayed: true };
      }

      const run = this.getRunRow(input.approval.runId);
      if (!run) throw new StorageConflictError("Approval run not found");
      validateApprovalRequestBinding(input.approval, run, observedAt);
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
    if (stored.id !== requested.id || stored.runId !== requested.runId || stored.type !== requested.type || stored.message !== requested.message ||
        canonicalJson(stored.payload) !== canonicalJson(requested.payload)) {
      throw new StorageConflictError(`Event ${requested.id} was already used with different content`);
    }
  }

  private insertApproval(approval: Approval): void {
    this.db.prepare(`INSERT INTO approvals
      (id,run_id,action,exact_effect,state,evidence_json,requested_at,resolved_at,resolved_by,decision,
       project_id,workflow,evidence_digest,policy_hash,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        approval.id, approval.runId, approval.action, approval.exactEffect, approval.state,
        JSON.stringify(approval.evidence), approval.requestedAt, approval.resolvedAt ?? null,
        approval.resolvedBy ?? null, approval.decision ?? null, approval.projectId ?? null,
        approval.workflow ?? null, approval.evidenceDigest ?? null, approval.policyHash ?? null,
        approval.expiresAt ?? null,
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

  async listExpiredApprovals(projectId: string, workflow: string, observedAt: string, limit = 100): Promise<Approval[]> {
    const at = isoString(observedAt);
    if (!projectId.trim() || !workflow.trim()) throw new StorageConflictError("Expired approval query requires project and workflow");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Expired approval query limit must be between 1 and 1000");
    }
    const rows = this.db.prepare(`SELECT * FROM approvals
      WHERE project_id=? AND workflow=? AND state='pending' AND expires_at<=?
      ORDER BY expires_at,id LIMIT ?`).all(projectId, workflow, at, limit) as any[];
    return rows.map(this.mapApproval);
  }

  async resolveApproval(id: string, state: string, decision: string, resolvedBy: string): Promise<void> {
    await this.resolveApprovalTransaction({ approvalId: id, state, decision, resolvedBy });
  }

  async resolveApprovalTransaction(input: ApprovalResolutionInput): Promise<ApprovalResolutionResult> {
    return this.transaction(() => {
      let observedAt = observeStoreClock(this.clock);
      if (input.idempotency) {
        const record = this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key);
        if (record) {
          if (record.requestHash !== input.idempotency.requestHash) throw new IdempotencyConflictError();
          if (record.resourceType !== "approval" || record.resourceId !== input.approvalId) {
            throw new IdempotencyConflictError("Idempotency key refers to another approval or resource type");
          }
          const approval = this.getApprovalRow(input.approvalId);
          if (!approval) throw new StorageConflictError("Idempotency record refers to a missing approval");
          validateApprovalResolutionBinding(approval, input.expectedBinding, observedAt);
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
        observedAt = observeStoreClock(this.clock);
        validateApprovalResolutionBinding(current, input.expectedBinding, observedAt);
        const result = this.db.prepare(`UPDATE approvals
          SET state=?, decision=?, resolved_by=?, resolved_at=?
          WHERE id=? AND state='pending' AND (expires_at IS NULL OR expires_at>?)`)
          .run(input.state, input.decision, input.resolvedBy, input.resolvedAt ?? observedAt, input.approvalId, observedAt) as any;
        if (Number(result.changes) !== 1) throw new StorageConflictError("Approval has expired or resolution lost a concurrent race");
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

  async expireApprovalTransaction(input: ApprovalExpiryInput): Promise<ApprovalResolutionResult> {
    validateApprovalExpiryRunPatch(input.runPatch);
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const replayResult = (approval: Approval, run: Run): ApprovalResolutionResult => {
        if (approval.state !== "denied" || approval.decision !== "expired" || approval.resolvedBy !== "control-plane") {
          throw new StorageConflictError("Approval was resolved by a different decision");
        }
        if (input.event.runId !== approval.runId) {
          throw new StorageConflictError("Approval expiry event must belong to the approval run");
        }
        assertRunPatchApplied(run, input.runPatch);
        const eventRow = this.db.prepare("SELECT * FROM run_events WHERE id=?").get(input.event.id) as any;
        if (!eventRow) throw new StorageConflictError("Expired approval replay is missing its event");
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        return { approval, run, event, replayed: true };
      };

      if (input.idempotency) {
        const record = this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key);
        if (record) {
          if (record.requestHash !== input.idempotency.requestHash) throw new IdempotencyConflictError();
          if (record.resourceType !== "approval" || record.resourceId !== input.approvalId) {
            throw new IdempotencyConflictError("Idempotency key refers to another approval or resource type");
          }
          const approval = this.getApprovalRow(input.approvalId);
          if (!approval) throw new StorageConflictError("Idempotency record refers to a missing approval");
          validateApprovalExpiry(approval, observedAt);
          const run = this.getRunRow(approval.runId);
          if (!run) throw new StorageConflictError("Approval refers to a missing run");
          return replayResult(approval, run);
        }
      }

      const current = this.getApprovalRow(input.approvalId);
      if (!current) throw new StorageConflictError("Approval not found");
      validateApprovalExpiry(current, observedAt);
      if (input.event.runId !== current.runId) {
        throw new StorageConflictError("Approval expiry event must belong to the approval run");
      }

      if (current.state !== "pending") {
        const run = this.getRunRow(current.runId);
        if (!run) throw new StorageConflictError("Approval refers to a missing run");
        const result = replayResult(current, run);
        if (input.idempotency) {
          this.insertIdempotency(input.idempotency, "approval", input.approvalId, {
            approvalId: input.approvalId, runId: current.runId,
          });
        }
        return result;
      }

      const updated = this.db.prepare(`UPDATE approvals
        SET state='denied',decision='expired',resolved_by='control-plane',resolved_at=?
        WHERE id=? AND state='pending' AND expires_at<=?`).run(observedAt, input.approvalId, observedAt) as any;
      if (Number(updated.changes) !== 1) throw new StorageConflictError("Approval expiry lost a concurrent race");
      if (!this.updateRunRow(current.runId, input.runPatch)) {
        throw new StorageConflictError("Approval expiry could not apply its terminal run patch");
      }
      const event = this.insertEvent(input.event);
      this.insertOutbox("approval.resolved", input.approvalId, {
        approvalId: input.approvalId, runId: current.runId, state: "denied", decision: "expired",
      }, "expired");
      if (input.idempotency) {
        this.insertIdempotency(input.idempotency, "approval", input.approvalId, {
          approvalId: input.approvalId, runId: current.runId,
        });
      }
      return {
        approval: this.getApprovalRow(input.approvalId)!,
        run: this.getRunRow(current.runId)!,
        event,
        replayed: false,
      };
    });
  }

  async createInferenceCapability(capability: InferenceCapability): Promise<InferenceCapability> {
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      validateInferenceCapability(capability, observedAt);
      const existing = this.db.prepare("SELECT * FROM inference_capabilities WHERE id=? OR token_hash=?")
        .get(capability.id, capability.tokenHash) as any;
      if (existing) {
        const mapped = this.mapInferenceCapability(existing);
        if (canonicalJson(mapped) !== canonicalJson(capability)) {
          throw new StorageConflictError("Inference capability identity was already used with different content");
        }
        return mapped;
      }
      this.db.prepare(`INSERT INTO inference_capabilities
        (id,run_id,project_id,workflow,token_hash,provider,model,api,roles_json,max_requests,max_input_tokens,
         max_output_tokens,max_cost_micros,max_elapsed_ms,issued_at,expires_at,state,policy_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          capability.id, capability.runId, capability.projectId, capability.workflow, capability.tokenHash,
          capability.provider, capability.model, capability.api, JSON.stringify(capability.roles), capability.maxRequests,
          capability.maxInputTokens, capability.maxOutputTokens, capability.maxCostMicros, capability.maxElapsedMs,
          capability.issuedAt, capability.expiresAt, capability.state, capability.policyHash,
        );
      this.insertOutbox("inference.capability.created", capability.id, {
        capabilityId: capability.id, runId: capability.runId, provider: capability.provider,
        model: capability.model, policyHash: capability.policyHash,
      }, capability.policyHash);
      return capability;
    });
  }

  async getInferenceCapability(id: string): Promise<InferenceCapability | null> {
    const row = this.db.prepare("SELECT * FROM inference_capabilities WHERE id=?").get(id) as any;
    return row ? this.mapInferenceCapability(row) : null;
  }

  async getInferenceCapabilityByTokenHash(tokenHash: string): Promise<InferenceCapability | null> {
    const row = this.db.prepare("SELECT * FROM inference_capabilities WHERE token_hash=?").get(tokenHash) as any;
    return row ? this.mapInferenceCapability(row) : null;
  }

  async reserveInferenceRequest(input: ReserveInferenceRequestInput): Promise<{ capability: InferenceCapability; request: InferenceRequest; replayed: boolean }> {
    validateInferenceReservation(input);
    return this.transaction(() => {
      const observedAt = input.reservedAt ?? observeStoreClock(this.clock);
      const row = this.db.prepare("SELECT * FROM inference_capabilities WHERE token_hash=?").get(input.tokenHash) as any;
      if (!row) throw new StorageConflictError("Inference capability is not recognized");
      const capability = this.mapInferenceCapability(row);
      const existing = this.db.prepare("SELECT * FROM inference_requests WHERE id=? OR (capability_id=? AND role=? AND request_hash=?)")
        .get(input.id, capability.id, input.role, input.requestHash) as any;
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
      const activeRoleRequest = this.db.prepare(`SELECT id FROM inference_requests
        WHERE capability_id=? AND role=? AND state='reserved' LIMIT 1`).get(capability.id, input.role) as any;
      if (activeRoleRequest) {
        throw new StorageConflictError("Inference role already has an active request");
      }
      const count = Number((this.db.prepare("SELECT count(*) AS count FROM inference_requests WHERE capability_id=?")
        .get(capability.id) as any).count);
      if (count >= capability.maxRequests) throw new StorageConflictError("Inference request count budget is exhausted");
      const request: InferenceRequest = {
        id: input.id, capabilityId: capability.id, runId: input.runId, role: input.role,
        requestHash: input.requestHash, state: "reserved", providerRequestId: null, responseHash: null,
        inputTokens: 0, outputTokens: 0, costMicros: 0, reservedAt: observedAt, completedAt: null, failureCode: null,
        providerSessionId: null, providerSessionReused: false,
      };
      this.db.prepare(`INSERT INTO inference_requests
        (id,capability_id,run_id,role,request_hash,state,provider_request_id,response_hash,input_tokens,output_tokens,
         cost_micros,reserved_at,completed_at,failure_code,provider_session_id,provider_session_reused)
         VALUES (?,?,?,?,?,'reserved',NULL,NULL,0,0,0,?,NULL,NULL,NULL,0)`)
        .run(request.id, request.capabilityId, request.runId, request.role, request.requestHash, request.reservedAt);
      this.insertOutbox("inference.request.reserved", request.id, {
        requestId: request.id, capabilityId: capability.id, runId: request.runId, role: request.role,
      }, request.requestHash);
      return { capability, request, replayed: false };
    });
  }

  async completeInferenceRequest(input: CompleteInferenceRequestInput): Promise<{ capability: InferenceCapability; request: InferenceRequest; replayed: boolean }> {
    validateInferenceCompletion(input);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM inference_requests WHERE id=?").get(input.id) as any;
      if (!row) throw new StorageConflictError("Inference request was not reserved");
      const request = this.mapInferenceRequest(row);
      const capabilityRow = this.db.prepare("SELECT * FROM inference_capabilities WHERE id=?").get(request.capabilityId) as any;
      if (!capabilityRow) throw new StorageConflictError("Inference capability is missing");
      const capability = this.mapInferenceCapability(capabilityRow);
      const completedAt = input.completedAt ?? observeStoreClock(this.clock);
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
      const totals = this.db.prepare(`SELECT coalesce(sum(input_tokens),0) AS input_tokens,
        coalesce(sum(output_tokens),0) AS output_tokens,coalesce(sum(cost_micros),0) AS cost_micros
        FROM inference_requests WHERE capability_id=? AND state='completed'`).get(capability.id) as any;
      if (Number(totals.input_tokens) + input.inputTokens > capability.maxInputTokens
          || Number(totals.output_tokens) + input.outputTokens > capability.maxOutputTokens
          || Number(totals.cost_micros) + input.costMicros > capability.maxCostMicros) {
        throw new StorageConflictError("Inference completion exceeds its aggregate token or cost budget");
      }
      this.db.prepare(`UPDATE inference_requests SET state=?,provider_request_id=?,response_hash=?,input_tokens=?,
        output_tokens=?,cost_micros=?,completed_at=?,failure_code=?,provider_session_id=?,provider_session_reused=?
        WHERE id=? AND state='reserved'`).run(
          input.state, input.providerRequestId ?? null, input.responseHash ?? null, input.inputTokens,
          input.outputTokens, input.costMicros, completedAt, input.failureCode ?? null,
          input.providerSessionId ?? null, (input.providerSessionReused ?? false) ? 1 : 0, input.id,
        );
      const count = Number((this.db.prepare("SELECT count(*) AS count FROM inference_requests WHERE capability_id=?")
        .get(capability.id) as any).count);
      const costTotal = Number(totals.cost_micros) + input.costMicros;
      if (count >= capability.maxRequests || (capability.maxCostMicros > 0 && costTotal >= capability.maxCostMicros)) {
        this.db.prepare("UPDATE inference_capabilities SET state='exhausted' WHERE id=? AND state='active'").run(capability.id);
      }
      this.insertOutbox(`inference.request.${input.state}`, input.id, {
        requestId: input.id, capabilityId: capability.id, runId: request.runId, role: request.role,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens, costMicros: input.costMicros,
        providerSessionId: input.providerSessionId ?? null,
        providerSessionReused: input.providerSessionReused ?? false,
      }, input.responseHash ?? input.failureCode!);
      const finalRequest = this.mapInferenceRequest(this.db.prepare("SELECT * FROM inference_requests WHERE id=?").get(input.id) as any);
      const finalCapability = this.mapInferenceCapability(this.db.prepare("SELECT * FROM inference_capabilities WHERE id=?").get(capability.id) as any);
      return { capability: finalCapability, request: finalRequest, replayed: false };
    });
  }

  async revokeInferenceCapability(id: string, observedAt?: string): Promise<InferenceCapability | null> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM inference_capabilities WHERE id=?").get(id) as any;
      if (!row) return null;
      const current = this.mapInferenceCapability(row);
      const now = observedAt ?? observeStoreClock(this.clock);
      const nextState = current.state === "active" ? (current.expiresAt <= now ? "expired" : "revoked") : current.state;
      if (nextState !== current.state) {
        this.db.prepare("UPDATE inference_capabilities SET state=? WHERE id=? AND state='active'").run(nextState, id);
        this.insertOutbox("inference.capability.closed", id, { capabilityId: id, runId: current.runId, state: nextState }, nextState);
      }
      return this.mapInferenceCapability(this.db.prepare("SELECT * FROM inference_capabilities WHERE id=?").get(id) as any);
    });
  }

  async expireInferenceCapabilities(observedAt: string, limit = 100): Promise<InferenceCapability[]> {
    const at = isoString(observedAt);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Inference capability expiry limit must be between 1 and 1000");
    }
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM inference_capabilities
        WHERE state='active' AND expires_at<=? ORDER BY expires_at,id LIMIT ?`).all(at, limit) as any[];
      const expired: InferenceCapability[] = [];
      for (const row of rows) {
        const capability = this.mapInferenceCapability(row);
        const updated = this.db.prepare("UPDATE inference_capabilities SET state='expired' WHERE id=? AND state='active' AND expires_at<=?")
          .run(capability.id, at);
        if (updated.changes !== 1) continue;
        this.insertOutbox("inference.capability.closed", capability.id, {
          capabilityId: capability.id, runId: capability.runId, state: "expired",
        }, "expired");
        expired.push({ ...capability, state: "expired" });
      }
      return expired;
    });
  }

  async listInferenceRequests(runId: string): Promise<InferenceRequest[]> {
    return (this.db.prepare("SELECT * FROM inference_requests WHERE run_id=? ORDER BY reserved_at,id").all(runId) as any[])
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
    return this.transaction(() => {
      const existingLedger = effectiveIdempotency
        ? this.getIdempotencyRow(effectiveIdempotency.scope, effectiveIdempotency.key)
        : null;
      if (existingLedger) {
        if (existingLedger.requestHash !== effectiveIdempotency!.requestHash) throw new IdempotencyConflictError();
        if (existingLedger.resourceType !== "engineering-routing-assessment") {
          throw new IdempotencyConflictError("Idempotency key refers to another resource type");
        }
        const existing = this.db.prepare("SELECT * FROM engineering_routing_assessments WHERE id=?")
          .get(existingLedger.resourceId) as any;
        if (!existing) throw new StorageConflictError("Routing assessment idempotency record refers to a missing assessment");
        const mapped = this.mapEngineeringRoutingAssessment(existing);
        return { assessment: mapped, replayed: true };
      }

      validateEngineeringRoutingAssessment(assessment);

      const existing = this.db.prepare("SELECT * FROM engineering_routing_assessments WHERE id=?").get(assessment.id) as any;
      if (existing) {
        const mapped = this.mapEngineeringRoutingAssessment(existing);
        if (canonicalJson(mapped) !== canonicalJson(assessment)) {
          throw new StorageConflictError("Routing assessment ID was reused with different content");
        }
        if (effectiveIdempotency) {
          this.insertIdempotency(effectiveIdempotency, "engineering-routing-assessment", mapped.id, {
            assessmentId: mapped.id,
          });
        }
        return { assessment: mapped, replayed: true };
      }

      if (!this.getProjectRow(assessment.projectId)) {
        throw new StorageConflictError("Routing assessment project was not found");
      }
      if (assessment.taskId !== null) {
        const task = this.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(assessment.taskId) as any;
        if (!task) throw new StorageConflictError("Routing assessment task was not found");
        if (String(task.project_id) !== assessment.projectId) {
          throw new StorageConflictError("Routing assessment task belongs to another project");
        }
      }
      this.db.prepare(`INSERT INTO engineering_routing_assessments
        (id,project_id,task_id,literal_request,request_hash,context_digest,context_sources_json,dimensions_json,
         hard_signals_json,preference,final_action,baseline_shape,selected_shape,score,reasons_json,policy_version,
         execution_supported,unsupported_reasons_json,status,run_id,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        assessment.id, assessment.projectId, assessment.taskId, assessment.literalRequest, assessment.requestHash,
        assessment.contextDigest, JSON.stringify(assessment.contextSources), JSON.stringify(assessment.dimensions),
        JSON.stringify(assessment.hardSignals), assessment.preference, assessment.finalAction,
        assessment.baselineShape, assessment.selectedShape,
        assessment.score, JSON.stringify(assessment.reasons), assessment.policyVersion, assessment.executionSupported ? 1 : 0,
        JSON.stringify(assessment.unsupportedReasons), assessment.status, assessment.runId, assessment.createdAt, assessment.expiresAt,
      );
      this.insertOutbox("engineering.routing.assessment.created", assessment.id, {
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
        this.insertIdempotency(effectiveIdempotency, "engineering-routing-assessment", assessment.id, {
          assessmentId: assessment.id,
        });
      }
      return { assessment, replayed: false };
    });
  }

  async getEngineeringRoutingAssessment(id: string): Promise<EngineeringRoutingAssessmentRecord | null> {
    const row = this.db.prepare("SELECT * FROM engineering_routing_assessments WHERE id=?").get(id) as any;
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
    const rows = projectId
      ? this.db.prepare(`SELECT * FROM engineering_routing_assessments
        WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(projectId, limit)
      : this.db.prepare(`SELECT * FROM engineering_routing_assessments
        ORDER BY created_at DESC,id DESC LIMIT ?`).all(limit);
    return (rows as any[]).map(this.mapEngineeringRoutingAssessment);
  }

  async createComparison(comparison: ComparisonRecord): Promise<ComparisonRecord> {
    validateComparisonRecord(comparison);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM comparisons WHERE id=?").get(comparison.id) as any;
      if (existing) {
        const mapped = this.mapComparison(existing);
        if (canonicalJson(mapped) !== canonicalJson(comparison)) throw new StorageConflictError("Comparison ID was reused with different content");
        return mapped;
      }
      this.db.prepare(`INSERT INTO comparisons
        (id,project_id,task_id,objective,contract_hash,status,selection_policy,created_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        comparison.id, comparison.projectId, comparison.taskId, comparison.objective, comparison.contractHash,
        comparison.status, comparison.selectionPolicy, comparison.createdAt, comparison.completedAt,
      );
      this.insertOutbox("comparison.created", comparison.id, { comparisonId: comparison.id, projectId: comparison.projectId }, comparison.id);
      return comparison;
    });
  }

  async getComparison(id: string): Promise<ComparisonRecord | null> {
    const row = this.db.prepare("SELECT * FROM comparisons WHERE id=?").get(id) as any;
    return row ? this.mapComparison(row) : null;
  }

  async completeComparison(id: string, status: "complete" | "failed", completedAt: string): Promise<ComparisonRecord> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM comparisons WHERE id=?").get(id) as any;
      if (!row) throw new StorageConflictError("Comparison was not found");
      const current = this.mapComparison(row);
      if (current.status !== "running") {
        if (current.status !== status || current.completedAt !== completedAt) throw new StorageConflictError("Comparison terminal replay changed content");
        return current;
      }
      this.db.prepare("UPDATE comparisons SET status=?,completed_at=? WHERE id=? AND status='running'").run(status, completedAt, id);
      this.insertOutbox("comparison.completed", id, { comparisonId: id, status }, status);
      return { ...current, status, completedAt };
    });
  }

  async attachComparisonCandidate(candidate: ComparisonCandidate): Promise<ComparisonCandidate> {
    validateComparisonCandidate(candidate, false);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM comparison_candidates WHERE comparison_id=? AND run_id=?")
        .get(candidate.comparisonId, candidate.runId) as any;
      if (existing) {
        const mapped = this.mapComparisonCandidate(existing);
        if (canonicalJson(mapped) !== canonicalJson(candidate)) throw new StorageConflictError("Comparison candidate replay changed content");
        return mapped;
      }
      this.db.prepare(`INSERT INTO comparison_candidates
        (comparison_id,run_id,runtime,workflow,ordinal,status,metrics_json,evidence_digest,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        candidate.comparisonId, candidate.runId, candidate.runtime, candidate.workflow, candidate.ordinal,
        candidate.status, null, null, candidate.createdAt, candidate.updatedAt,
      );
      this.insertOutbox("comparison.candidate.attached", candidate.runId, { comparisonId: candidate.comparisonId, runId: candidate.runId }, candidate.comparisonId);
      return candidate;
    });
  }

  async finalizeComparisonCandidate(candidate: ComparisonCandidate): Promise<ComparisonCandidate> {
    validateComparisonCandidate(candidate, true);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM comparison_candidates WHERE comparison_id=? AND run_id=?")
        .get(candidate.comparisonId, candidate.runId) as any;
      if (!row) throw new StorageConflictError("Comparison candidate was not attached");
      const existing = this.mapComparisonCandidate(row);
      if (existing.status !== "running") {
        if (canonicalJson(existing) !== canonicalJson(candidate)) throw new StorageConflictError("Final comparison candidate replay changed content");
        return existing;
      }
      if (existing.runtime !== candidate.runtime || existing.workflow !== candidate.workflow || existing.ordinal !== candidate.ordinal
          || existing.createdAt !== candidate.createdAt) throw new StorageConflictError("Comparison candidate identity changed during finalization");
      this.db.prepare(`UPDATE comparison_candidates SET status=?,metrics_json=?,evidence_digest=?,updated_at=?
        WHERE comparison_id=? AND run_id=?`).run(
        candidate.status, canonicalJson(candidate.metrics), candidate.evidenceDigest, candidate.updatedAt,
        candidate.comparisonId, candidate.runId,
      );
      this.insertOutbox("comparison.candidate.finalized", candidate.runId, { comparisonId: candidate.comparisonId, runId: candidate.runId, status: candidate.status }, candidate.evidenceDigest!);
      return candidate;
    });
  }

  async listComparisonCandidates(comparisonId: string): Promise<ComparisonCandidate[]> {
    return (this.db.prepare("SELECT * FROM comparison_candidates WHERE comparison_id=? ORDER BY ordinal,run_id").all(comparisonId) as any[])
      .map(this.mapComparisonCandidate);
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

  async createArtifactBatch(artifacts: Artifact[]): Promise<ArtifactBatchResult> {
    const runId = validateArtifactBatchInput(artifacts);
    return this.transaction(() => {
      if (!this.getRunRow(runId)) throw new StorageConflictError("Artifact batch run not found");
      let inserted = 0;
      const persisted: Artifact[] = [];
      for (const artifact of artifacts) {
        const row = this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(artifact.id) as any;
        if (row) {
          const existing = this.mapArtifact(row);
          if (!artifactsEqual(existing, artifact)) {
            throw new StorageConflictError(`Artifact ${artifact.id} was already used with different content`);
          }
          persisted.push(existing);
        } else {
          this.db.prepare("INSERT INTO artifacts (id,run_id,kind,uri,checksum,media_type,created_at) VALUES (?,?,?,?,?,?,?)")
            .run(artifact.id, artifact.runId, artifact.kind, artifact.uri, artifact.checksum, artifact.mediaType, artifact.createdAt);
          persisted.push(artifact);
          inserted += 1;
        }
        this.insertOutbox("artifact.created", artifact.id, {
          artifactId: artifact.id, runId: artifact.runId, kind: artifact.kind, checksum: artifact.checksum,
        }, artifact.id);
      }
      return { artifacts: persisted, replayed: inserted === 0 };
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

  async createAuthorityBinding(binding: AuthorityBinding): Promise<AuthorityBinding> {
    validateAuthorityBinding(binding);
    return this.transaction(() => this.persistAuthorityBinding(binding, false));
  }

  async bindAuthority(binding: AuthorityBinding): Promise<AuthorityBinding> {
    return this.createAuthorityBinding(binding);
  }

  async getAuthorityBinding(provider: string, localKind: string, localId: string): Promise<AuthorityBinding | null> {
    validateAuthorityBinding({
      provider, localKind, localId, externalId: "placeholder", revision: "placeholder",
      observedAt: new Date(0).toISOString(), payloadHash: "0".repeat(64),
      freshUntil: new Date(1).toISOString(),
    });
    const row = this.db.prepare(`SELECT * FROM authority_bindings
      WHERE provider=? AND local_kind=? AND local_id=?`).get(provider, localKind, localId) as any;
    return row ? this.mapAuthorityBinding(row) : null;
  }

  async listAuthorityBindings(provider?: string, limit = 100): Promise<AuthorityBinding[]> {
    if (provider !== undefined) validateDeliveryIdentity(provider, "Authority provider", 128);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Authority binding list limit must be between 1 and 1000");
    }
    const rows = provider === undefined
      ? this.db.prepare(`SELECT * FROM authority_bindings
        ORDER BY observed_at DESC,provider,local_kind,local_id LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT * FROM authority_bindings WHERE provider=?
        ORDER BY observed_at DESC,local_kind,local_id LIMIT ?`).all(provider, limit);
    return (rows as any[]).map(this.mapAuthorityBinding);
  }

  async refreshAuthorityBinding(input: AuthorityBindingRefreshInput): Promise<AuthorityBinding> {
    validateAuthorityRefresh(input);
    return this.transaction(() => this.persistAuthorityBinding(input, true));
  }

  async claimOutboxDeliveries(input: OutboxDeliveryClaimInput): Promise<OutboxDelivery[]> {
    const observedAt = observeStoreClock(this.clock);
    validateOutboxDeliveryClaim(input, observedAt);
    const limit = input.limit ?? 100;
    return this.transaction(() => {
      const topicPlaceholders = input.topics.map(() => "?").join(",");
      const candidates = this.db.prepare(`SELECT oe.* FROM outbox_events oe
        LEFT JOIN outbox_deliveries d
          ON d.outbox_id=oe.id AND d.consumer_id=?
        WHERE oe.published_at IS NULL AND oe.available_at<=?
          AND oe.topic IN (${topicPlaceholders})
          AND (
            d.outbox_id IS NULL
            OR (d.state='pending' AND d.next_attempt_at<=?)
            OR (d.state='claimed' AND d.claim_expires_at<=?)
          )
        ORDER BY oe.created_at,oe.id LIMIT ?`).all(
        input.consumerId, observedAt, ...input.topics, observedAt, observedAt, limit,
      ) as any[];
      const claimed: OutboxDelivery[] = [];
      for (const event of candidates) {
        const existing = this.db.prepare(`SELECT * FROM outbox_deliveries
          WHERE outbox_id=? AND consumer_id=?`).get(event.id, input.consumerId) as any;
        let attempts = existing ? Number(existing.attempts) : 0;
        let history = existing ? this.deliveryHistory(existing.attempt_history_json) : [];
        if (existing?.state === "claimed" && existing.claim_expires_at <= observedAt) {
          history = this.appendDeliveryHistory(history, {
            kind: "claim_expired", attempt: attempts, observedAt,
          });
        }
        if (attempts >= MAX_OUTBOX_DELIVERY_ATTEMPTS) {
          if (existing && existing.state !== "dead") {
            this.db.prepare(`UPDATE outbox_deliveries SET state='dead',claim_owner_id=NULL,
              claim_token=NULL,claim_expires_at=NULL,next_attempt_at=NULL,attempt_history_json=?
              WHERE outbox_id=? AND consumer_id=?`).run(
              JSON.stringify(history), event.id, input.consumerId,
            );
          }
          continue;
        }
        const token = randomBytes(32).toString("hex");
        attempts += 1;
        if (!existing) {
          this.db.prepare(`INSERT INTO outbox_deliveries
            (outbox_id,consumer_id,state,claim_owner_id,claim_token,claim_expires_at,attempts,
             next_attempt_at,delivered_at,last_error_code,last_error_fingerprint,attempt_history_json)
            VALUES (?,?, 'claimed', ?,?,?,?,NULL,NULL,NULL,NULL,?)`).run(
            event.id, input.consumerId, input.ownerId, token, input.claimUntil, attempts, JSON.stringify(history),
          );
        } else {
          this.db.prepare(`UPDATE outbox_deliveries SET state='claimed',claim_owner_id=?,claim_token=?,
            claim_expires_at=?,attempts=?,next_attempt_at=NULL,attempt_history_json=?
            WHERE outbox_id=? AND consumer_id=?`).run(
            input.ownerId, token, input.claimUntil, attempts, JSON.stringify(history), event.id, input.consumerId,
          );
        }
        const row = this.getOutboxDeliveryRow(event.id, input.consumerId);
        if (row) claimed.push(this.mapOutboxDelivery(row));
      }
      return claimed;
    });
  }

  async getOutboxDelivery(outboxId: string, consumerId: string): Promise<OutboxDelivery | null> {
    validateDeliveryIdentity(outboxId, "Outbox ID", 256);
    validateDeliveryIdentity(consumerId, "Outbox consumer ID", 128);
    const row = this.getOutboxDeliveryRow(outboxId, consumerId);
    return row ? this.mapOutboxDelivery(row) : null;
  }

  async listOutboxDeliveries(consumerId?: string, state?: OutboxDeliveryState, limit = 100): Promise<OutboxDelivery[]> {
    if (consumerId !== undefined) validateDeliveryIdentity(consumerId, "Outbox consumer ID", 128);
    if (state !== undefined && !["pending", "claimed", "delivered", "dead"].includes(state)) {
      throw new StorageConflictError("Outbox delivery state is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageConflictError("Outbox delivery list limit must be between 1 and 1000");
    }
    const conditions: string[] = [];
    const params: any[] = [];
    if (consumerId !== undefined) { conditions.push("d.consumer_id=?"); params.push(consumerId); }
    if (state !== undefined) { conditions.push("d.state=?"); params.push(state); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT d.*,oe.id AS event_id,oe.topic,oe.aggregate_id,
      oe.payload_json,oe.created_at AS event_created_at,oe.available_at,oe.published_at,
      oe.attempts AS event_attempts,oe.last_error AS event_last_error
      FROM outbox_deliveries d JOIN outbox_events oe ON oe.id=d.outbox_id
      ${where} ORDER BY oe.created_at,d.outbox_id,d.consumer_id LIMIT ?`).all(...params, limit) as any[];
    return rows.map(this.mapOutboxDelivery);
  }

  async ackOutboxDelivery(input: OutboxDeliveryAckInput): Promise<OutboxDelivery> {
    validateOutboxDeliveryFence(input);
    if (input.providerReceipt) validateProviderReceipt(input.providerReceipt);
    if (input.authorityBinding) validateAuthorityBinding(input.authorityBinding);
    const observedAt = observeStoreClock(this.clock);
    return this.transaction(() => {
      const row = this.getOutboxDeliveryRow(input.outboxId, input.consumerId);
      if (!row) throw new StorageConflictError("Outbox delivery was not found");
      this.assertActiveDeliveryFence(row, input, observedAt);
      if (input.authorityBinding && !input.providerReceipt) {
        throw new StorageConflictError("An authority binding requires a matching provider receipt");
      }
      if (input.providerReceipt && input.authorityBinding) {
        this.assertReceiptMatchesAuthority(input.providerReceipt, input.authorityBinding);
        if ("expectedExternalId" in input.authorityBinding) {
          this.persistAuthorityBinding(input.authorityBinding as AuthorityBindingRefreshInput, true);
        } else {
          this.persistAuthorityBinding(input.authorityBinding as AuthorityBinding, false);
        }
      }
      const receipt = input.providerReceipt;
      const result = this.db.prepare(`UPDATE outbox_deliveries SET state='delivered',delivered_at=?,
        claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,next_attempt_at=NULL,
        last_error_code=NULL,last_error_fingerprint=?,receipt_external_id=?,receipt_external_revision=?,
        receipt_payload_hash=?,receipt_observed_at=?
        WHERE outbox_id=? AND consumer_id=? AND state='claimed' AND claim_owner_id=? AND claim_token=?
        AND claim_expires_at>?`).run(
        observedAt, null,
        receipt?.externalId ?? null, receipt?.externalRevision ?? null, receipt?.payloadHash ?? null, receipt?.observedAt ?? null,
        input.outboxId, input.consumerId, input.ownerId, input.claimToken, observedAt,
      ) as any;
      if (Number(result.changes) !== 1) throw new StorageConflictError("Outbox delivery claim was lost before acknowledgement");
      const updated = this.getOutboxDeliveryRow(input.outboxId, input.consumerId);
      if (!updated) throw new StorageConflictError("Outbox delivery disappeared during acknowledgement");
      return this.mapOutboxDelivery(updated);
    });
  }

  async failOutboxDelivery(input: OutboxDeliveryFailureInput): Promise<OutboxDelivery> {
    const observedAt = observeStoreClock(this.clock);
    validateOutboxDeliveryFailure(input, observedAt);
    return this.transaction(() => {
      const row = this.getOutboxDeliveryRow(input.outboxId, input.consumerId);
      if (!row) throw new StorageConflictError("Outbox delivery was not found");
      this.assertActiveDeliveryFence(row, input, observedAt);
      const attempts = Number(row.attempts);
      const history = this.appendDeliveryHistory(this.deliveryHistory(row.attempt_history_json), {
        kind: "failure", attempt: attempts, observedAt,
        errorCode: input.errorCode, errorFingerprint: input.errorFingerprint,
      });
      const dead = attempts >= MAX_OUTBOX_DELIVERY_ATTEMPTS;
      const result = this.db.prepare(`UPDATE outbox_deliveries SET state=?,claim_owner_id=NULL,claim_token=NULL,
        claim_expires_at=NULL,next_attempt_at=?,last_error_code=?,last_error_fingerprint=?,attempt_history_json=?
        WHERE outbox_id=? AND consumer_id=? AND state='claimed' AND claim_owner_id=? AND claim_token=?
          AND claim_expires_at>?`).run(
        dead ? "dead" : "pending", dead ? null : (input.nextAttemptAt ?? observedAt),
        input.errorCode, input.errorFingerprint, JSON.stringify(history),
        input.outboxId, input.consumerId, input.ownerId, input.claimToken, observedAt,
      ) as any;
      if (Number(result.changes) !== 1) throw new StorageConflictError("Outbox delivery claim was lost before failure acknowledgement");
      const updated = this.getOutboxDeliveryRow(input.outboxId, input.consumerId);
      if (!updated) throw new StorageConflictError("Outbox delivery disappeared during failure acknowledgement");
      return this.mapOutboxDelivery(updated);
    });
  }

  async replayOutboxDelivery(input: OutboxDeliveryReplayInput): Promise<OutboxDelivery> {
    const observedAt = observeStoreClock(this.clock);
    validateOutboxDeliveryReplay(input, observedAt);
    return this.transaction(() => {
      const row = this.getOutboxDeliveryRow(input.outboxId, input.consumerId);
      if (!row) throw new StorageConflictError("Outbox delivery was not found");
      if (row.state !== "dead") throw new StorageConflictError("Only a dead-letter delivery can be replayed explicitly");
      const history = this.appendDeliveryHistory(this.deliveryHistory(row.attempt_history_json), {
        kind: "replay", attempt: Number(row.attempts), observedAt, operatorId: input.operatorId,
      });
      this.db.prepare(`UPDATE outbox_deliveries SET state='pending',claim_owner_id=NULL,claim_token=NULL,
        claim_expires_at=NULL,attempts=0,next_attempt_at=?,delivered_at=NULL,attempt_history_json=?
        WHERE outbox_id=? AND consumer_id=? AND state='dead'`).run(
        input.nextAttemptAt ?? observedAt, JSON.stringify(history), input.outboxId, input.consumerId,
      );
      const updated = this.getOutboxDeliveryRow(input.outboxId, input.consumerId);
      if (!updated) throw new StorageConflictError("Outbox delivery disappeared during replay");
      return this.mapOutboxDelivery(updated);
    });
  }

  pruneOutboxDeliveries(input: OutboxDeliveryPruneInput): Promise<number>;
  pruneOutboxDeliveries(before: string, limit?: number): Promise<number>;
  async pruneOutboxDeliveries(inputOrBefore: OutboxDeliveryPruneInput | string, positionalLimit?: number): Promise<number> {
    const input = typeof inputOrBefore === "string"
      ? { before: inputOrBefore, limit: positionalLimit }
      : inputOrBefore;
    validateOutboxDeliveryPrune(input);
    const observedAt = observeStoreClock(this.clock);
    if (Date.parse(input.before) > Date.parse(observedAt)) {
      throw new StorageConflictError("Outbox delivery prune cutoff cannot be in the future");
    }
    const limit = input.limit ?? 100;
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT outbox_id,consumer_id FROM outbox_deliveries
        WHERE state='delivered' AND delivered_at<? ORDER BY delivered_at,outbox_id,consumer_id LIMIT ?`)
        .all(input.before, limit) as any[];
      const stmt = this.db.prepare("DELETE FROM outbox_deliveries WHERE outbox_id=? AND consumer_id=? AND state='delivered'");
      let deleted = 0;
      for (const row of rows) deleted += Number(stmt.run(row.outbox_id, row.consumer_id).changes);
      return deleted;
    });
  }

  async requestExternalActionPlan(input: ExternalActionPlanRequestInput): Promise<ExternalActionPlanRequestResult> {
    if (input.event.runId !== input.plan.runId) {
      throw new StorageConflictError("External action request event must belong to the plan run");
    }
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const existingIdempotency = input.idempotency
        ? this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key)
        : null;
      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== input.idempotency!.requestHash) throw new IdempotencyConflictError();
        if (existingIdempotency.resourceType !== "external-action-plan"
            || existingIdempotency.resourceId !== input.plan.id) {
          throw new IdempotencyConflictError("Idempotency key refers to another external action plan");
        }
        const stored = this.getExternalActionPlanSync(input.plan.id);
        if (!stored) throw new StorageConflictError("External action idempotency record refers to a missing plan");
        this.assertExternalActionPlanCompatible(stored, input.plan);
        const approval = this.getApprovalRow(stored.approvalId);
        if (!approval) throw new StorageConflictError("External action plan approval is missing");
        this.assertApprovalRequestCompatible(approval, input.approval, true);
        const eventId = String(existingIdempotency.response.eventId ?? input.event.id);
        const eventRow = this.db.prepare("SELECT * FROM run_events WHERE id=?").get(eventId) as any;
        if (!eventRow) throw new StorageConflictError("External action request replay event is missing");
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        const run = this.getRunRow(stored.runId);
        if (!run) throw new StorageConflictError("External action plan run is missing");
        return { plan: stored, approval, event, replayed: true };
      }

      const existingRow = this.getExternalActionPlanRow(input.plan.id);
      if (existingRow) {
        const stored = this.mapExternalActionPlan(existingRow);
        this.assertExternalActionPlanCompatible(stored, input.plan);
        const approval = this.getApprovalRow(stored.approvalId);
        const eventRow = this.db.prepare("SELECT * FROM run_events WHERE id=?").get(input.event.id) as any;
        if (!approval || !eventRow) throw new StorageConflictError("External action request replay is incomplete");
        this.assertApprovalRequestCompatible(approval, input.approval, true);
        const event = this.mapEvent(eventRow);
        this.assertEventCompatible(event, input.event);
        if (input.idempotency) {
          this.insertIdempotency(input.idempotency, "external-action-plan", stored.id, {
            planId: stored.id, approvalId: stored.approvalId, eventId: event.id,
          });
        }
        const run = this.getRunRow(stored.runId);
        if (!run) throw new StorageConflictError("External action plan run is missing");
        return { plan: stored, approval, event, replayed: true };
      }

      const run = this.getRunRow(input.plan.runId);
      if (!run) throw new StorageConflictError("External action plan run not found");
      validateExternalActionPlanRequest(input.plan, input.approval, run, observedAt);
      if (this.getApprovalRow(input.approval.id)) {
        throw new StorageConflictError("External action approval ID is already used");
      }
      this.insertApproval(input.approval);
      this.db.prepare(`INSERT INTO external_action_plans
        (id,run_id,project_id,workflow,kind,provider,marker,target_json,spec_json,request_hash,
         evidence_digest,policy_hash,approval_id,approval_action,exact_effect,expires_at,state,attempts,
         provider_receipt_json,result_json,last_error_code,last_error_fingerprint,reconciliation_json,
         authorized_outbox_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,NULL,NULL,?,?)`).run(
        input.plan.id, input.plan.runId, input.plan.projectId, input.plan.workflow, input.plan.kind,
        input.plan.provider, input.plan.marker, canonicalJson(input.plan.target), canonicalJson(input.plan.spec),
        input.plan.requestHash, input.plan.evidenceDigest, input.plan.policyHash, input.plan.approvalId,
        input.plan.approvalAction, input.plan.exactEffect, input.plan.expiresAt, "pending_approval",
        input.plan.createdAt, observedAt,
      );
      this.insertOutbox("approval.requested", input.approval.id, {
        approvalId: input.approval.id, runId: input.approval.runId, action: input.approval.action,
      }, input.approval.id);
      this.insertOutbox("external.action.requested", input.plan.id, {
        planId: input.plan.id, runId: input.plan.runId, projectId: input.plan.projectId,
        provider: input.plan.provider, kind: input.plan.kind, marker: input.plan.marker,
        approvalId: input.plan.approvalId,
      }, input.plan.id);
      const event = this.insertEvent(input.event);
      if (input.idempotency) {
        this.insertIdempotency(input.idempotency, "external-action-plan", input.plan.id, {
          planId: input.plan.id, approvalId: input.plan.approvalId, eventId: event.id,
        });
      }
      const plan = this.getExternalActionPlanSync(input.plan.id);
      const approval = this.getApprovalRow(input.approval.id);
      if (!plan || !approval) throw new StorageConflictError("External action plan could not be persisted");
      return { plan, approval, event, replayed: false };
    });
  }

  async getExternalActionPlan(id: string): Promise<ExternalActionPlan | null> {
    validateDeliveryIdentity(id, "External action plan ID", 128);
    const row = this.getExternalActionPlanRow(id);
    return row ? this.mapExternalActionPlan(row) : null;
  }

  async listExternalActionPlans(input: ExternalActionPlanListInput = {}): Promise<ExternalActionPlan[]> {
    if (input.projectId !== undefined) validateDeliveryIdentity(input.projectId, "External action project ID", 128);
    if (input.state !== undefined && !["pending_approval", "authorized", "executing", "ambiguous", "succeeded", "denied", "expired", "failed", "quarantined"].includes(input.state)) {
      throw new StorageConflictError("External action plan state is invalid");
    }
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new StorageConflictError("External action plan list limit must be between 1 and 1000");
    const conditions: string[] = [];
    const params: any[] = [];
    if (input.projectId !== undefined) { conditions.push("project_id=?"); params.push(input.projectId); }
    if (input.state !== undefined) { conditions.push("state=?"); params.push(input.state); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM external_action_plans ${where} ORDER BY created_at DESC,id LIMIT ?`).all(...params, limit) as any[])
      .map(this.mapExternalActionPlan);
  }

  async resolveExternalActionPlanApproval(input: ExternalActionApprovalInput): Promise<ExternalActionApprovalResult> {
    validateDeliveryIdentity(input.planId, "External action plan ID", 128);
    validateDeliveryIdentity(input.resolvedBy, "External action approval resolver ID", 256);
    if (!["approved", "denied", "changes_requested"].includes(input.state)) throw new StorageConflictError("External action approval state is invalid");
    if (!input.decision.trim() || input.decision.length > 2_048) throw new StorageConflictError("External action approval decision is invalid");
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const existingIdempotency = input.idempotency
        ? this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key)
        : null;
      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== input.idempotency!.requestHash) throw new IdempotencyConflictError();
        if (existingIdempotency.resourceType !== "external-action-plan" || existingIdempotency.resourceId !== input.planId) throw new IdempotencyConflictError("Idempotency key refers to another external action plan");
        const plan = this.getExternalActionPlanSync(input.planId);
        if (!plan) throw new StorageConflictError("External action plan is missing");
        const approval = this.getApprovalRow(plan.approvalId);
        if (!approval) throw new StorageConflictError("External action approval is missing");
        validateApprovalResolutionBinding(approval, input.expectedBinding, observedAt);
        if (approval.state !== input.state || approval.decision !== input.decision) throw new StorageConflictError("External action approval replay differs from the stored decision");
        const eventId = existingIdempotency.response.eventId;
        const eventRow = input.event ? this.db.prepare("SELECT * FROM run_events WHERE id=?").get(input.event.id) as any : (eventId ? this.db.prepare("SELECT * FROM run_events WHERE id=?").get(String(eventId)) as any : null);
        if (input.event && eventRow) this.assertEventCompatible(this.mapEvent(eventRow), input.event);
        return { plan, approval, event: eventRow ? this.mapEvent(eventRow) : undefined, replayed: true };
      }
      const row = this.getExternalActionPlanRow(input.planId);
      if (!row) throw new StorageConflictError("External action plan not found");
      const currentPlan = this.mapExternalActionPlan(row);
      const approval = this.getApprovalRow(currentPlan.approvalId);
      if (!approval) throw new StorageConflictError("External action approval not found");
      const run = this.getRunRow(currentPlan.runId);
      if (!run || run.status !== "completed") throw new StorageConflictError("External action evidence run is not terminal-complete");
      if (input.event && input.event.runId !== currentPlan.runId) throw new StorageConflictError("External action approval event must belong to the evidence run");
      validateApprovalResolutionBinding(approval, input.expectedBinding, observedAt);
      const nextPlanState = input.state === "approved" ? "authorized" : "denied";
      let replayed = false;
      if (approval.state !== "pending") {
        if (approval.state !== input.state || approval.decision !== input.decision || !["authorized", "denied"].includes(currentPlan.state)) {
          throw new StorageConflictError("External action approval has already been resolved differently");
        }
        if ((input.state === "approved" && currentPlan.state !== "authorized") || (input.state !== "approved" && currentPlan.state !== "denied")) throw new StorageConflictError("External action plan state disagrees with its approval");
        replayed = true;
      } else {
        if (currentPlan.state !== "pending_approval") throw new StorageConflictError("External action plan is not awaiting approval");
        const updatedApproval = this.db.prepare(`UPDATE approvals SET state=?,decision=?,resolved_by=?,resolved_at=? WHERE id=? AND state='pending' AND expires_at>?`).run(
          input.state, input.decision, input.resolvedBy, observedAt, approval.id, observedAt,
        ) as any;
        if (Number(updatedApproval.changes) !== 1) throw new StorageConflictError("External action approval expired or lost a concurrent resolution");
        this.insertOutbox("approval.resolved", approval.id, {
          approvalId: approval.id, runId: approval.runId, state: input.state, decision: input.decision,
        }, `${approval.id}:${input.state}`);
        if (input.state === "approved") {
          this.insertOutbox("external.action.authorized", currentPlan.id, {
            planId: currentPlan.id, projectId: currentPlan.projectId, provider: currentPlan.provider,
            kind: currentPlan.kind, marker: currentPlan.marker,
          }, "authorized");
        } else {
          this.insertOutbox("external.action.denied", currentPlan.id, {
            planId: currentPlan.id, projectId: currentPlan.projectId, provider: currentPlan.provider,
            kind: currentPlan.kind, marker: currentPlan.marker, decision: input.decision,
          }, input.state);
        }
        this.db.prepare(`UPDATE external_action_plans SET state=?,authorized_outbox_id=?,updated_at=? WHERE id=? AND state='pending_approval'`).run(
          nextPlanState, input.state === "approved" ? externalActionAuthorizedOutboxId(currentPlan.id) : null, observedAt, currentPlan.id,
        );
      }
      const event = !replayed && input.event ? this.insertEvent(input.event) : undefined;
      if (input.idempotency) this.insertIdempotency(input.idempotency, "external-action-plan", currentPlan.id, {
        planId: currentPlan.id, approvalId: approval.id, eventId: event?.id ?? null,
      });
      const plan = this.getExternalActionPlanSync(currentPlan.id);
      const resolved = this.getApprovalRow(approval.id);
      if (!plan || !resolved) throw new StorageConflictError("External action approval resolution disappeared");
      return { plan, approval: resolved, event, replayed };
    });
  }

  async expireExternalActionPlanApproval(input: ExternalActionPlanExpiryInput): Promise<ExternalActionApprovalResult> {
    validateDeliveryIdentity(input.planId, "External action plan ID", 128);
    validateDeliveryIdentity(input.event.runId, "External action expiry event run ID", 128);
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const existingIdempotency = input.idempotency ? this.getIdempotencyRow(input.idempotency.scope, input.idempotency.key) : null;
      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== input.idempotency!.requestHash) throw new IdempotencyConflictError();
        if (existingIdempotency.resourceType !== "external-action-plan" || existingIdempotency.resourceId !== input.planId) throw new IdempotencyConflictError("Idempotency key refers to another external action plan");
        const plan = this.getExternalActionPlanSync(input.planId);
        if (!plan) throw new StorageConflictError("External action plan is missing");
        const approval = this.getApprovalRow(plan.approvalId);
        if (!approval) throw new StorageConflictError("External action approval is missing");
        const eventRow = existingIdempotency.response.eventId ? this.db.prepare("SELECT * FROM run_events WHERE id=?").get(String(existingIdempotency.response.eventId)) as any : null;
        return { plan, approval, event: eventRow ? this.mapEvent(eventRow) : undefined, replayed: true };
      }
      const row = this.getExternalActionPlanRow(input.planId);
      if (!row) throw new StorageConflictError("External action plan not found");
      const plan = this.mapExternalActionPlan(row);
      const approval = this.getApprovalRow(plan.approvalId);
      if (!approval) throw new StorageConflictError("External action approval not found");
      const run = this.getRunRow(plan.runId);
      if (!run || input.event.runId !== plan.runId) throw new StorageConflictError("External action expiry event must belong to the evidence run");
      if (approval.state !== "pending") {
        if (approval.decision !== "expired" || plan.state !== "expired") throw new StorageConflictError("External action approval has already been resolved differently");
        return { plan, approval, replayed: true };
      }
      validateApprovalExpiry(approval, observedAt);
      if (plan.state !== "pending_approval") throw new StorageConflictError("External action plan is not awaiting expiry");
      const updatedApproval = this.db.prepare(`UPDATE approvals SET state='denied',decision='expired',resolved_by='store-expiry',resolved_at=? WHERE id=? AND state='pending' AND expires_at<=?`).run(observedAt, approval.id, observedAt) as any;
      if (Number(updatedApproval.changes) !== 1) throw new StorageConflictError("External action approval expiry lost a concurrent resolution");
      this.db.prepare("UPDATE external_action_plans SET state='expired',updated_at=? WHERE id=? AND state='pending_approval'").run(observedAt, plan.id);
      this.insertOutbox("approval.resolved", approval.id, { approvalId: approval.id, runId: approval.runId, state: "denied", decision: "expired" }, "expired");
      this.insertOutbox("external.action.expired", plan.id, { planId: plan.id, projectId: plan.projectId, provider: plan.provider, kind: plan.kind, marker: plan.marker }, "expired");
      const event = this.insertEvent(input.event);
      if (input.idempotency) this.insertIdempotency(input.idempotency, "external-action-plan", plan.id, { planId: plan.id, approvalId: approval.id, eventId: event.id });
      const updatedPlan = this.getExternalActionPlanSync(plan.id);
      const resolvedApproval = this.getApprovalRow(approval.id);
      if (!updatedPlan || !resolvedApproval) throw new StorageConflictError("External action expiry disappeared");
      return { plan: updatedPlan, approval: resolvedApproval, event, replayed: false };
    });
  }

  async beginExternalActionAttempt(input: BeginExternalActionAttemptInput): Promise<ExternalActionPlan> {
    validateDeliveryIdentity(input.planId, "External action plan ID", 128);
    validateExternalActionDeliveryFence(input.delivery);
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const row = this.getExternalActionPlanRow(input.planId);
      if (!row) throw new StorageConflictError("External action plan not found");
      const plan = this.mapExternalActionPlan(row);
      if (plan.authorizedOutboxId === null || plan.authorizedOutboxId !== input.delivery.outboxId) throw new StorageConflictError("External action delivery is not the authorized outbox event");
      const delivery = this.getOutboxDeliveryRow(input.delivery.outboxId, input.delivery.consumerId);
      if (!delivery) throw new StorageConflictError("External action authorized delivery is missing");
      this.assertExternalAuthorizedDelivery(plan, delivery, input.delivery, observedAt);
      if (plan.state === "executing") return plan;
      if (!["authorized", "failed"].includes(plan.state)) throw new StorageConflictError("External action plan is not authorized for execution");
      if (plan.attempts >= MAX_OUTBOX_DELIVERY_ATTEMPTS) throw new StorageConflictError("External action attempt bound was exhausted");
      const attempts = plan.attempts + 1;
      const result = this.db.prepare(`UPDATE external_action_plans SET state='executing',attempts=?,last_error_code=NULL,last_error_fingerprint=NULL,updated_at=? WHERE id=? AND state IN ('authorized','failed')`).run(attempts, observedAt, plan.id) as any;
      if (Number(result.changes) !== 1) throw new StorageConflictError("External action plan lost a concurrent begin race");
      return this.getExternalActionPlanSync(plan.id)!;
    });
  }

  async completeExternalActionAttempt(input: CompleteExternalActionAttemptInput): Promise<ExternalActionPlan> {
    validateDeliveryIdentity(input.planId, "External action plan ID", 128);
    validateExternalActionDeliveryFence(input.delivery);
    if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) throw new StorageConflictError("External action result must be an object");
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const row = this.getExternalActionPlanRow(input.planId);
      if (!row) throw new StorageConflictError("External action plan not found");
      const plan = this.mapExternalActionPlan(row);
      validateExternalActionReceipt(input.providerReceipt, plan);
      validateExternalActionPlan({ ...plan, result: input.result, providerReceipt: input.providerReceipt, updatedAt: observedAt });
      if (plan.state === "succeeded") {
        if (canonicalJson(plan.providerReceipt) !== canonicalJson(input.providerReceipt) || canonicalJson(plan.result) !== canonicalJson(input.result)) throw new StorageConflictError("External action success replay differs from the stored receipt");
        return plan;
      }
      if (plan.state !== "executing") throw new StorageConflictError("External action plan is not executing");
      if (plan.authorizedOutboxId !== input.delivery.outboxId) throw new StorageConflictError("External action completion is not for the authorized outbox event");
      const delivery = this.getOutboxDeliveryRow(input.delivery.outboxId, input.delivery.consumerId);
      if (!delivery) throw new StorageConflictError("External action delivery is missing");
      this.assertExternalAuthorizedDelivery(plan, delivery, input.delivery, observedAt);
      const updatedDelivery = this.db.prepare(`UPDATE outbox_deliveries SET state='delivered',delivered_at=?,claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,next_attempt_at=NULL,last_error_code=NULL,last_error_fingerprint=NULL,receipt_external_id=?,receipt_external_revision=?,receipt_payload_hash=?,receipt_observed_at=? WHERE outbox_id=? AND consumer_id=? AND state='claimed' AND claim_owner_id=? AND claim_token=? AND claim_expires_at>?`).run(
        observedAt, input.providerReceipt.externalId, input.providerReceipt.externalRevision, input.providerReceipt.payloadHash, input.providerReceipt.observedAt,
        input.delivery.outboxId, input.delivery.consumerId, input.delivery.ownerId, input.delivery.claimToken, observedAt,
      ) as any;
      if (Number(updatedDelivery.changes) !== 1) throw new StorageConflictError("External action delivery fence was lost before success");
      const updatedPlan = this.db.prepare(`UPDATE external_action_plans SET state='succeeded',provider_receipt_json=?,result_json=?,last_error_code=NULL,last_error_fingerprint=NULL,updated_at=? WHERE id=? AND state='executing'`).run(
        canonicalJson(input.providerReceipt), canonicalJson(input.result), observedAt, plan.id,
      ) as any;
      if (Number(updatedPlan.changes) !== 1) throw new StorageConflictError("External action plan success transition was lost");
      this.insertOutbox("external.action.succeeded", plan.id, { planId: plan.id, projectId: plan.projectId, provider: plan.provider, kind: plan.kind, marker: plan.marker }, "succeeded");
      return this.getExternalActionPlanSync(plan.id)!;
    });
  }

  async failExternalActionAttempt(input: FailExternalActionAttemptInput): Promise<ExternalActionPlan> {
    validateDeliveryIdentity(input.planId, "External action plan ID", 128);
    const observedAt = observeStoreClock(this.clock);
    validateExternalActionError(input, observedAt);
    return this.transaction(() => {
      const row = this.getExternalActionPlanRow(input.planId);
      if (!row) throw new StorageConflictError("External action plan not found");
      const plan = this.mapExternalActionPlan(row);
      if (plan.state !== "executing") throw new StorageConflictError("External action plan is not executing");
      if (plan.authorizedOutboxId !== input.delivery.outboxId) throw new StorageConflictError("External action failure is not for the authorized outbox event");
      const delivery = this.getOutboxDeliveryRow(input.delivery.outboxId, input.delivery.consumerId);
      if (!delivery) throw new StorageConflictError("External action delivery is missing");
      this.assertExternalAuthorizedDelivery(plan, delivery, input.delivery, observedAt);
      const attempts = Number(delivery.attempts);
      const history = this.appendDeliveryHistory(this.deliveryHistory(delivery.attempt_history_json), { kind: "failure", attempt: attempts, observedAt, errorCode: input.errorCode, errorFingerprint: input.errorFingerprint });
      const dead = Boolean(input.ambiguous) || attempts >= MAX_OUTBOX_DELIVERY_ATTEMPTS;
      const deliveryResult = this.db.prepare(`UPDATE outbox_deliveries SET state=?,claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,next_attempt_at=?,last_error_code=?,last_error_fingerprint=?,attempt_history_json=? WHERE outbox_id=? AND consumer_id=? AND state='claimed' AND claim_owner_id=? AND claim_token=? AND claim_expires_at>?`).run(
        dead ? "dead" : "pending", dead ? null : (input.nextAttemptAt ?? observedAt), input.errorCode, input.errorFingerprint, JSON.stringify(history),
        input.delivery.outboxId, input.delivery.consumerId, input.delivery.ownerId, input.delivery.claimToken, observedAt,
      ) as any;
      if (Number(deliveryResult.changes) !== 1) throw new StorageConflictError("External action delivery fence was lost before failure");
      const nextState = input.ambiguous ? "ambiguous" : "failed";
      const planResult = this.db.prepare("UPDATE external_action_plans SET state=?,last_error_code=?,last_error_fingerprint=?,updated_at=? WHERE id=? AND state='executing'").run(nextState, input.errorCode, input.errorFingerprint, observedAt, plan.id) as any;
      if (Number(planResult.changes) !== 1) throw new StorageConflictError("External action failure transition was lost");
      this.insertOutbox(input.ambiguous ? "external.action.ambiguous" : "external.action.failed", plan.id, { planId: plan.id, projectId: plan.projectId, provider: plan.provider, kind: plan.kind, marker: plan.marker, attempts, errorCode: input.errorCode }, input.ambiguous ? "ambiguous" : `failed:${attempts}`);
      return this.getExternalActionPlanSync(plan.id)!;
    });
  }

  async reconcileExternalActionPlan(input: ReconcileExternalActionPlanInput): Promise<ExternalActionPlan> {
    validateDeliveryIdentity(input.planId, "External action plan ID", 128);
    validateDeliveryIdentity(input.deliveryConsumerId, "External action delivery consumer ID", 128);
    validateDeliveryIdentity(input.operatorId, "External action reconciliation operator ID", 256);
    return this.transaction(() => {
      const observedAt = observeStoreClock(this.clock);
      const row = this.getExternalActionPlanRow(input.planId);
      if (!row) throw new StorageConflictError("External action plan not found");
      const plan = this.mapExternalActionPlan(row);
      if (input.evidence.operatorId !== input.operatorId) throw new StorageConflictError("External action reconciliation operator identity does not match its evidence");
      validateExternalActionReconciliation(input.evidence, plan);
      if (plan.reconciliation && canonicalJson(plan.reconciliation) !== canonicalJson(input.evidence)
          && !(plan.state === "ambiguous" && plan.reconciliation.outcome === "zero" && input.evidence.outcome !== "zero")) {
        throw new StorageConflictError("External action reconciliation evidence conflicts with the stored evidence");
      }
      if (plan.state !== "ambiguous") {
        if (plan.reconciliation && canonicalJson(plan.reconciliation) === canonicalJson(input.evidence)
            && ((input.evidence.outcome === "one" && plan.state === "succeeded") || (input.evidence.outcome === "multiple" && plan.state === "quarantined"))) return plan;
        throw new StorageConflictError("Only an ambiguous external action plan can be reconciled");
      }
      const delivery = this.getOutboxDeliveryRow(plan.authorizedOutboxId ?? "", input.deliveryConsumerId);
      if (!delivery || delivery.state !== "dead") throw new StorageConflictError("Ambiguous external action requires its dead delivery evidence");
      const serializedEvidence = canonicalJson(input.evidence);
      if (input.evidence.outcome === "zero") {
        const result = this.db.prepare("UPDATE external_action_plans SET reconciliation_json=?,updated_at=? WHERE id=? AND state='ambiguous'").run(serializedEvidence, observedAt, plan.id) as any;
        if (Number(result.changes) !== 1) throw new StorageConflictError("External action reconciliation lost a concurrent update");
      } else if (input.evidence.outcome === "multiple") {
        const result = this.db.prepare("UPDATE external_action_plans SET state='quarantined',reconciliation_json=?,updated_at=? WHERE id=? AND state='ambiguous'").run(serializedEvidence, observedAt, plan.id) as any;
        if (Number(result.changes) !== 1) throw new StorageConflictError("External action quarantine lost a concurrent update");
      } else {
        const receipt = {
          externalId: input.evidence.externalId!, externalRevision: input.evidence.externalRevision!,
          payloadHash: input.evidence.payloadHash!, observedAt: input.evidence.observedAt,
          marker: plan.marker, targetHash: input.evidence.targetHash,
        };
        validateExternalActionReceipt(receipt, plan);
        const deliveryResult = this.db.prepare("UPDATE outbox_deliveries SET state='delivered',delivered_at=?,next_attempt_at=NULL,last_error_code=NULL,last_error_fingerprint=NULL,receipt_external_id=?,receipt_external_revision=?,receipt_payload_hash=?,receipt_observed_at=? WHERE outbox_id=? AND consumer_id=? AND state='dead'").run(
          observedAt, receipt.externalId, receipt.externalRevision, receipt.payloadHash, receipt.observedAt, plan.authorizedOutboxId, input.deliveryConsumerId,
        ) as any;
        if (Number(deliveryResult.changes) !== 1) throw new StorageConflictError("External action dead delivery could not be reconciled");
        const result = this.db.prepare("UPDATE external_action_plans SET state='succeeded',provider_receipt_json=?,result_json=?,reconciliation_json=?,last_error_code=NULL,last_error_fingerprint=NULL,updated_at=? WHERE id=? AND state='ambiguous'").run(
          canonicalJson(receipt), canonicalJson({ reconciled: true, matchCount: 1 }), serializedEvidence, observedAt, plan.id,
        ) as any;
        if (Number(result.changes) !== 1) throw new StorageConflictError("External action reconciliation success lost a concurrent update");
      }
      this.insertOutbox("external.action.reconciled", plan.id, { planId: plan.id, projectId: plan.projectId, provider: plan.provider, kind: plan.kind, marker: plan.marker, outcome: input.evidence.outcome }, `${input.evidence.outcome}:${input.evidence.targetHash}`);
      return this.getExternalActionPlanSync(plan.id)!;
    });
  }

  private getExternalActionPlanRow(id: string): any | null {
    return this.db.prepare("SELECT * FROM external_action_plans WHERE id=?").get(id) as any ?? null;
  }

  private getExternalActionPlanSync(id: string): ExternalActionPlan | null {
    const row = this.getExternalActionPlanRow(id);
    return row ? this.mapExternalActionPlan(row) : null;
  }

  private assertExternalActionPlanCompatible(stored: ExternalActionPlan, requested: ExternalActionPlan): void {
    if (stored.id !== requested.id || stored.runId !== requested.runId || stored.projectId !== requested.projectId || stored.workflow !== requested.workflow
        || stored.kind !== requested.kind || stored.provider !== requested.provider || stored.marker !== requested.marker
        || canonicalJson(stored.target) !== canonicalJson(requested.target) || canonicalJson(stored.spec) !== canonicalJson(requested.spec)
        || stored.requestHash !== requested.requestHash || stored.evidenceDigest !== requested.evidenceDigest || stored.policyHash !== requested.policyHash
        || stored.approvalId !== requested.approvalId || stored.approvalAction !== requested.approvalAction || stored.exactEffect !== requested.exactEffect || stored.expiresAt !== requested.expiresAt
        || stored.createdAt !== requested.createdAt) {
      throw new StorageConflictError(`External action plan ${requested.id} was already used with different request content`);
    }
  }

  private assertExternalAuthorizedDelivery(plan: ExternalActionPlan, row: any, input: { outboxId: string; consumerId: string; ownerId: string; claimToken: string }, observedAt: string): void {
    if (row.topic !== "external.action.authorized" || row.aggregate_id !== plan.id) throw new StorageConflictError("External action delivery is not the authorized safe event");
    const payload = decodeJson<Record<string, unknown>>(row.payload_json, {});
    if (payload.planId !== plan.id || payload.provider !== plan.provider || payload.kind !== plan.kind || payload.marker !== plan.marker) throw new StorageConflictError("External action authorized event identity does not match the plan");
    this.assertActiveDeliveryFence(row, input, observedAt);
  }

  private persistAuthorityBinding(binding: AuthorityBinding, refresh: boolean): AuthorityBinding {
    const refreshInput = refresh ? binding as AuthorityBindingRefreshInput : null;
    const normalized: AuthorityBinding = {
      provider: binding.provider, localKind: binding.localKind, localId: binding.localId,
      externalKind: binding.externalKind ?? null, externalId: binding.externalId, revision: binding.revision,
      observedAt: binding.observedAt, payloadHash: binding.payloadHash, freshUntil: binding.freshUntil,
    };
    const row = this.db.prepare(`SELECT * FROM authority_bindings
      WHERE provider=? AND local_kind=? AND local_id=?`).get(
      normalized.provider, normalized.localKind, normalized.localId,
    ) as any;
    if (!row) {
      if (refresh) throw new StorageConflictError("Authority refresh requires an existing binding");
      this.db.prepare(`INSERT INTO authority_bindings
        (provider,local_kind,local_id,external_kind,external_id,revision,observed_at,payload_hash,fresh_until)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        normalized.provider, normalized.localKind, normalized.localId, normalized.externalKind ?? null,
        normalized.externalId, normalized.revision, normalized.observedAt, normalized.payloadHash, normalized.freshUntil,
      );
      return normalized;
    }
    const current = this.mapAuthorityBinding(row);
    if (!refresh) {
      if (!this.authorityBindingsEqual(current, normalized)) {
        throw new StorageConflictError("Authority identity or revision changed; use explicit refreshAuthorityBinding");
      }
      return current;
    }
    const expected = refreshInput!;
    const expectedKind = expected.expectedExternalKind ?? null;
    if (current.externalKind !== expectedKind || current.externalId !== expected.expectedExternalId
        || current.revision !== expected.expectedRevision || current.payloadHash !== expected.expectedPayloadHash) {
      throw new StorageConflictError("Authority refresh compare-and-set evidence does not match the stored binding");
    }
    if (Date.parse(normalized.observedAt) < Date.parse(current.observedAt)) {
      throw new StorageConflictError("Authority refresh observedAt cannot move backwards");
    }
    this.db.prepare(`UPDATE authority_bindings SET external_kind=?,external_id=?,revision=?,observed_at=?,
      payload_hash=?,fresh_until=? WHERE provider=? AND local_kind=? AND local_id=?`).run(
      normalized.externalKind ?? null, normalized.externalId, normalized.revision, normalized.observedAt,
      normalized.payloadHash, normalized.freshUntil, normalized.provider, normalized.localKind, normalized.localId,
    );
    return normalized;
  }

  private authorityBindingsEqual(left: AuthorityBinding, right: AuthorityBinding): boolean {
    return (left.externalKind ?? null) === (right.externalKind ?? null)
      && left.provider === right.provider && left.localKind === right.localKind && left.localId === right.localId
      && left.externalId === right.externalId && left.revision === right.revision
      && left.observedAt === right.observedAt && left.payloadHash === right.payloadHash
      && left.freshUntil === right.freshUntil;
  }

  private assertReceiptMatchesAuthority(receipt: OutboxDeliveryAckInput["providerReceipt"], binding: AuthorityBinding): void {
    if (!receipt || receipt.externalId !== binding.externalId || receipt.externalRevision !== binding.revision
        || receipt.payloadHash !== binding.payloadHash || receipt.observedAt !== binding.observedAt) {
      throw new StorageConflictError("Provider receipt does not match the authority binding evidence");
    }
  }

  private assertActiveDeliveryFence(
    row: any,
    input: Pick<OutboxDeliveryAckInput, "outboxId" | "consumerId" | "ownerId" | "claimToken">,
    observedAt: string,
  ): void {
    if (row.state !== "claimed" || row.claim_owner_id !== input.ownerId || row.claim_token !== input.claimToken
        || !row.claim_expires_at || row.claim_expires_at <= observedAt) {
      throw new StorageConflictError("Outbox delivery claim is missing, fenced, or expired");
    }
  }

  private deliveryHistory(value: unknown): OutboxDeliveryAttemptEvidence[] {
    const parsed = decodeJson<OutboxDeliveryAttemptEvidence[]>(value, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  private appendDeliveryHistory(
    history: OutboxDeliveryAttemptEvidence[],
    entry: OutboxDeliveryAttemptEvidence,
  ): OutboxDeliveryAttemptEvidence[] {
    return [...history, entry].slice(-256);
  }

  private getOutboxDeliveryRow(outboxId: string, consumerId: string): any | null {
    return this.db.prepare(`SELECT d.*,oe.id AS event_id,oe.topic,oe.aggregate_id,
      oe.payload_json,oe.created_at AS event_created_at,oe.available_at,oe.published_at,
      oe.attempts AS event_attempts,oe.last_error AS event_last_error
      FROM outbox_deliveries d JOIN outbox_events oe ON oe.id=d.outbox_id
      WHERE d.outbox_id=? AND d.consumer_id=?`).get(outboxId, consumerId) as any ?? null;
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
      WHERE l.state='active' AND r.status IN ('completed','failed','cancelled') ORDER BY l.heartbeat_at`).all() as any[]).map(this.mapLease);
    const expiredLeases = (this.db.prepare("SELECT * FROM workspace_leases WHERE state='active' AND expires_at<=? ORDER BY expires_at").all(now) as any[])
      .map(this.mapLease);
    const quarantinedLeases = (this.db.prepare(`SELECT * FROM workspace_leases
      WHERE state='quarantined' ORDER BY quarantined_at,workspace_id`).all() as any[]).map(this.mapLease);
    const pendingOutbox = (this.db.prepare(`SELECT * FROM outbox_events
      WHERE published_at IS NULL AND available_at<=? ORDER BY created_at,id LIMIT ?`).all(now, outboxLimit) as any[])
      .map(this.mapOutbox);
    return { queuedRuns, strandedApprovals, terminalLeases, expiredLeases, quarantinedLeases, pendingOutbox };
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
    workspaceId: row.workspace_id, runId: row.run_id, ownerId: row.owner_id, mode: row.mode,
    fencingToken: Number(row.fencing_token), state: row.state, expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at, acquiredAt: row.acquired_at,
    quarantinedAt: row.quarantined_at, quarantineReason: row.quarantine_reason,
  });

  private mapSandboxInstance = (row: any): SandboxInstance => ({
    runId: String(row.run_id), workspaceId: String(row.workspace_id), leaseOwnerId: String(row.lease_owner_id),
    fencingToken: Number(row.fencing_token), provider: "docker-compatible", engineId: row.engine_id ? String(row.engine_id) : null,
    imageRef: String(row.image_ref), policyHash: String(row.policy_hash), workspaceDigest: String(row.workspace_digest),
    contextDigest: String(row.context_digest), contextContentHash: String(row.context_content_hash),
    workdirDigest: String(row.workdir_digest), state: String(row.state) as SandboxInstanceState,
    cleanupAttempts: Number(row.cleanup_attempts), lastCleanupAt: row.last_cleanup_at ? String(row.last_cleanup_at) : null,
    quarantineReason: row.quarantine_reason ? String(row.quarantine_reason) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  });

  private mapApproval = (row: any): Approval => ({
    id: row.id, runId: row.run_id, action: row.action, exactEffect: row.exact_effect, state: row.state,
    evidence: decodeJson(row.evidence_json, []), requestedAt: row.requested_at, resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by, decision: row.decision, projectId: row.project_id ?? null,
    workflow: row.workflow ?? null, evidenceDigest: row.evidence_digest ?? null,
    policyHash: row.policy_hash ?? null, expiresAt: row.expires_at ?? null,
  });

  private mapInferenceCapability = (row: any): InferenceCapability => ({
    id: String(row.id), runId: String(row.run_id), projectId: String(row.project_id), workflow: String(row.workflow),
    tokenHash: String(row.token_hash), provider: String(row.provider), model: String(row.model), api: "openai-completions",
    roles: decodeJson(row.roles_json, []) as InferenceCapability["roles"], maxRequests: Number(row.max_requests),
    maxInputTokens: Number(row.max_input_tokens), maxOutputTokens: Number(row.max_output_tokens),
    maxCostMicros: Number(row.max_cost_micros), maxElapsedMs: Number(row.max_elapsed_ms), issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at), state: String(row.state) as InferenceCapability["state"], policyHash: String(row.policy_hash),
  });

  private mapInferenceRequest = (row: any): InferenceRequest => ({
    id: String(row.id), capabilityId: String(row.capability_id), runId: String(row.run_id),
    role: String(row.role) as InferenceRequest["role"], requestHash: String(row.request_hash),
    state: String(row.state) as InferenceRequest["state"], providerRequestId: row.provider_request_id ? String(row.provider_request_id) : null,
    responseHash: row.response_hash ? String(row.response_hash) : null, inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens), costMicros: Number(row.cost_micros), reservedAt: String(row.reserved_at),
    completedAt: row.completed_at ? String(row.completed_at) : null, failureCode: row.failure_code ? String(row.failure_code) : null,
    providerSessionId: row.provider_session_id ? String(row.provider_session_id) : null,
    providerSessionReused: row.provider_session_reused === true || row.provider_session_reused === 1
      || row.provider_session_reused === "1" || row.provider_session_reused === "true",
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
    executionSupported: Boolean(row.execution_supported),
    unsupportedReasons: decodeJson(row.unsupported_reasons_json, []) as string[],
    status: String(row.status) as EngineeringRoutingAssessmentRecord["status"],
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
  });

  private mapComparison = (row: any): ComparisonRecord => ({
    id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), objective: String(row.objective),
    contractHash: String(row.contract_hash), status: String(row.status) as ComparisonRecord["status"],
    selectionPolicy: String(row.selection_policy), createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  });

  private mapComparisonCandidate = (row: any): ComparisonCandidate => ({
    comparisonId: String(row.comparison_id), runId: String(row.run_id), runtime: String(row.runtime),
    workflow: String(row.workflow), ordinal: Number(row.ordinal), status: String(row.status) as ComparisonCandidate["status"],
    metrics: row.metrics_json ? decodeJson(row.metrics_json, null as ComparisonMetrics | null) : null,
    evidenceDigest: row.evidence_digest ? String(row.evidence_digest) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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

  private mapAuthorityBinding = (row: any): AuthorityBinding => ({
    provider: String(row.provider), localKind: String(row.local_kind), localId: String(row.local_id),
    externalKind: row.external_kind === null || row.external_kind === undefined ? null : String(row.external_kind),
    externalId: String(row.external_id), revision: String(row.revision), observedAt: String(row.observed_at),
    payloadHash: String(row.payload_hash), freshUntil: String(row.fresh_until),
  });

  private mapOutboxDelivery = (row: any): OutboxDelivery => {
    const outbox: OutboxEvent = {
      id: String(row.event_id ?? row.outbox_id), topic: String(row.topic), aggregateId: String(row.aggregate_id),
      payload: decodeJson(row.payload_json, {}), createdAt: String(row.event_created_at ?? row.created_at),
      availableAt: String(row.available_at), publishedAt: row.published_at ?? null,
      attempts: Number(row.event_attempts ?? 0), lastError: row.event_last_error ?? null,
    };
    const providerReceipt = row.receipt_external_id === null || row.receipt_external_id === undefined
      ? null
      : {
        externalId: String(row.receipt_external_id), externalRevision: String(row.receipt_external_revision),
        payloadHash: String(row.receipt_payload_hash), observedAt: String(row.receipt_observed_at),
      };
    return {
      outboxId: String(row.outbox_id), consumerId: String(row.consumer_id), state: String(row.state) as OutboxDeliveryState,
      claimOwnerId: row.claim_owner_id === null || row.claim_owner_id === undefined ? null : String(row.claim_owner_id),
      claimToken: row.claim_token === null || row.claim_token === undefined ? null : String(row.claim_token),
      claimExpiresAt: row.claim_expires_at === null || row.claim_expires_at === undefined ? null : String(row.claim_expires_at),
      attempts: Number(row.attempts), nextAttemptAt: row.next_attempt_at === null || row.next_attempt_at === undefined ? null : String(row.next_attempt_at),
      deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
      lastErrorCode: row.last_error_code === null || row.last_error_code === undefined ? null : String(row.last_error_code),
      lastErrorFingerprint: row.last_error_fingerprint === null || row.last_error_fingerprint === undefined ? null : String(row.last_error_fingerprint),
      providerReceipt, attemptHistory: this.deliveryHistory(row.attempt_history_json), outbox,
      topic: outbox.topic, aggregateId: outbox.aggregateId, payload: outbox.payload,
      createdAt: outbox.createdAt, availableAt: outbox.availableAt,
    };
  };

  private mapExternalActionPlan = (row: any): ExternalActionPlan => ({
    id: String(row.id), runId: String(row.run_id), projectId: String(row.project_id), workflow: String(row.workflow),
    kind: String(row.kind) as ExternalActionPlan["kind"], provider: String(row.provider) as ExternalActionPlan["provider"],
    marker: String(row.marker), target: decodeJson(row.target_json, {}), spec: decodeJson(row.spec_json, {}),
    requestHash: String(row.request_hash), evidenceDigest: String(row.evidence_digest), policyHash: String(row.policy_hash),
    approvalId: String(row.approval_id), approvalAction: String(row.approval_action), exactEffect: String(row.exact_effect),
    expiresAt: String(row.expires_at), state: String(row.state) as ExternalActionPlanState, attempts: Number(row.attempts),
    providerReceipt: row.provider_receipt_json ? decodeJson(row.provider_receipt_json, null) : null,
    result: row.result_json ? decodeJson(row.result_json, null) : null,
    lastErrorCode: row.last_error_code === null || row.last_error_code === undefined ? null : String(row.last_error_code),
    lastErrorFingerprint: row.last_error_fingerprint === null || row.last_error_fingerprint === undefined ? null : String(row.last_error_fingerprint),
    reconciliation: row.reconciliation_json ? decodeJson(row.reconciliation_json, null) : null,
    authorizedOutboxId: row.authorized_outbox_id === null || row.authorized_outbox_id === undefined ? null : String(row.authorized_outbox_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  });

  private mapIdempotency = (row: any): StoredIdempotencyRecord => ({
    scope: row.scope, key: row.key, requestHash: row.request_hash, resourceType: row.resource_type,
    resourceId: row.resource_id, response: decodeJson(row.response_json, {}), createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}
