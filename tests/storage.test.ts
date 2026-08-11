import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { PostgresStore } from "../apps/control-plane/src/postgres-store.ts";
import {
  deterministicOutboxId,
  IdempotencyConflictError,
  StorageConflictError,
  type ControlPlaneStore,
  type WorkspaceLease,
  type WorkspaceRecord,
} from "../apps/control-plane/src/store.ts";
import type { Approval, Run } from "../apps/control-plane/src/types.ts";

const projectSeed = {
  id: "ovalo", name: "Ovalo", objective: "Language learning", currentMilestone: "Speaking MVP", health: "on_track",
  linearTeam: "OVA", repository: "ovalo/app", vaultPath: "Projects/Ovalo", memoryNamespace: "projects/ovalo",
};

function run(id: string, status: Run["status"] = "queued", nextActionAt: string | null = null): Run {
  const createdAt = new Date().toISOString();
  return {
    id, taskId: null, projectId: "ovalo", rootRuntime: "atomic", workflow: "test", status,
    stage: null, stageIndex: 0, budgetUsd: 8, costUsd: 0, workspaceId: null,
    nativeRunId: null, nextActionAt, startedAt: null, completedAt: null, metadata: {}, createdAt,
  };
}

function workspaceBundle(runId: string, suffix = runId, expiresAt = new Date(Date.now() + 60_000).toISOString()): {
  workspace: WorkspaceRecord;
  lease: WorkspaceLease;
} {
  const createdAt = new Date().toISOString();
  const workspace: WorkspaceRecord = {
    id: `ws_${suffix}`, runId, path: `/tmp/${suffix}`, provider: "test", status: "leased", createdAt,
  };
  const lease: WorkspaceLease = {
    workspaceId: workspace.id, runId, mode: "writer", expiresAt, heartbeatAt: createdAt,
  };
  return { workspace, lease };
}

async function seed(store: ControlPlaneStore): Promise<void> {
  await store.seedProjects([projectSeed]);
}

async function requestPendingApproval(store: ControlPlaneStore, runId: string, suffix: string): Promise<Approval> {
  const requestedAt = new Date().toISOString();
  const approval: Approval = {
    id: `approval_${suffix}`, runId, action: "prepare_pr", exactEffect: "Prepare only",
    state: "pending", evidence: ["tests"], requestedAt,
  };
  await store.requestApprovalTransaction({
    approval,
    event: {
      id: `event_request_${suffix}`, runId, type: "approval.requested", message: "Approval requested",
      payload: { approvalId: approval.id }, createdAt: requestedAt,
    },
  });
  return approval;
}

async function exerciseApprovalRequestContract(store: ControlPlaneStore, prefix: string): Promise<void> {
  const successRun = run(`${prefix}_request_success`, "running", new Date(Date.now() + 5_000).toISOString());
  await store.createRun(successRun);
  const requestedAt = new Date().toISOString();
  const approval: Approval = {
    id: `${prefix}_request_approval`, runId: successRun.id, action: "prepare_pr", exactEffect: "Prepare only",
    state: "pending", evidence: ["checks"], requestedAt,
  };
  const input = {
    approval,
    event: {
      id: `${prefix}_request_event`, runId: successRun.id, type: "approval.requested",
      message: "Approval requested", payload: { approvalId: approval.id }, createdAt: requestedAt,
    },
    idempotency: { scope: "approval.request", key: `${prefix}-request-key`, requestHash: `${prefix}-request-hash` },
  };
  const first = await store.requestApprovalTransaction(input);
  assert.equal(first.replayed, false);
  assert.equal(first.approval.state, "pending");
  assert.equal(first.run.status, "awaiting_approval");
  assert.equal(first.run.stage, "approval");
  assert.equal(first.run.nextActionAt, null);
  const replay = await store.requestApprovalTransaction(input);
  assert.equal(replay.replayed, true);
  assert.equal((await store.listEvents(successRun.id)).length, 1);
  const topics = (await store.listPendingOutbox()).filter((item) =>
    item.aggregateId === successRun.id || item.aggregateId === approval.id
  ).map((item) => item.topic);
  assert.ok(topics.includes("approval.requested"));
  assert.ok(topics.includes("run.updated"));
  assert.ok(topics.includes("run.event.appended"));

  await assert.rejects(
    store.updateRun(successRun.id, { projectId: "other", rootRuntime: "claude", workspaceId: "other" } as any),
    /identity and ownership fields are immutable/i,
  );
  assert.equal((await store.getRun(successRun.id))?.projectId, "ovalo");
  assert.equal((await store.getRun(successRun.id))?.rootRuntime, "atomic");

  const rollbackRun = run(`${prefix}_request_rollback`, "running");
  await store.createRun(rollbackRun);
  const conflictingEvent = {
    id: `${prefix}_request_conflicting_event`, runId: rollbackRun.id, type: "diagnostic",
    message: "Existing event", payload: { original: true }, createdAt: new Date().toISOString(),
  };
  await store.appendEvent(conflictingEvent);
  const rollbackApproval: Approval = {
    id: `${prefix}_rollback_approval`, runId: rollbackRun.id, action: "prepare_pr", exactEffect: "Prepare only",
    state: "pending", evidence: [], requestedAt: new Date().toISOString(),
  };
  await assert.rejects(store.requestApprovalTransaction({
    approval: rollbackApproval,
    event: {
      ...conflictingEvent, type: "approval.requested", message: "Different content",
      payload: { approvalId: rollbackApproval.id },
    },
  }), StorageConflictError);
  assert.equal(await store.getApproval(rollbackApproval.id), null);
  assert.equal((await store.getRun(rollbackRun.id))?.status, "running");
  assert.equal((await store.listPendingOutbox()).some((item) =>
    item.topic === "approval.requested" && item.aggregateId === rollbackApproval.id
  ), false);
}

async function exerciseMismatchedApprovalEventContract(store: ControlPlaneStore, prefix: string): Promise<void> {
  const approvalRun = run(`${prefix}_event_owner`, "running");
  const otherRun = run(`${prefix}_event_intruder`, "running");
  await store.createRun(approvalRun);
  await store.createRun(otherRun);
  const approval = await requestPendingApproval(store, approvalRun.id, `${prefix}_event_owner`);
  const mismatchedEventId = `${prefix}_mismatched_resolution_event`;
  await assert.rejects(store.resolveApprovalTransaction({
    approvalId: approval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
    runPatch: { status: "running", stage: "finalize" },
    event: {
      id: mismatchedEventId,
      runId: otherRun.id,
      type: "approval.decision_recorded",
      message: "Approved",
      payload: { approvalId: approval.id },
      createdAt: new Date().toISOString(),
    },
    idempotency: {
      scope: "approval.resolve",
      key: `${prefix}-mismatched-event-key`,
      requestHash: `${prefix}-mismatched-event-hash`,
    },
  }), /event must belong to the approval run/i);
  assert.equal((await store.getApproval(approval.id))?.state, "pending");
  assert.equal((await store.getRun(approvalRun.id))?.status, "awaiting_approval");
  assert.equal((await store.listEvents(otherRun.id)).some((event) => event.id === mismatchedEventId), false);
  assert.equal((await store.listPendingOutbox()).some((event) =>
    event.topic === "approval.resolved" && event.aggregateId === approval.id
  ), false);
  assert.equal(await store.getIdempotencyRecord("approval.resolve", `${prefix}-mismatched-event-key`), null);
}

test("SQLite migrations are explicit, repeatable, and current", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const first = await store.migrate();
    assert.deepEqual(first.map((item) => [item.version, item.status]), [[1, "applied"], [2, "applied"], [3, "applied"]]);
    const second = await store.migrate();
    assert.deepEqual(second.map((item) => item.status), ["already_applied", "already_applied", "already_applied"]);
    assert.deepEqual(await store.healthCheck(), { ok: true, backend: "sqlite", migrationsCurrent: true });
  } finally {
    await store.close();
  }
});

test("migration command rejects an unknown storage backend without falling back", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/migrate-storage.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CONTROL_PLANE_STORE: "postgress-typo" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /invalid CONTROL_PLANE_STORE value: postgress-typo/i);
});

test("SQLite adopts a legacy unversioned database and rejects migration checksum drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-legacy-store-"));
  const path = join(root, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,objective TEXT NOT NULL,current_milestone TEXT NOT NULL,
        health TEXT NOT NULL,linear_team TEXT NOT NULL,repository TEXT NOT NULL,vault_path TEXT NOT NULL,
        memory_namespace TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT NOT NULL,root_runtime TEXT NOT NULL,workflow TEXT,
        status TEXT NOT NULL,stage TEXT,stage_index INTEGER NOT NULL DEFAULT 0,budget_usd REAL NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,workspace_id TEXT,native_run_id TEXT,next_action_at TEXT,started_at TEXT,
        completed_at TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const adopted = new SqliteStore(path);
    const applied = await adopted.migrate();
    assert.deepEqual(applied.map((item) => item.status), ["applied", "applied", "applied"]);
    assert.equal((await adopted.healthCheck()).migrationsCurrent, true);
    await adopted.close();

    const corrupt = new DatabaseSync(path);
    corrupt.prepare("UPDATE schema_migrations SET checksum='bad' WHERE version=1").run();
    corrupt.close();
    assert.throws(() => new SqliteStore(path), /checksum mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite rejects unknown migration ledger versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-unknown-migration-"));
  const path = join(root, "test.sqlite");
  try {
    const store = new SqliteStore(path);
    await store.close();
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (999,'future.sql','future',?)")
      .run(new Date().toISOString());
    db.close();
    assert.throws(() => new SqliteStore(path), /unknown migration version.*999/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite fails closed when a legacy database contains mismatched lease ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-unsafe-legacy-"));
  const path = join(root, "legacy.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,objective TEXT NOT NULL,current_milestone TEXT NOT NULL,
        health TEXT NOT NULL,linear_team TEXT NOT NULL,repository TEXT NOT NULL,vault_path TEXT NOT NULL,
        memory_namespace TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT NOT NULL,root_runtime TEXT NOT NULL,workflow TEXT,
        status TEXT NOT NULL,stage TEXT,stage_index INTEGER NOT NULL DEFAULT 0,budget_usd REAL NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,workspace_id TEXT,native_run_id TEXT,next_action_at TEXT,started_at TEXT,
        completed_at TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,run_id TEXT NOT NULL,path TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE workspace_leases (
        workspace_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,mode TEXT NOT NULL,expires_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('ovalo','Ovalo','Objective','Milestone','on_track','OVA','repo','vault','namespace','2026-01-01T00:00:00.000Z');
      INSERT INTO runs VALUES ('legacy_owner',NULL,'ovalo','atomic','test','running',NULL,0,8,0,NULL,NULL,NULL,NULL,NULL,'{}','2026-01-01T00:00:00.000Z');
      INSERT INTO runs VALUES ('legacy_intruder',NULL,'ovalo','atomic','test','running',NULL,0,8,0,NULL,NULL,NULL,NULL,NULL,'{}','2026-01-01T00:00:00.000Z');
      INSERT INTO workspaces VALUES ('legacy_ws','legacy_owner','/tmp/legacy','test','leased','2026-01-01T00:00:00.000Z');
      INSERT INTO workspace_leases VALUES ('legacy_ws','legacy_intruder','writer','2026-01-02T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    `);
    db.close();
    assert.throws(() => new SqliteStore(path), /check constraint failed.*valid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite migration triggers enforce run/workspace/lease ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-sqlite-ownership-"));
  const path = join(root, "test.sqlite");
  try {
    const store = new SqliteStore(path);
    await seed(store);
    await store.createRun(run("sqlite_owner", "running"));
    await store.createRun(run("sqlite_intruder", "running"));
    const workspace = workspaceBundle("sqlite_owner", "sqlite_owner_no_lease").workspace;
    await store.createWorkspace(workspace);
    await store.close();

    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    assert.throws(
      () => db.prepare("UPDATE runs SET workspace_id=? WHERE id=?").run(workspace.id, "sqlite_intruder"),
      /run workspace owner mismatch/i,
    );
    assert.throws(
      () => db.prepare(`INSERT INTO workspace_leases(workspace_id,run_id,mode,expires_at,heartbeat_at)
        VALUES (?,?,?,?,?)`).run(workspace.id, "sqlite_intruder", "writer", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()),
      /workspace lease owner mismatch/i,
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run bundle is atomic, outboxed, and idempotent", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    const item = run("run_bundle");
    const bundle = workspaceBundle(item.id);
    const first = await store.createRunBundle({
      run: item, ...bundle,
      idempotency: { scope: "run.create", key: "mobile-request-1", requestHash: "hash-1" },
    });
    assert.equal(first.replayed, false);
    assert.equal(first.run.workspaceId, bundle.workspace.id);
    assert.equal((await store.listLeases()).length, 1);
    assert.deepEqual((await store.listPendingOutbox()).map((event) => event.topic).sort(), [
      "run.created", "workspace.lease.acquired",
    ]);

    const replay = await store.createRunBundle({
      run: { ...item, id: "a-different-generated-id" },
      ...workspaceBundle("a-different-generated-id"),
      idempotency: { scope: "run.create", key: "mobile-request-1", requestHash: "hash-1" },
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, item.id);
    assert.equal((await store.listRuns()).length, 1);
    await assert.rejects(
      store.createRunBundle({
        run: run("run_conflict"),
        idempotency: { scope: "run.create", key: "mobile-request-1", requestHash: "different-hash" },
      }),
      IdempotencyConflictError,
    );
  } finally {
    await store.close();
  }
});

test("outbox conflict rolls back the complete run bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-outbox-rollback-"));
  const path = join(root, "test.sqlite");
  const target = run("run_outbox_conflict");
  const expectedOutboxId = deterministicOutboxId("run.created", target.id, target.id);
  try {
    let store = new SqliteStore(path);
    await seed(store);
    await store.close();

    const db = new DatabaseSync(path);
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO outbox_events
      (id,topic,aggregate_id,payload_json,created_at,available_at,published_at,attempts,last_error)
      VALUES (?,?,?,?,?,?,NULL,0,NULL)`).run(
      expectedOutboxId, "wrong.topic", target.id, "{}", createdAt, createdAt,
    );
    db.close();

    store = new SqliteStore(path);
    const bundle = workspaceBundle(target.id);
    await assert.rejects(
      store.createRunBundle({ run: target, ...bundle }),
      /outbox id .* different content/i,
    );
    assert.equal(await store.getRun(target.id), null);
    assert.equal(await store.getWorkspace(bundle.workspace.id), null);
    assert.equal((await store.listLeases()).length, 0);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event append is idempotent under concurrent retries and rejects changed content", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    await store.createRun(run("run_event"));
    const event = {
      id: "event_stable", runId: "run_event", type: "stage.started", message: "Started",
      payload: { stage: "plan" }, createdAt: new Date().toISOString(),
    };
    const [first, second] = await Promise.all([store.appendEvent(event), store.appendEvent(event)]);
    assert.equal(first.seq, second.seq);
    assert.equal((await store.listEvents(event.runId)).length, 1);
    assert.equal((await store.listPendingOutbox()).filter((item) => item.topic === "run.event.appended").length, 1);
    await assert.rejects(store.appendEvent({ ...event, payload: { stage: "implement" } }), StorageConflictError);
  } finally {
    await store.close();
  }
});

test("approval request transaction is atomic, replayable, and preserves run ownership", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    await exerciseApprovalRequestContract(store, "sqlite");
  } finally {
    await store.close();
  }
});

test("approval resolution rejects an event owned by another run without side effects", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    await exerciseMismatchedApprovalEventContract(store, "sqlite");
  } finally {
    await store.close();
  }
});

test("approval resolution atomically updates state, run, event, outbox, and idempotency", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    await store.createRun(run("run_approval", "running"));
    const requestedAt = new Date().toISOString();
    const approval: Approval = {
      id: "approval_1", runId: "run_approval", action: "prepare_pr", exactEffect: "Prepare only",
      state: "pending", evidence: ["tests"], requestedAt,
    };
    await store.requestApprovalTransaction({
      approval,
      event: {
        id: "event_approval_request", runId: approval.runId, type: "approval.requested",
        message: "Approval requested", payload: { approvalId: approval.id }, createdAt: requestedAt,
      },
    });
    const input = {
      approvalId: approval.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "wesley",
      runPatch: { status: "running" as const, stage: "finalize" },
      event: {
        id: "event_approval", runId: approval.runId, type: "approval.decision_recorded",
        message: "Approved", payload: { approvalId: approval.id }, createdAt: requestedAt,
      },
    };
    const result = await store.resolveApprovalTransaction(input);
    assert.equal(result.replayed, false);
    assert.equal(result.approval.state, "approved");
    assert.equal(result.run.status, "running");
    assert.equal((await store.listEvents(approval.runId)).length, 2);
    assert.ok((await store.listPendingOutbox()).some((item) => item.topic === "approval.resolved"));

    const replayInput = {
      ...input,
      idempotency: { scope: "approval.resolve", key: "approval-request-1", requestHash: "approve-hash" },
    };
    const replay = await store.resolveApprovalTransaction(replayInput);
    assert.equal(replay.replayed, true);
    assert.equal((await store.getIdempotencyRecord("approval.resolve", "approval-request-1"))?.resourceId, approval.id);
    assert.equal((await store.listEvents(approval.runId)).length, 2);
    await assert.rejects(
      store.resolveApprovalTransaction({ ...replayInput, idempotency: { ...replayInput.idempotency, requestHash: "deny-hash" } }),
      IdempotencyConflictError,
    );
  } finally {
    await store.close();
  }
});

test("approval idempotency cannot replay a run idempotency record", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    await store.createRunBundle({
      run: run("run_wrong_resource", "running"),
      idempotency: { scope: "approval.resolve", key: "cross-resource", requestHash: "same-hash" },
    });
    const approval: Approval = {
      id: "approval_wrong_resource", runId: "run_wrong_resource", action: "prepare_pr", exactEffect: "Prepare only",
      state: "pending", evidence: [], requestedAt: new Date().toISOString(),
    };
    await store.requestApprovalTransaction({
      approval,
      event: {
        id: "event_wrong_resource_request", runId: approval.runId, type: "approval.requested",
        message: "Approval requested", payload: { approvalId: approval.id }, createdAt: approval.requestedAt,
      },
    });
    await assert.rejects(store.resolveApprovalTransaction({
      approvalId: approval.id, state: "approved", decision: "approve", resolvedBy: "wesley",
      idempotency: { scope: "approval.resolve", key: "cross-resource", requestHash: "same-hash" },
    }), /another approval or resource type/i);
    assert.equal((await store.getApproval(approval.id))?.state, "pending");
  } finally {
    await store.close();
  }
});

test("run claiming is exclusive and releasing a claim preserves nextActionAt", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    const due = new Date(Date.now() - 1_000).toISOString();
    await store.createRun(run("run_claim", "running", due));
    const until = new Date(Date.now() + 30_000).toISOString();
    assert.deepEqual((await store.claimRunnableRuns(new Date().toISOString(), until, "worker-a")).map((item) => item.id), ["run_claim"]);
    assert.equal((await store.claimRunnableRuns(new Date().toISOString(), until, "worker-b")).length, 0);
    await store.releaseRunClaim("run_claim", "worker-a");
    assert.equal((await store.getRun("run_claim"))?.nextActionAt, due);
    assert.equal((await store.claimRunnableRuns(new Date().toISOString(), until, "worker-b")).length, 1);
  } finally {
    await store.close();
  }
});

test("restart reconciliation identifies queued runs, terminal and expired leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-restart-"));
  const path = join(root, "test.sqlite");
  try {
    let store = new SqliteStore(path);
    await seed(store);
    await store.createRun(run("run_queued"));
    const completed = run("run_terminal", "completed");
    const completedWorkspace = workspaceBundle(completed.id);
    await store.createRunBundle({ run: completed, ...completedWorkspace });
    const active = run("run_expired", "running", new Date(Date.now() + 10_000).toISOString());
    const expiredWorkspace = workspaceBundle(active.id, active.id, new Date(Date.now() - 1_000).toISOString());
    await store.createRunBundle({ run: active, ...expiredWorkspace });
    await store.close();

    store = new SqliteStore(path);
    const candidates = await store.listReconciliationCandidates(new Date().toISOString());
    assert.deepEqual(candidates.queuedRuns.map((item) => item.id), ["run_queued"]);
    assert.deepEqual(candidates.terminalLeases.map((item) => item.runId), ["run_terminal"]);
    assert.deepEqual(candidates.expiredLeases.map((item) => item.runId), ["run_expired"]);
    await store.resetOperationalData();
    assert.equal((await store.listRuns()).length, 0);
    assert.equal((await store.listLeases()).length, 0);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const postgresContractEnabled = process.env.RUN_POSTGRES_STORAGE_CONTRACT_TESTS === "1";
const postgresUrl = postgresContractEnabled ? process.env.TEST_DATABASE_URL : undefined;
if (postgresContractEnabled && !postgresUrl) {
  throw new Error("TEST_DATABASE_URL is required when RUN_POSTGRES_STORAGE_CONTRACT_TESTS=1");
}
test("PostgreSQL storage contract smoke", { skip: !postgresUrl }, async () => {
  let store = await PostgresStore.connect({ databaseUrl: postgresUrl!, autoMigrate: true, maxConnections: 8 });
  try {
    const migrationOutput = await store.migrate();
    assert.deepEqual(migrationOutput.map((item) => item.version), [1, 2, 3]);
    const repeatedMigrations = await store.migrate();
    assert.deepEqual(repeatedMigrations.map((item) => item.status), ["already_applied", "already_applied", "already_applied"]);
    assert.deepEqual(await store.healthCheck(), { ok: true, backend: "postgres", migrationsCurrent: true });

    await store.resetOperationalData();
    await seed(store);
    await exerciseApprovalRequestContract(store, "postgres");
    await exerciseMismatchedApprovalEventContract(store, "postgres");
    const runsBeforeCandidates = (await store.listRuns()).length;
    const candidates = Array.from({ length: 8 }, (_, index) => {
      const item = run(`pg_candidate_${index}`);
      return store.createRunBundle({
        run: item, ...workspaceBundle(item.id),
        idempotency: { scope: "run.create", key: "pg-key", requestHash: "pg-hash" },
      });
    });
    const created = await Promise.all(candidates);
    assert.equal(new Set(created.map((item) => item.run.id)).size, 1);
    assert.equal(created.filter((item) => !item.replayed).length, 1);
    const winner = created[0].run;
    const winnerWorkspace = created[0].workspace!;
    assert.equal((await store.listRuns()).length, runsBeforeCandidates + 1);
    assert.equal((await store.listLeases()).length, 1);

    const directOwner = run("pg_direct_owner", "running");
    const directIntruder = run("pg_direct_intruder", "running");
    await store.createRun(directOwner);
    await store.createRun(directIntruder);
    const directWorkspace = workspaceBundle(directOwner.id, "pg_direct_no_lease").workspace;
    await store.createWorkspace(directWorkspace);
    const { Pool } = await import("pg");
    const direct = new Pool({ connectionString: postgresUrl! });
    await assert.rejects(
      direct.query("UPDATE runs SET workspace_id=$1 WHERE id=$2", [directWorkspace.id, directIntruder.id]),
      /fk_runs_workspace_owner|foreign key/i,
    );
    await assert.rejects(
      direct.query(`INSERT INTO workspace_leases(workspace_id,run_id,mode,expires_at,heartbeat_at)
        VALUES ($1,$2,'writer',now()+interval '1 minute',now())`, [directWorkspace.id, directIntruder.id]),
      /fk_workspace_lease_owner|foreign key/i,
    );
    await direct.end();

    const rollbackRun = run("pg_rollback");
    const conflictingWorkspace: WorkspaceRecord = {
      ...winnerWorkspace, runId: rollbackRun.id, path: "/tmp/pg-rollback",
    };
    const conflictingLease: WorkspaceLease = {
      workspaceId: winnerWorkspace.id, runId: rollbackRun.id, mode: "writer",
      heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await assert.rejects(store.createRunBundle({
      run: rollbackRun, workspace: conflictingWorkspace, lease: conflictingLease,
    }));
    assert.equal(await store.getRun(rollbackRun.id), null);

    const event = {
      id: "pg_event", runId: winner.id, type: "run.started", message: "Started",
      payload: { native: true }, createdAt: new Date().toISOString(),
    };
    const appended = await Promise.all(Array.from({ length: 8 }, () => store.appendEvent(event)));
    assert.equal(new Set(appended.map((value) => value.seq)).size, 1);
    assert.equal((await store.listEvents(winner.id)).length, 1);
    assert.equal((await store.listPendingOutbox()).filter((value) =>
      value.topic === "run.event.appended" && value.aggregateId === winner.id
    ).length, 1);

    const approvalRun = run("pg_approval", "running");
    await store.createRun(approvalRun);
    const approval: Approval = {
      id: "pg_approval_1", runId: approvalRun.id, action: "prepare_pr", exactEffect: "Prepare only",
      state: "pending", evidence: ["checks"], requestedAt: new Date().toISOString(),
    };
    await store.requestApprovalTransaction({
      approval,
      event: {
        id: "pg_approval_request_event", runId: approval.runId, type: "approval.requested",
        message: "Approval requested", payload: { approvalId: approval.id }, createdAt: approval.requestedAt,
      },
    });
    const resolutionInput = {
      approvalId: approval.id, state: "approved", decision: "approve", resolvedBy: "wesley",
      runPatch: { status: "running" as const, stage: "finalize" },
      event: {
        id: "pg_approval_event", runId: approvalRun.id, type: "approval.decision_recorded",
        message: "Approved", payload: { approvalId: approval.id }, createdAt: new Date().toISOString(),
      },
    };
    const firstResolution = await store.resolveApprovalTransaction(resolutionInput);
    assert.equal(firstResolution.replayed, false);
    const replayResolutionInput = {
      ...resolutionInput,
      idempotency: { scope: "approval.resolve", key: "pg-approval-key", requestHash: "pg-approval-hash" },
    };
    const resolutions = await Promise.all(Array.from({ length: 4 }, () => store.resolveApprovalTransaction(replayResolutionInput)));
    assert.equal(resolutions.every((item) => item.replayed), true);
    assert.equal((await store.getIdempotencyRecord("approval.resolve", "pg-approval-key"))?.resourceId, approval.id);
    const otherApprovalRun = run("pg_other_approval", "running");
    await store.createRun(otherApprovalRun);
    const otherApproval = await requestPendingApproval(store, otherApprovalRun.id, "pg_other");
    await assert.rejects(store.resolveApprovalTransaction({
      approvalId: otherApproval.id, state: "approved", decision: "approve", resolvedBy: "wesley",
      idempotency: replayResolutionInput.idempotency,
    }), /another approval or resource type/i);
    assert.equal((await store.getApproval(otherApproval.id))?.state, "pending");
    assert.equal((await store.getApproval(approval.id))?.state, "approved");
    assert.equal((await store.getRun(approvalRun.id))?.status, "running");
    assert.equal((await store.listEvents(approvalRun.id)).length, 2);

    const due = new Date(Date.now() - 1_000).toISOString();
    await store.createRun(run("pg_claim", "running", due));
    const claimUntil = new Date(Date.now() + 30_000).toISOString();
    const claimResults = await Promise.all([
      store.claimRunnableRuns(new Date().toISOString(), claimUntil, "pg-worker-a"),
      store.claimRunnableRuns(new Date().toISOString(), claimUntil, "pg-worker-b"),
    ]);
    assert.equal(claimResults.flat().filter((item) => item.id === "pg_claim").length, 1);
    const claimingWorker = claimResults[0].some((item) => item.id === "pg_claim") ? "pg-worker-a" : "pg-worker-b";
    await store.releaseRunClaim("pg_claim", claimingWorker);
    assert.equal((await store.getRun("pg_claim"))?.nextActionAt, due);

    await store.createRun(run("pg_queued"));
    const terminal = run("pg_terminal", "completed");
    await store.createRunBundle({ run: terminal, ...workspaceBundle(terminal.id) });
    const expired = run("pg_expired", "running", new Date(Date.now() + 20_000).toISOString());
    await store.createRunBundle({
      run: expired,
      ...workspaceBundle(expired.id, expired.id, new Date(Date.now() - 1_000).toISOString()),
    });

    await store.close();
    store = await PostgresStore.connect({ databaseUrl: postgresUrl!, autoMigrate: false, maxConnections: 4 });
    const reconciliation = await store.listReconciliationCandidates(new Date().toISOString());
    assert.ok(reconciliation.queuedRuns.some((item) => item.id === "pg_queued"));
    assert.ok(reconciliation.terminalLeases.some((item) => item.runId === "pg_terminal"));
    assert.ok(reconciliation.expiredLeases.some((item) => item.runId === "pg_expired"));
    assert.ok(reconciliation.pendingOutbox.length > 0);

    await store.close();
    const ledgerPool = new Pool({ connectionString: postgresUrl! });
    await ledgerPool.query(`INSERT INTO schema_migrations(version,name,checksum)
      VALUES (999,'future.sql','future')`);
    await ledgerPool.end();
    await assert.rejects(
      PostgresStore.connect({ databaseUrl: postgresUrl!, autoMigrate: true, maxConnections: 2 }),
      /unknown migration version.*999/i,
    );
    const cleanupPool = new Pool({ connectionString: postgresUrl! });
    await cleanupPool.query("DELETE FROM schema_migrations WHERE version=999");
    await cleanupPool.end();
    store = await PostgresStore.connect({ databaseUrl: postgresUrl!, autoMigrate: false, maxConnections: 4 });
  } finally {
    await store.resetOperationalData().catch(() => undefined);
    await store.close().catch(() => undefined);
  }
});
