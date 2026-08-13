import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { PostgresStore } from "../apps/control-plane/src/postgres-store.ts";
import { loadMigrationFiles } from "../apps/control-plane/src/migrations.ts";
import {
  deterministicOutboxId,
  IdempotencyConflictError,
  StorageConflictError,
  type ControlPlaneStore,
  type WriterLeaseRequest,
  type WorkspaceRecord,
} from "../apps/control-plane/src/store.ts";
import type { Approval, Artifact, Run } from "../apps/control-plane/src/types.ts";

const projectSeed = {
  id: "ovalo", name: "Ovalo", objective: "Language learning", currentMilestone: "Speaking MVP", health: "on_track",
  linearTeam: "OVA", repository: "ovalo/app", vaultPath: "Projects/Ovalo", memoryNamespace: "projects/ovalo",
};

interface MutableStoreClock {
  now: () => Date;
  current: () => number;
  set: (timestamp: number) => void;
}

function mutableStoreClock(initial = Date.now()): MutableStoreClock {
  let timestamp = initial;
  return {
    now: () => new Date(timestamp),
    current: () => timestamp,
    set: (value) => { timestamp = value; },
  };
}

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
  lease: WriterLeaseRequest;
} {
  const createdAt = new Date().toISOString();
  const workspace: WorkspaceRecord = {
    id: `ws_${suffix}`, runId, path: `/tmp/${suffix}`, provider: "test", status: "leased", createdAt,
  };
  const lease: WriterLeaseRequest = {
    workspaceId: workspace.id, runId, ownerId: `owner_${suffix}`, mode: "writer", expiresAt, heartbeatAt: createdAt,
  };
  return { workspace, lease };
}

async function exerciseSandboxInstanceContract(store: ControlPlaneStore, prefix: string, clock: MutableStoreClock): Promise<void> {
  const instanceRun = run(`${prefix}_sandbox_instance`);
  const bundle = workspaceBundle(
    instanceRun.id,
    instanceRun.id,
    new Date(clock.current() + 60_000).toISOString(),
  );
  bundle.workspace.provider = "isolated-git-worktree";
  bundle.lease.heartbeatAt = new Date(clock.current()).toISOString();
  const created = await store.createRunBundle({ run: instanceRun, ...bundle });
  const lease = created.lease!;
  const initialAt = new Date(clock.current()).toISOString();
  const input = {
    runId: instanceRun.id,
    workspaceId: bundle.workspace.id,
    leaseOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    provider: "docker-compatible" as const,
    imageRef: `fixture.invalid/writer@sha256:${"a".repeat(64)}`,
    policyHash: "b".repeat(64),
    workspaceDigest: "c".repeat(64),
    contextDigest: "d".repeat(64),
    contextContentHash: "0".repeat(64),
    workdirDigest: "e".repeat(64),
    createdAt: initialAt,
    updatedAt: initialAt,
  };
  assert.equal((await store.createSandboxInstance(input)).state, "provisioning");
  assert.deepEqual(await store.createSandboxInstance(input), await store.getSandboxInstance(instanceRun.id));
  await assert.rejects(store.createSandboxInstance({ ...input, policyHash: "f".repeat(64) }), /different lifecycle evidence/i);

  const common = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    ownerId: input.leaseOwnerId,
    fencingToken: input.fencingToken,
  };
  const engineId = "1".repeat(64);
  clock.set(clock.current() + 1_000);
  const readyAt = new Date(clock.current()).toISOString();
  const ready = await store.transitionSandboxInstance({
    ...common, expectedState: "provisioning", state: "ready", engineId, updatedAt: readyAt,
  });
  assert.equal(ready?.engineId, engineId);
  assert.equal((await store.transitionSandboxInstance({
    ...common, expectedState: "provisioning", state: "ready", engineId, updatedAt: readyAt,
  })), null, "state transitions must be compare-and-set");
  clock.set(clock.current() + 1_000);
  assert.equal((await store.transitionSandboxInstance({
    ...common, expectedState: "ready", state: "running", updatedAt: new Date(clock.current()).toISOString(),
  }))?.state, "running");
  clock.set(clock.current() + 1_000);
  const cleanupAt = new Date(clock.current()).toISOString();
  assert.equal((await store.transitionSandboxInstance({
    ...common, expectedState: "running", state: "freezing", updatedAt: cleanupAt, cleanupAttemptedAt: cleanupAt,
  }))?.cleanupAttempts, 1);
  clock.set(clock.current() + 1_000);
  assert.equal((await store.transitionSandboxInstance({
    ...common, expectedState: "freezing", state: "exporting", updatedAt: new Date(clock.current()).toISOString(),
  }))?.state, "exporting");
  clock.set(clock.current() + 1_000);
  assert.equal((await store.transitionSandboxInstance({
    ...common, expectedState: "exporting", state: "cleaned", updatedAt: new Date(clock.current()).toISOString(),
  }))?.state, "cleaned");
  await assert.rejects(store.transitionSandboxInstance({
    ...common, expectedState: "cleaned", state: "quarantined", updatedAt: new Date(clock.current()).toISOString(),
    quarantineReason: "too_late",
  }), /not allowed/i);

  const quarantineRun = run(`${prefix}_sandbox_quarantine`);
  const quarantineBundle = workspaceBundle(
    quarantineRun.id,
    quarantineRun.id,
    new Date(clock.current() + 60_000).toISOString(),
  );
  quarantineBundle.workspace.provider = "isolated-git-worktree";
  quarantineBundle.lease.heartbeatAt = new Date(clock.current()).toISOString();
  const quarantineCreated = await store.createRunBundle({ run: quarantineRun, ...quarantineBundle });
  const quarantineLease = quarantineCreated.lease!;
  const quarantineInput = {
    ...input,
    runId: quarantineRun.id,
    workspaceId: quarantineBundle.workspace.id,
    leaseOwnerId: quarantineLease.ownerId,
    fencingToken: quarantineLease.fencingToken,
    createdAt: new Date(clock.current()).toISOString(),
    updatedAt: new Date(clock.current()).toISOString(),
  };
  await store.createSandboxInstance(quarantineInput);
  clock.set(clock.current() + 1_000);
  const quarantineAt = new Date(clock.current()).toISOString();
  const quarantined = await store.transitionSandboxInstance({
    runId: quarantineInput.runId,
    workspaceId: quarantineInput.workspaceId,
    ownerId: quarantineInput.leaseOwnerId,
    fencingToken: quarantineInput.fencingToken,
    expectedState: "provisioning",
    state: "quarantined",
    updatedAt: quarantineAt,
    cleanupAttemptedAt: quarantineAt,
    quarantineReason: "restart_engine_object_absent",
  });
  assert.equal(quarantined?.quarantineReason, "restart_engine_object_absent");
  assert.deepEqual((await store.listSandboxInstances(["quarantined"])).map((item) => item.runId), [quarantineRun.id]);
  const outboxTopics = (await store.listPendingOutbox()).filter((item) => item.aggregateId === instanceRun.id)
    .map((item) => item.topic);
  for (const state of ["provisioning", "ready", "running", "freezing", "exporting", "cleaned"]) {
    assert.ok(outboxTopics.includes(`sandbox.instance.${state}`));
  }
  assert.equal(await store.releaseWorkspaceLease({
    workspaceId: input.workspaceId, runId: input.runId, ownerId: input.leaseOwnerId, fencingToken: input.fencingToken,
  }), true);
  assert.equal(await store.releaseWorkspaceLease({
    workspaceId: quarantineInput.workspaceId, runId: quarantineInput.runId,
    ownerId: quarantineInput.leaseOwnerId, fencingToken: quarantineInput.fencingToken,
  }), true);
}

async function exerciseComparisonContract(store: ControlPlaneStore, prefix: string, clock: MutableStoreClock): Promise<void> {
  const createdAt = new Date(clock.current()).toISOString();
  const taskId = `${prefix}_comparison_task`;
  await store.createTask({
    id: taskId, projectId: "ovalo", source: "fixture", sourceId: null, title: "Comparison fixture",
    objective: "Compare exact fixture", status: "planned", priority: "normal", createdAt,
  });
  const candidateRun = {
    ...run(`${prefix}_comparison_run`), taskId, rootRuntime: "codex" as const,
    workflow: "direct-codex-fixture-model-pilot", createdAt,
  };
  await store.createRun(candidateRun);
  const comparison = {
    id: `${prefix}_comparison`, projectId: "ovalo", taskId, objective: "Compare exact fixture",
    contractHash: "a".repeat(64), status: "running" as const,
    selectionPolicy: "Human selects only after evidence; completion is not acceptance.",
    createdAt, completedAt: null,
  };
  assert.deepEqual(await store.createComparison(comparison), comparison);
  assert.deepEqual(await store.createComparison(comparison), comparison, "comparison creation replays exactly");
  const attached = {
    comparisonId: comparison.id, runId: candidateRun.id, runtime: "codex", workflow: candidateRun.workflow,
    ordinal: 1, status: "running" as const, metrics: null, evidenceDigest: null, createdAt, updatedAt: createdAt,
  };
  assert.deepEqual(await store.attachComparisonCandidate(attached), attached);
  const finalized = {
    ...attached, status: "evidence_ready" as const, evidenceDigest: "b".repeat(64),
    metrics: {
      correctness: "passed" as const, defectsCaught: 0, inputTokens: 100, outputTokens: 20, costMicros: 0,
      elapsedMs: 1234, humanReviewArtifacts: 11, eventCount: 9,
      recoveryReliability: "not_exercised" as const, resumability: "control_plane_only" as const,
      integrationComplexity: 4,
    },
    updatedAt: new Date(clock.current() + 1_000).toISOString(),
  };
  assert.deepEqual(await store.finalizeComparisonCandidate(finalized), finalized);
  assert.deepEqual(await store.finalizeComparisonCandidate(finalized), finalized, "metric finalization replays exactly");
  assert.deepEqual(await store.listComparisonCandidates(comparison.id), [finalized]);
  await assert.rejects(store.finalizeComparisonCandidate({ ...finalized, evidenceDigest: "c".repeat(64) }), /replay changed/i);
  const outbox = await store.listPendingOutbox(1000);
  assert.ok(outbox.some((item) => item.topic === "comparison.created" && item.aggregateId === comparison.id));
  assert.ok(outbox.some((item) => item.topic === "comparison.candidate.finalized" && item.aggregateId === candidateRun.id));
}

async function exerciseEngineeringRoutingAssessmentContract(
  store: ControlPlaneStore,
  prefix: string,
  clock: MutableStoreClock,
): Promise<void> {
  await store.seedProjects([{
    id: `${prefix}_other_project`, name: "Other", objective: "Other", currentMilestone: "M1", health: "on_track",
    linearTeam: "OTHER", repository: "other/repo", vaultPath: "Projects/Other", memoryNamespace: `projects/${prefix}/other`,
  }]);
  const createdAt = new Date(clock.current()).toISOString();
  const taskId = `${prefix}_routing_task`;
  const otherTaskId = `${prefix}_routing_other_task`;
  await store.createTask({
    id: taskId, projectId: "ovalo", source: "fixture", sourceId: null, title: "Routing task",
    objective: "Assess route", status: "planned", priority: "normal", createdAt,
  });
  await store.createTask({
    id: otherTaskId, projectId: `${prefix}_other_project`, source: "fixture", sourceId: null, title: "Other task",
    objective: "Other route", status: "planned", priority: "normal", createdAt,
  });
  const literalRequest = `${prefix}: change the bounded fixture and run checks`;
  const assessment = {
    id: `${prefix}_routing_assessment`, projectId: "ovalo", taskId: taskId,
    literalRequest, requestHash: "1".repeat(64), contextDigest: "2".repeat(64),
    contextSources: {
      linear: { status: "current", issueId: `${prefix}_linear` },
      git: "current",
      projectBrain: { status: "accepted", revision: "r1" },
    },
    dimensions: { structure: 1, verifiability: 1, iteration: 0, risk: 1, duration: 0, isolation: 1 } as const,
    hardSignals: { explicitLoop: false, durableBackground: false, approvalOrEvidenceGate: false, multipleCandidates: false } as const,
    preference: "atomic-full" as const, finalAction: "prepare_reviewable_result" as const,
    baselineShape: "atomic-lite" as const, selectedShape: "atomic-full" as const,
    score: 4, reasons: ["rubric:atomic-lite", "preference:atomic-full:applied"], policyVersion: "p009-v1",
    executionSupported: true, unsupportedReasons: [], status: "assessed" as const, runId: null,
    createdAt, expiresAt: new Date(clock.current() + 60_000).toISOString(),
  };
  const idempotency = { scope: "engineering-routing-assessment", key: `${prefix}_routing_key`, requestHash: "3".repeat(64) };
  const created = await store.createEngineeringRoutingAssessment(assessment, idempotency);
  assert.equal(created.replayed, false);
  assert.deepEqual(created.assessment, assessment);
  assert.deepEqual(await store.getEngineeringRoutingAssessment(assessment.id), assessment);
  assert.deepEqual(await store.listEngineeringRoutingAssessments("ovalo", 10), [assessment]);
  const ledger = await store.getIdempotencyRecord(idempotency.scope, idempotency.key);
  assert.deepEqual({ resourceType: ledger?.resourceType, resourceId: ledger?.resourceId }, {
    resourceType: "engineering-routing-assessment", resourceId: assessment.id,
  });
  const routingOutbox = (await store.listPendingOutbox(1_000)).find((event) => event.aggregateId === assessment.id
    && event.topic === "engineering.routing.assessment.created");
  assert.ok(routingOutbox);
  assert.equal(routingOutbox?.payload.literalRequest, undefined);
  assert.equal(JSON.stringify(routingOutbox?.payload).includes(literalRequest), false);
  assert.deepEqual(await store.createEngineeringRoutingAssessment({ assessment, idempotency }), {
    assessment, replayed: true,
  });
  await assert.rejects(store.createEngineeringRoutingAssessment({
    ...assessment, literalRequest: `${literalRequest} changed`, requestHash: "4".repeat(64),
  }, { ...idempotency, requestHash: "4".repeat(64) }), /idempotency|different content/i);
  await assert.rejects(store.createEngineeringRoutingAssessment({
    assessment: { ...assessment, literalRequest: `${literalRequest} changed`, requestHash: "4".repeat(64) },
    idempotency: { ...idempotency, requestHash: "5".repeat(64) },
  }), /idempotency|different content/i);

  const concurrentRecords = Array.from({ length: 8 }, (_, index) => ({
    ...assessment,
    id: `${prefix}_routing_concurrent_${index}`,
    literalRequest: `${literalRequest} generated-${index}`,
    requestHash: "6".repeat(64),
    createdAt: new Date(clock.current() + index + 1).toISOString(),
    expiresAt: new Date(clock.current() + 60_000 + index + 1).toISOString(),
  }));
  const concurrentKey = { scope: idempotency.scope, key: `${prefix}_routing_concurrent_key`, requestHash: "7".repeat(64) };
  const concurrentResults = await Promise.all(concurrentRecords.map((record) =>
    store.createEngineeringRoutingAssessment(record, concurrentKey)));
  assert.equal(concurrentResults.filter((item) => !item.replayed).length, 1);
  assert.equal(new Set(concurrentResults.map((item) => item.assessment.id)).size, 1);
  const firstPersisted = concurrentResults.find((item) => !item.replayed)?.assessment;
  assert.ok(firstPersisted);
  for (const item of concurrentResults) assert.deepEqual(item.assessment, firstPersisted);
  assert.deepEqual(await store.getEngineeringRoutingAssessment(firstPersisted!.id), firstPersisted);

  const mismatchedTask = { ...assessment, id: `${prefix}_routing_cross_project`, taskId: otherTaskId, requestHash: "8".repeat(64) };
  await assert.rejects(store.createEngineeringRoutingAssessment(mismatchedTask), /another project|belong/i);
  assert.equal(await store.getEngineeringRoutingAssessment(mismatchedTask.id), null);
  assert.equal((await store.listPendingOutbox(1_000)).some((event) => event.aggregateId === mismatchedTask.id), false);
  await assert.rejects(store.createEngineeringRoutingAssessment({ ...assessment, id: `${prefix}_routing_bad_score`, score: 3 }), /score/i);
  await assert.rejects(store.createEngineeringRoutingAssessment({ ...assessment, id: `${prefix}_routing_bad_digest`, requestHash: "not-a-digest" }), /hash|digest/i);
  await assert.rejects(store.createEngineeringRoutingAssessment({ ...assessment, id: `${prefix}_routing_bad_status`, status: "unsupported", executionSupported: true }), /supported|unsupported/i);
  await assert.rejects(store.createEngineeringRoutingAssessment({ ...assessment, id: `${prefix}_routing_run_binding`, runId: `${prefix}_future_run` }), /future|binding/i);

  const unsupported = {
    ...assessment, id: `${prefix}_routing_unsupported`, preference: "auto" as const,
    selectedShape: "atomic-lite" as const, executionSupported: false, unsupportedReasons: ["atomic-lite unavailable"],
    status: "unsupported" as const, requestHash: "9".repeat(64),
  };
  assert.equal((await store.createEngineeringRoutingAssessment(unsupported)).assessment.status, "unsupported");
  assert.equal((await store.listEngineeringRoutingAssessments(undefined, 100)).length, 3);
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

async function exerciseQueuedStartClaimContract(
  store: ControlPlaneStore,
  prefix: string,
  clock: MutableStoreClock,
): Promise<void> {
  const startingTime = clock.current();
  const queued = run(`${prefix}_queued_start_claim`);
  await store.createRun(queued);
  const firstUntil = new Date(clock.current() + 10_000).toISOString();
  const first = await store.claimQueuedRunForStart(queued.id, `${prefix}-worker-a`, firstUntil);
  assert.equal(first?.id, queued.id);
  assert.equal(first?.status, "queued", "claiming must not transition the run lifecycle");
  assert.equal(await store.claimQueuedRunForStart(
    queued.id,
    `${prefix}-worker-b`,
    new Date(clock.current() + 20_000).toISOString(),
  ), null);
  await store.releaseRunClaim(queued.id, `${prefix}-worker-b`);
  assert.equal(await store.claimQueuedRunForStart(
    queued.id,
    `${prefix}-worker-b`,
    new Date(clock.current() + 20_000).toISOString(),
  ), null, "a non-owner release must not clear the active claim");

  clock.set(clock.current() + 10_001);
  const second = await store.claimQueuedRunForStart(
    queued.id,
    `${prefix}-worker-b`,
    new Date(clock.current() + 10_000).toISOString(),
  );
  assert.equal(second?.status, "queued", "an expired queued-run claim must be reclaimable");
  await store.releaseRunClaim(queued.id, `${prefix}-worker-a`);
  assert.equal(await store.claimQueuedRunForStart(
    queued.id,
    `${prefix}-worker-c`,
    new Date(clock.current() + 10_000).toISOString(),
  ), null, "an expired owner must not release a replacement claim");
  await store.releaseRunClaim(queued.id, `${prefix}-worker-b`);
  assert.equal((await store.claimQueuedRunForStart(
    queued.id,
    `${prefix}-worker-c`,
    new Date(clock.current() + 10_000).toISOString(),
  ))?.id, queued.id);

  const running = run(`${prefix}_running_start_claim`, "running");
  await store.createRun(running);
  assert.equal(await store.claimQueuedRunForStart(
    running.id,
    `${prefix}-worker-a`,
    new Date(clock.current() + 10_000).toISOString(),
  ), null, "only the exact queued state is claimable for start");
  await assert.rejects(store.claimQueuedRunForStart(
    queued.id,
    `${prefix}-worker-a`,
    new Date(clock.current()).toISOString(),
  ), /claim expiry must be after observed storage time/i);
  clock.set(startingTime);
}

async function exerciseRunAdmissionContract(store: ControlPlaneStore, prefix: string): Promise<void> {
  const workflow = `${prefix}-single-pilot`;
  const admission = { workflow, maxNonterminal: 1 };
  const first = { ...run(`${prefix}_admission_first`), workflow };
  const second = { ...run(`${prefix}_admission_second`), workflow };
  await store.createRunBundle({ run: first, admission });
  await assert.rejects(
    store.createRunBundle({ run: second, admission }),
    /admission limit reached/i,
  );
  await assert.rejects(
    store.createRunBundle({ run: { ...second, workflow: `${workflow}-other` }, admission }),
    /bind the exact workflow/i,
  );
  await store.updateRun(first.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  assert.equal((await store.createRunBundle({ run: second, admission })).run.id, second.id);
}

async function exercisePilotApprovalBindingContract(
  store: ControlPlaneStore,
  prefix: string,
  clock: MutableStoreClock,
): Promise<void> {
  const startingTime = clock.current();
  const evidenceDigest = "a".repeat(64);
  const policyHash = "b".repeat(64);
  const request = async (approval: Approval, eventSuffix: string) => store.requestApprovalTransaction({
    approval,
    event: {
      id: `${prefix}_pilot_event_${eventSuffix}`,
      runId: approval.runId,
      type: "approval.requested",
      message: "Bound pilot approval requested",
      payload: { approvalId: approval.id },
      createdAt: approval.requestedAt,
    },
    idempotency: {
      scope: "approval.request",
      key: `${prefix}-pilot-request-${eventSuffix}`,
      requestHash: `${prefix}-pilot-request-hash-${eventSuffix}`,
    },
  });

  const boundRun = run(`${prefix}_pilot_bound`, "running");
  await store.createRun(boundRun);
  const expiresAt = new Date(clock.current() + 60_000).toISOString();
  const approval: Approval = {
    id: `${prefix}_pilot_approval`,
    runId: boundRun.id,
    action: "prepare_pr",
    exactEffect: "Prepare a safe mock draft PR only",
    state: "pending",
    evidence: ["deterministic checks"],
    requestedAt: new Date(clock.current()).toISOString(),
    projectId: boundRun.projectId,
    workflow: boundRun.workflow,
    evidenceDigest,
    policyHash,
    expiresAt,
  };
  const first = await request(approval, "success");
  assert.equal(first.replayed, false);
  assert.deepEqual({
    projectId: first.approval.projectId,
    workflow: first.approval.workflow,
    evidenceDigest: first.approval.evidenceDigest,
    policyHash: first.approval.policyHash,
    expiresAt: first.approval.expiresAt,
  }, { projectId: "ovalo", workflow: "test", evidenceDigest, policyHash, expiresAt });
  const replay = await request(approval, "success");
  assert.equal(replay.replayed, true);
  await assert.rejects(request({ ...approval, evidenceDigest: "c".repeat(64) }, "success"),
    /different request content/i);

  const expectedBinding = {
    action: approval.action,
    exactEffect: approval.exactEffect,
    projectId: "ovalo",
    workflow: "test",
    evidenceDigest,
    policyHash,
    expiresAt,
  };
  await assert.rejects(store.resolveApprovalTransaction({
    approvalId: approval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
  }), /requires its exact expected action, effect, evidence, and policy binding/i);
  await assert.rejects(
    store.resolveApproval(approval.id, "approved", "approve", "wesley"),
    /requires its exact expected action, effect, evidence, and policy binding/i,
  );
  await assert.rejects(store.resolveApprovalTransaction({
    approvalId: approval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
    expectedBinding: { ...expectedBinding, action: "another_action" },
  }), /does not match the expected evidence and policy/i);
  await assert.rejects(store.resolveApprovalTransaction({
    approvalId: approval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
    expectedBinding: { ...expectedBinding, exactEffect: "A different exact effect" },
  }), /does not match the expected evidence and policy/i);
  await assert.rejects(store.resolveApprovalTransaction({
    approvalId: approval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
    expectedBinding: { ...expectedBinding, evidenceDigest: "c".repeat(64) },
  }), /does not match the expected evidence and policy/i);
  assert.equal((await store.getApproval(approval.id))?.state, "pending");

  const resolutionInput = {
    approvalId: approval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
    expectedBinding,
    runPatch: { status: "running" as const, stage: "finalize" },
    event: {
      id: `${prefix}_pilot_resolution_event`,
      runId: boundRun.id,
      type: "approval.decision_recorded",
      message: "Bound pilot approval granted",
      payload: { approvalId: approval.id },
      createdAt: new Date(clock.current()).toISOString(),
    },
  };
  const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
    store.resolveApprovalTransaction(resolutionInput)));
  assert.equal(concurrent.filter((item) => !item.replayed).length, 1);
  assert.equal(concurrent.filter((item) => item.replayed).length, 3);
  assert.equal((await store.getApproval(approval.id))?.state, "approved");
  const durableReplayInput = {
    ...resolutionInput,
    idempotency: {
      scope: "approval.resolve",
      key: `${prefix}-bound-resolution-replay`,
      requestHash: `${prefix}-bound-resolution-replay-hash`,
    },
  };
  assert.equal((await store.resolveApprovalTransaction(durableReplayInput)).replayed, true);

  const rejectedCases: Array<{ suffix: string; approval: Approval; pattern: RegExp }> = [];
  for (const suffix of ["project", "workflow", "partial", "past"] as const) {
    const candidateRun = run(`${prefix}_pilot_reject_${suffix}`, "running");
    await store.createRun(candidateRun);
    const candidate: Approval = {
      ...approval,
      id: `${prefix}_pilot_reject_approval_${suffix}`,
      runId: candidateRun.id,
      requestedAt: new Date(clock.current()).toISOString(),
      expiresAt: new Date(clock.current() + 60_000).toISOString(),
    };
    if (suffix === "project") candidate.projectId = "another-project";
    if (suffix === "workflow") candidate.workflow = "different-workflow";
    if (suffix === "partial") candidate.policyHash = null;
    if (suffix === "past") candidate.expiresAt = new Date(clock.current() - 1).toISOString();
    rejectedCases.push({
      suffix,
      approval: candidate,
      pattern: suffix === "project" ? /project binding does not match/i
        : suffix === "workflow" ? /workflow binding does not match/i
          : suffix === "partial" ? /binding must be complete/i
            : /must expire in the future/i,
    });
  }
  for (const item of rejectedCases) {
    await assert.rejects(request(item.approval, `reject_${item.suffix}`), item.pattern);
    assert.equal(await store.getApproval(item.approval.id), null);
    assert.equal((await store.getRun(item.approval.runId))?.status, "running");
  }

  const expiringRun = run(`${prefix}_pilot_expiring`, "running");
  await store.createRun(expiringRun);
  const expiringAt = new Date(clock.current() + 5_000).toISOString();
  const expiringApproval: Approval = {
    ...approval,
    id: `${prefix}_pilot_expiring_approval`,
    runId: expiringRun.id,
    requestedAt: new Date(clock.current()).toISOString(),
    expiresAt: expiringAt,
  };
  await request(expiringApproval, "expiring");
  clock.set(clock.current() + 5_001);
  assert.deepEqual(
    (await store.listExpiredApprovals("ovalo", "test", clock.now().toISOString(), 100)).map((item) => item.id),
    [expiringApproval.id],
  );
  assert.deepEqual(await store.listExpiredApprovals("ovalo", "another-workflow", clock.now().toISOString(), 100), []);
  await assert.rejects(
    store.listExpiredApprovals("ovalo", "test", clock.now().toISOString(), 0),
    /limit must be between 1 and 1000/i,
  );
  await assert.rejects(store.resolveApprovalTransaction({
    approvalId: expiringApproval.id,
    state: "approved",
    decision: "approve",
    resolvedBy: "wesley",
    // A caller-supplied time before expiry cannot bypass the store clock.
    resolvedAt: new Date(Date.parse(expiringAt) - 1).toISOString(),
    expectedBinding: { ...expectedBinding, expiresAt: expiringAt },
  }), /approval has expired/i);
  assert.equal((await store.getApproval(expiringApproval.id))?.state, "pending");

  const expiredAt = new Date(clock.current()).toISOString();
  const expiryInput = {
    approvalId: expiringApproval.id,
    runPatch: {
      status: "failed" as const,
      stage: "approval_expired",
      nextActionAt: null,
      completedAt: expiredAt,
    },
    event: {
      id: `${prefix}_pilot_expiry_event`,
      runId: expiringRun.id,
      type: "approval.expired",
      message: "Bound pilot approval expired",
      payload: { approvalId: expiringApproval.id },
      createdAt: expiredAt,
    },
    idempotency: {
      scope: "approval.expire",
      key: `${prefix}-pilot-expiry-key`,
      requestHash: `${prefix}-pilot-expiry-hash`,
    },
  };
  const expiryResults = await Promise.all(Array.from({ length: 4 }, () =>
    store.expireApprovalTransaction(expiryInput)));
  assert.equal(expiryResults.filter((item) => !item.replayed).length, 1);
  assert.equal(expiryResults.filter((item) => item.replayed).length, 3);
  const expired = await store.getApproval(expiringApproval.id);
  assert.equal(expired?.state, "denied");
  assert.equal(expired?.decision, "expired");
  assert.equal(expired?.resolvedBy, "control-plane");
  assert.equal(expired?.resolvedAt, expiredAt);
  assert.deepEqual({
    status: (await store.getRun(expiringRun.id))?.status,
    stage: (await store.getRun(expiringRun.id))?.stage,
    completedAt: (await store.getRun(expiringRun.id))?.completedAt,
  }, { status: "failed", stage: "approval_expired", completedAt: expiredAt });
  assert.equal((await store.listEvents(expiringRun.id)).some((event) => event.id === expiryInput.event.id), true);
  await assert.rejects(store.expireApprovalTransaction({
    ...expiryInput,
    idempotency: { ...expiryInput.idempotency, requestHash: `${prefix}-changed-expiry-hash` },
  }), IdempotencyConflictError);

  const futureRun = run(`${prefix}_pilot_future_expiry`, "running");
  await store.createRun(futureRun);
  const futureApproval: Approval = {
    ...approval,
    id: `${prefix}_pilot_future_expiry_approval`,
    runId: futureRun.id,
    requestedAt: expiredAt,
    expiresAt: new Date(clock.current() + 10_000).toISOString(),
  };
  await request(futureApproval, "future_expiry");
  await assert.rejects(store.expireApprovalTransaction({
    approvalId: futureApproval.id,
    runPatch: { status: "failed", completedAt: expiredAt },
    event: {
      id: `${prefix}_future_expiry_event`, runId: futureRun.id, type: "approval.expired",
      message: "Must not expire early", payload: {}, createdAt: expiredAt,
    },
  }), /has not expired/i);
  assert.equal((await store.getApproval(futureApproval.id))?.state, "pending");
  assert.equal((await store.getRun(futureRun.id))?.status, "awaiting_approval");

  const legacyRun = run(`${prefix}_legacy_expiry`, "running");
  await store.createRun(legacyRun);
  const legacyApproval = await requestPendingApproval(store, legacyRun.id, `${prefix}_legacy_expiry`);
  await assert.rejects(store.expireApprovalTransaction({
    approvalId: legacyApproval.id,
    runPatch: { status: "failed", completedAt: expiredAt },
    event: {
      id: `${prefix}_legacy_expiry_event`, runId: legacyRun.id, type: "approval.expired",
      message: "Must not expire a legacy approval", payload: {}, createdAt: expiredAt,
    },
  }), /complete bound pilot approval/i);
  await assert.rejects(store.expireApprovalTransaction({
    ...expiryInput,
    runPatch: { status: "running" } as any,
  }), /requires a terminal run patch/i);

  clock.set(Date.parse(expiresAt) + 1);
  assert.equal((await store.resolveApprovalTransaction(durableReplayInput)).replayed, true,
    "an exact durable replay remains idempotent after its approval deadline");
  await assert.rejects(store.resolveApprovalTransaction({
    ...resolutionInput,
    state: "denied",
    decision: "deny",
  }), /different decision/i);
  clock.set(startingTime);
}

async function exerciseScopedInferenceContract(store: ControlPlaneStore, prefix: string, clock: MutableStoreClock): Promise<void> {
  const startingTime = clock.current();
  const ownedRun = { ...run(`${prefix}_inference`, "running"), workflow: "atomic-fixture-model-pilot" };
  await store.createRun(ownedRun);
  const issuedAt = new Date(clock.current()).toISOString();
  const capability = {
    id: `${prefix}_capability`, runId: ownedRun.id, projectId: ownedRun.projectId,
    workflow: ownedRun.workflow!, tokenHash: "1".repeat(64), provider: "fake-provider", model: "fake-model",
    api: "openai-completions" as const, roles: ["implementer", "verifier_initial", "verifier_final"] as const,
    maxRequests: 5, maxInputTokens: 100, maxOutputTokens: 50, maxCostMicros: 1_000,
    maxElapsedMs: 5_000, issuedAt, expiresAt: new Date(clock.current() + 60_000).toISOString(),
    state: "active" as const, policyHash: "2".repeat(64),
  };
  assert.deepEqual(await store.createInferenceCapability({ ...capability, roles: [...capability.roles] }), { ...capability, roles: [...capability.roles] });
  assert.deepEqual(await store.createInferenceCapability({ ...capability, roles: [...capability.roles] }), { ...capability, roles: [...capability.roles] });
  await assert.rejects(store.createInferenceCapability({ ...capability, roles: [...capability.roles], model: "other-model" }), /different content/i);

  const firstInput = {
    id: `${prefix}_inference_request_1`, tokenHash: capability.tokenHash, runId: ownedRun.id,
    role: "implementer" as const, requestHash: "3".repeat(64), reservedAt: issuedAt,
  };
  const first = await store.reserveInferenceRequest(firstInput);
  assert.equal(first.replayed, false);
  assert.equal((await store.reserveInferenceRequest(firstInput)).replayed, true);
  await assert.rejects(store.reserveInferenceRequest({
    ...firstInput,
    id: `${prefix}_inference_request_concurrent_role`,
    requestHash: "e".repeat(64),
  }), /already has an active request/i);
  await assert.rejects(store.reserveInferenceRequest({
    ...firstInput, id: `${prefix}_wrong_role`, role: "repair", requestHash: "9".repeat(64),
  }), /role scope/i);
  const completed = await store.completeInferenceRequest({
    id: first.request.id, state: "completed", responseHash: "4".repeat(64), providerRequestId: `${prefix}_provider_1`,
    inputTokens: 40, outputTokens: 20, costMicros: 400, providerSessionId: `${prefix}_provider_session_shared`,
    providerSessionReused: false, completedAt: new Date(clock.current() + 1_000).toISOString(),
  });
  assert.equal(completed.request.providerSessionId, `${prefix}_provider_session_shared`);
  assert.equal(completed.request.providerSessionReused, false);
  assert.equal(completed.replayed, false);
  assert.equal((await store.completeInferenceRequest({
    id: first.request.id, state: "completed", responseHash: "4".repeat(64), providerRequestId: `${prefix}_provider_1`,
    inputTokens: 40, outputTokens: 20, costMicros: 400, providerSessionId: `${prefix}_provider_session_shared`,
    providerSessionReused: false, completedAt: new Date(clock.current() + 2_000).toISOString(),
  })).replayed, true);
  await assert.rejects(store.completeInferenceRequest({
    id: first.request.id, state: "completed", responseHash: "4".repeat(64), providerRequestId: `${prefix}_provider_1`,
    inputTokens: 40, outputTokens: 20, costMicros: 400, providerSessionId: `${prefix}_provider_session_shared`,
  }), /supplied together|differently/i);
  const sameRoleSecondTurn = await store.reserveInferenceRequest({
    id: `${prefix}_inference_request_same_role_2`, tokenHash: capability.tokenHash, runId: ownedRun.id,
    role: "implementer", requestHash: "8".repeat(64), reservedAt: issuedAt,
  });
  assert.equal(sameRoleSecondTurn.replayed, false, "a changed request hash in one role is a new bounded turn");
  await store.completeInferenceRequest({
    id: sameRoleSecondTurn.request.id, state: "completed", responseHash: "a".repeat(64),
    providerRequestId: `${prefix}_provider_same_role_2`, inputTokens: 10, outputTokens: 5,
    costMicros: 50, providerSessionId: `${prefix}_provider_session_shared`, providerSessionReused: true,
    completedAt: new Date(clock.current() + 1_500).toISOString(),
  });
  const second = await store.reserveInferenceRequest({
    id: `${prefix}_inference_request_2`, tokenHash: capability.tokenHash, runId: ownedRun.id,
    role: "verifier_initial", requestHash: "5".repeat(64), reservedAt: issuedAt,
  });
  await assert.rejects(store.completeInferenceRequest({
    id: second.request.id, state: "completed", responseHash: "6".repeat(64), inputTokens: 51,
    outputTokens: 1, costMicros: 1, completedAt: new Date(clock.current() + 2_000).toISOString(),
  }), /aggregate token or cost budget/i);
  await store.completeInferenceRequest({
    id: second.request.id, state: "failed", failureCode: "upstream_timeout", inputTokens: 0,
    outputTokens: 0, costMicros: 0, completedAt: new Date(clock.current() + 2_000).toISOString(),
  });
  const differentRole = await store.reserveInferenceRequest({
    id: `${prefix}_inference_request_different_role`, tokenHash: capability.tokenHash, runId: ownedRun.id,
    role: "verifier_final", requestHash: "b".repeat(64), reservedAt: issuedAt,
  });
  const differentRoleCompleted = await store.completeInferenceRequest({
    id: differentRole.request.id, state: "completed", responseHash: "c".repeat(64),
    providerRequestId: `${prefix}_provider_different_role`, inputTokens: 1, outputTokens: 1, costMicros: 1,
    providerSessionId: `${prefix}_provider_session_other_role`, providerSessionReused: false,
    completedAt: new Date(clock.current() + 2_500).toISOString(),
  });
  assert.equal(differentRoleCompleted.request.providerSessionReused, false);
  await assert.rejects(store.completeInferenceRequest({
    id: differentRole.request.id, state: "completed", responseHash: "c".repeat(64),
    providerRequestId: `${prefix}_provider_different_role`, inputTokens: 1, outputTokens: 1, costMicros: 1,
    providerSessionId: `${prefix}_provider_session_other_role`, providerSessionReused: true,
  }), /differently/i);
  const invalidSession = await store.reserveInferenceRequest({
    id: `${prefix}_inference_request_invalid_session`, tokenHash: capability.tokenHash, runId: ownedRun.id,
    role: "verifier_final", requestHash: "d".repeat(64), reservedAt: issuedAt,
  });
  await assert.rejects(store.completeInferenceRequest({
    id: invalidSession.request.id, state: "failed", failureCode: "upstream_timeout", inputTokens: 0,
    outputTokens: 0, costMicros: 0, providerSessionId: `${prefix}_provider_session_other_role`, providerSessionReused: false,
  }), /failed.*session/i);
  await store.completeInferenceRequest({
    id: invalidSession.request.id, state: "failed", failureCode: "upstream_timeout", inputTokens: 0,
    outputTokens: 0, costMicros: 0,
  });
  assert.equal((await store.getInferenceCapability(capability.id))?.state, "exhausted");
  assert.equal((await store.listInferenceRequests(ownedRun.id)).length, 5);
  assert.equal((await store.revokeInferenceCapability(capability.id))?.state, "exhausted");

  const expiring = {
    ...capability,
    id: `${prefix}_capability_expiring`,
    tokenHash: "7".repeat(64),
    roles: ["verifier_final" as const],
    maxRequests: 1,
    expiresAt: new Date(clock.current() + 30_000).toISOString(),
  };
  await store.createInferenceCapability(expiring);
  assert.deepEqual(await store.expireInferenceCapabilities(new Date(clock.current() + 29_999).toISOString(), 1), []);
  clock.set(clock.current() + 30_000);
  const expired = await store.expireInferenceCapabilities(new Date(clock.current()).toISOString(), 1);
  assert.deepEqual(expired.map((item) => [item.id, item.state]), [[expiring.id, "expired"]]);
  assert.deepEqual(await store.expireInferenceCapabilities(new Date(clock.current()).toISOString(), 1), [], "expiry maintenance replays without duplicate closure");
  assert.ok((await store.listPendingOutbox()).some((event) =>
    event.topic === "inference.capability.closed" && event.aggregateId === expiring.id));
  clock.set(startingTime);
}

async function exercisePostgresApprovalLockExpiry(
  store: ControlPlaneStore,
  databaseUrl: string,
  clock: MutableStoreClock,
): Promise<void> {
  const startingTime = clock.current();
  const owningRun = run("postgres_pilot_lock_expiry", "running");
  await store.createRun(owningRun);
  const expiresAt = new Date(startingTime + 1_000).toISOString();
  const approval: Approval = {
    id: "postgres_pilot_lock_expiry_approval",
    runId: owningRun.id,
    action: "accept_atomic_fixture_result",
    exactEffect: "Record one safe mock receipt only",
    state: "pending",
    evidence: ["artifact digest"],
    requestedAt: new Date(startingTime).toISOString(),
    projectId: owningRun.projectId,
    workflow: owningRun.workflow,
    evidenceDigest: "d".repeat(64),
    policyHash: "e".repeat(64),
    expiresAt,
  };
  await store.requestApprovalTransaction({
    approval,
    event: {
      id: "postgres_pilot_lock_expiry_requested",
      runId: owningRun.id,
      type: "approval.requested",
      message: "Lock crossing expiry fixture",
      payload: {},
      createdAt: approval.requestedAt,
    },
  });
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM approvals WHERE id=$1 FOR UPDATE", [approval.id]);
    const resolution = store.resolveApprovalTransaction({
      approvalId: approval.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "wesley",
      expectedBinding: {
        action: approval.action,
        exactEffect: approval.exactEffect,
        projectId: approval.projectId!,
        workflow: approval.workflow!,
        evidenceDigest: approval.evidenceDigest!,
        policyHash: approval.policyHash!,
        expiresAt,
      },
    });
    const rejected = assert.rejects(resolution, /approval has expired/i);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    clock.set(startingTime + 1_001);
    await client.query("COMMIT");
    await rejected;
    assert.equal((await store.getApproval(approval.id))?.state, "pending");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
    clock.set(startingTime);
  }
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

async function exerciseFencedWriterLeaseContract(
  store: ControlPlaneStore,
  prefix: string,
  clock: MutableStoreClock,
): Promise<void> {
  const base = clock.current();
  const expiredCreation = run(`${prefix}_already_expired`, "running");
  const expiredCreationBundle = workspaceBundle(
    expiredCreation.id,
    `${prefix}_already_expired`,
    new Date(base - 1_000).toISOString(),
  );
  expiredCreationBundle.lease.heartbeatAt = new Date(base - 2_000).toISOString();
  await assert.rejects(
    store.createRunBundle({ run: expiredCreation, ...expiredCreationBundle }),
    /expiry must be after observed storage time/i,
  );
  assert.equal(await store.getRun(expiredCreation.id), null);
  const overlongCreation = run(`${prefix}_overlong_lease`, "running");
  const overlongBundle = workspaceBundle(
    overlongCreation.id,
    `${prefix}_overlong_lease`,
    new Date(base + 24 * 60 * 60 * 1000 + 1).toISOString(),
  );
  overlongBundle.lease.heartbeatAt = new Date(base).toISOString();
  await assert.rejects(
    store.createRunBundle({ run: overlongCreation, ...overlongBundle }),
    /may not exceed 24 hours/i,
  );
  assert.equal(await store.getRun(overlongCreation.id), null);

  const terminalClaimRun = run(`${prefix}_terminal_workspace_claim`, "failed");
  await store.createRun(terminalClaimRun);
  const terminalClaimBundle = workspaceBundle(
    terminalClaimRun.id,
    `${prefix}_terminal_workspace_claim`,
    new Date(base + 60_000).toISOString(),
  );
  terminalClaimBundle.lease.heartbeatAt = new Date(base).toISOString();
  await assert.rejects(
    store.createWorkspaceLease(terminalClaimBundle.workspace, terminalClaimBundle.lease),
    /only by a queued run/i,
  );
  assert.equal(await store.getWorkspace(terminalClaimBundle.workspace.id), null);
  assert.equal((await store.getRun(terminalClaimRun.id))?.workspaceId, null);

  const initialHeartbeat = new Date(base).toISOString();
  const initialExpiry = new Date(base + 60_000).toISOString();
  const item = run(`${prefix}_fenced`, "running");
  const bundle = workspaceBundle(item.id, `${prefix}_fenced`, initialExpiry);
  bundle.lease.ownerId = `${prefix}-worker-a`;
  bundle.lease.heartbeatAt = initialHeartbeat;
  const created = await store.createRunBundle({ run: item, ...bundle });
  const initial = created.lease!;
  assert.equal(initial.fencingToken, 1);
  assert.equal(initial.ownerId, `${prefix}-worker-a`);
  assert.equal(initial.state, "active");
  assert.equal(initial.acquiredAt, initialHeartbeat);
  assert.equal(initial.quarantinedAt, null);
  assert.equal(initial.quarantineReason, null);

  clock.set(base + 10_000);
  const renewed = await store.renewWorkspaceLease({
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: initial.ownerId,
    fencingToken: initial.fencingToken,
    heartbeatAt: new Date(base + 10_000).toISOString(),
    expiresAt: new Date(base + 70_000).toISOString(),
  });
  assert.equal(renewed?.fencingToken, initial.fencingToken);
  assert.equal(renewed?.heartbeatAt, new Date(base + 10_000).toISOString());
  assert.equal(await store.renewWorkspaceLease({
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: `${prefix}-stale-owner`,
    fencingToken: initial.fencingToken,
    heartbeatAt: new Date(base + 20_000).toISOString(),
    expiresAt: new Date(base + 80_000).toISOString(),
  }), null);
  assert.equal(await store.renewWorkspaceLease({
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: initial.ownerId,
    fencingToken: initial.fencingToken + 1,
    heartbeatAt: new Date(base + 20_000).toISOString(),
    expiresAt: new Date(base + 80_000).toISOString(),
  }), null);
  assert.equal(await store.renewWorkspaceLease({
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: initial.ownerId,
    fencingToken: initial.fencingToken,
    heartbeatAt: new Date(base + 20_000).toISOString(),
    expiresAt: new Date(base + 65_000).toISOString(),
  }), null, "a renewal must not shorten the expiry");
  await assert.rejects(store.rotateWorkspaceLease({
    ...bundle.lease,
    ownerId: `${prefix}-worker-b`,
    heartbeatAt: new Date(base + 20_000).toISOString(),
    expiresAt: new Date(base + 80_000).toISOString(),
  }), /unexpired writer lease cannot be rotated/i);

  clock.set(base + 30_000);
  const quarantineInput = {
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: initial.ownerId,
    fencingToken: initial.fencingToken,
    quarantinedAt: new Date(base + 30_000).toISOString(),
    reason: "runner heartbeat expired; awaiting sandbox cleanup",
  };
  assert.equal(await store.quarantineWorkspaceLease({ ...quarantineInput, fencingToken: initial.fencingToken + 1 }), null);
  const quarantined = await store.quarantineWorkspaceLease(quarantineInput);
  assert.equal(quarantined?.state, "quarantined");
  assert.equal(quarantined?.quarantineReason, quarantineInput.reason);
  assert.equal((await store.getWorkspace(initial.workspaceId))?.status, "quarantined");
  assert.equal((await store.listLeases()).some((lease) => lease.workspaceId === initial.workspaceId), false);
  assert.equal((await store.listReconciliationCandidates(new Date(base + 31_000).toISOString())).quarantinedLeases
    .some((lease) => lease.workspaceId === initial.workspaceId), true);
  assert.deepEqual(await store.quarantineWorkspaceLease(quarantineInput), quarantined);
  await assert.rejects(store.quarantineWorkspaceLease({ ...quarantineInput, reason: "different evidence" }), /different evidence/i);
  assert.equal(await store.renewWorkspaceLease({
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: initial.ownerId,
    fencingToken: initial.fencingToken,
    heartbeatAt: new Date(base + 40_000).toISOString(),
    expiresAt: new Date(base + 100_000).toISOString(),
  }), null);
  assert.equal(await store.releaseWorkspaceLease({ ...quarantineInput, fencingToken: initial.fencingToken + 1 }), false);
  assert.equal(await store.releaseWorkspaceLease(initial), true);
  assert.equal(await store.getWorkspaceLease(initial.workspaceId), null);
  assert.equal((await store.getWorkspace(initial.workspaceId))?.status, "released");

  await assert.rejects(store.rotateWorkspaceLease({
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: `${prefix}-already-expired-rotation`,
    mode: "writer",
    heartbeatAt: new Date(base + 28_000).toISOString(),
    expiresAt: new Date(base + 29_000).toISOString(),
  }), /expiry must be after observed storage time/i);

  const expiringRequest: WriterLeaseRequest = {
    workspaceId: initial.workspaceId,
    runId: initial.runId,
    ownerId: `${prefix}-worker-b`,
    mode: "writer",
    heartbeatAt: new Date(base + 30_000).toISOString(),
    expiresAt: new Date(base + 40_000).toISOString(),
  };
  const expiring = await store.rotateWorkspaceLease(expiringRequest);
  assert.equal(expiring.fencingToken, initial.fencingToken + 1);
  await assert.rejects(store.rotateWorkspaceLease({
    ...expiringRequest,
    ownerId: `${prefix}-future-claimant`,
    heartbeatAt: new Date(base + 50_000).toISOString(),
    expiresAt: new Date(base + 110_000).toISOString(),
  }), /unexpired writer lease cannot be rotated/i, "a future caller heartbeat cannot rotate a wall-clock-active lease");
  assert.equal((await store.renewWorkspaceLease({
    workspaceId: expiring.workspaceId,
    runId: expiring.runId,
    ownerId: expiring.ownerId,
    fencingToken: expiring.fencingToken,
    heartbeatAt: new Date(base + 35_000).toISOString(),
    expiresAt: new Date(base + 40_000).toISOString(),
  }))?.fencingToken, expiring.fencingToken);

  clock.set(base + 41_000);
  assert.equal(await store.renewWorkspaceLease({
    workspaceId: expiring.workspaceId,
    runId: expiring.runId,
    ownerId: expiring.ownerId,
    fencingToken: expiring.fencingToken,
    heartbeatAt: new Date(base + 36_000).toISOString(),
    expiresAt: new Date(base + 120_000).toISOString(),
  }), null, "a wall-clock-expired lease cannot renew with a stale caller heartbeat");
  const rotationAttempts = await Promise.allSettled([
    store.rotateWorkspaceLease({
      ...expiringRequest,
      ownerId: `${prefix}-worker-c`,
      heartbeatAt: new Date(base + 41_000).toISOString(),
      expiresAt: new Date(base + 101_000).toISOString(),
    }),
    store.rotateWorkspaceLease({
      ...expiringRequest,
      ownerId: `${prefix}-worker-d`,
      heartbeatAt: new Date(base + 41_000).toISOString(),
      expiresAt: new Date(base + 101_000).toISOString(),
    }),
  ]);
  assert.equal(rotationAttempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(rotationAttempts.filter((result) => result.status === "rejected").length, 1);
  const rotated = rotationAttempts.find((result) => result.status === "fulfilled")!.value;
  assert.equal(rotated.fencingToken, expiring.fencingToken + 1);
  assert.equal(await store.releaseWorkspaceLease(expiring), false, "an expired stale token cannot release after rotation");
  assert.equal(await store.releaseWorkspaceLease(rotated), true);

  const leaseOutbox = (await store.listPendingOutbox()).filter((event) => event.aggregateId === initial.workspaceId);
  assert.ok(leaseOutbox.some((event) => event.topic === "workspace.lease.quarantined"));
  assert.ok(leaseOutbox.some((event) => event.topic === "workspace.lease.rotated"));
  assert.ok(leaseOutbox.some((event) => event.topic === "workspace.lease.released"));
}

async function exerciseArtifactBatchContract(store: ControlPlaneStore, prefix: string): Promise<void> {
  const ownerRun = run(`${prefix}_artifact_owner`, "running");
  const foreignRun = run(`${prefix}_artifact_foreign`, "running");
  await store.createRun(ownerRun);
  await store.createRun(foreignRun);
  const createdAt = new Date().toISOString();
  const artifact = (suffix: string, runId = ownerRun.id): Artifact => ({
    id: `${prefix}_artifact_${suffix}`,
    runId,
    kind: "test-evidence",
    uri: `artifact://${prefix}/${suffix}`,
    checksum: `sha256:${prefix}:${suffix}`,
    mediaType: "application/json",
    createdAt,
  });
  const batch = [artifact("one"), artifact("two")];
  const created = await store.createArtifactBatch(batch);
  assert.equal(created.replayed, false);
  assert.deepEqual(created.artifacts, batch);
  const replay = await store.createArtifactBatch(batch);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.artifacts, batch);
  assert.equal((await store.listArtifacts(ownerRun.id)).length, 2);
  assert.equal((await store.listPendingOutbox()).filter((event) =>
    batch.some((item) => item.id === event.aggregateId) && event.topic === "artifact.created"
  ).length, 2);

  const changedFields: Array<keyof Omit<Artifact, "id">> = [
    "runId", "kind", "uri", "checksum", "mediaType", "createdAt",
  ];
  for (const field of changedFields) {
    const changed: Artifact = {
      ...batch[0],
      [field]: field === "runId"
        ? foreignRun.id
        : field === "createdAt"
          ? new Date(Date.parse(createdAt) + 1_000).toISOString()
          : `${batch[0][field]}-changed`,
    };
    await assert.rejects(store.createArtifactBatch([changed]), /different content/i);
  }

  const rollbackCandidate = artifact("rollback-new");
  await assert.rejects(store.createArtifactBatch([
    rollbackCandidate,
    { ...batch[0], checksum: "sha256:changed-mid-batch" },
  ]), /different content/i);
  assert.equal((await store.listArtifacts(ownerRun.id)).some((item) => item.id === rollbackCandidate.id), false);
  assert.equal((await store.listPendingOutbox()).some((event) => event.aggregateId === rollbackCandidate.id), false);

  const foreignExisting = artifact("owned-by-foreign", foreignRun.id);
  await store.createArtifact(foreignExisting);
  const foreignRollbackCandidate = artifact("foreign-rollback-new");
  await assert.rejects(store.createArtifactBatch([
    foreignRollbackCandidate,
    { ...foreignExisting, runId: ownerRun.id },
  ]), /different content/i);
  assert.equal((await store.listArtifacts(ownerRun.id)).some((item) => item.id === foreignRollbackCandidate.id), false);
  assert.equal((await store.listPendingOutbox()).some((event) => event.aggregateId === foreignRollbackCandidate.id), false);

  const mixedRunCandidate = artifact("mixed-run-new");
  await assert.rejects(store.createArtifactBatch([
    mixedRunCandidate,
    artifact("mixed-run-foreign", foreignRun.id),
  ]), /same run/i);
  assert.equal((await store.listArtifacts(ownerRun.id)).some((item) => item.id === mixedRunCandidate.id), false);
  await assert.rejects(store.createArtifactBatch([batch[0], batch[0]]), /duplicate id/i);
  await assert.rejects(store.createArtifactBatch([]), /between 1 and 1000/i);

  const concurrentBatch = [artifact("concurrent-one"), artifact("concurrent-two")];
  const concurrent = await Promise.all([
    store.createArtifactBatch(concurrentBatch),
    store.createArtifactBatch(concurrentBatch),
  ]);
  assert.equal(concurrent.filter((result) => result.replayed).length, 1);
  assert.equal(concurrent.filter((result) => !result.replayed).length, 1);
  assert.equal((await store.listArtifacts(ownerRun.id)).filter((item) =>
    concurrentBatch.some((artifact) => artifact.id === item.id)
  ).length, 2);
}

test("SQLite migrations are explicit, repeatable, and current", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const first = await store.migrate();
    assert.deepEqual(first.map((item) => [item.version, item.status]), loadMigrationFiles("sqlite").map((item) => [item.version, "applied"]));
    const second = await store.migrate();
    assert.deepEqual(second.map((item) => item.status), loadMigrationFiles("sqlite").map(() => "already_applied"));
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
    assert.deepEqual(applied.map((item) => item.status), loadMigrationFiles("sqlite").map(() => "applied"));
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

test("SQLite forward migration backfills and preserves an existing writer lease fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-fence-backfill-"));
  const path = join(root, "version-3.sqlite");
  const heartbeatAt = "2026-08-11T00:00:00.000Z";
  try {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL
    )`);
    const migrations = loadMigrationFiles("sqlite").filter((migration) => migration.version <= 3);
    for (const migration of migrations) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)")
        .run(migration.version, migration.name, migration.checksum, heartbeatAt);
    }
    db.prepare(`INSERT INTO projects
      (id,name,objective,current_milestone,health,linear_team,repository,vault_path,memory_namespace,created_at)
      VALUES ('ovalo','Ovalo','Objective','Milestone','on_track','OVA','repo','vault','namespace',?)`).run(heartbeatAt);
    db.prepare(`INSERT INTO runs
      (id,project_id,root_runtime,workflow,status,stage_index,budget_usd,cost_usd,workspace_id,metadata_json,created_at)
      VALUES ('legacy_fenced_run','ovalo','atomic','test','running',0,8,0,NULL,'{}',?)`).run(heartbeatAt);
    db.prepare(`INSERT INTO workspaces(id,run_id,path,provider,status,created_at)
      VALUES ('legacy_fenced_ws','legacy_fenced_run','/tmp/legacy-fenced','test','leased',?)`).run(heartbeatAt);
    db.prepare(`INSERT INTO workspace_leases(workspace_id,run_id,mode,expires_at,heartbeat_at)
      VALUES ('legacy_fenced_ws','legacy_fenced_run','writer','2026-08-11T01:00:00.000Z',?)`).run(heartbeatAt);
    db.prepare(`INSERT INTO approvals
      (id,run_id,action,exact_effect,state,evidence_json,requested_at)
      VALUES ('legacy_nullable_approval','legacy_fenced_run','prepare_pr','Legacy mock only','pending','[]',?)`)
      .run(heartbeatAt);
    db.prepare("UPDATE runs SET workspace_id='legacy_fenced_ws' WHERE id='legacy_fenced_run'").run();
    db.close();

    const store = new SqliteStore(path);
    const migrationOutput = await store.migrate();
    assert.equal(migrationOutput.find((item) => item.version === 4)?.status, "applied");
    assert.deepEqual(await store.getWorkspaceLease("legacy_fenced_ws"), {
      workspaceId: "legacy_fenced_ws",
      runId: "legacy_fenced_run",
      ownerId: "legacy_fenced_run",
      mode: "writer",
      fencingToken: 1,
      state: "active",
      expiresAt: "2026-08-11T01:00:00.000Z",
      heartbeatAt,
      acquiredAt: heartbeatAt,
      quarantinedAt: null,
      quarantineReason: null,
    });
    const legacyApproval = await store.getApproval("legacy_nullable_approval");
    assert.deepEqual({
      projectId: legacyApproval?.projectId,
      workflow: legacyApproval?.workflow,
      evidenceDigest: legacyApproval?.evidenceDigest,
      policyHash: legacyApproval?.policyHash,
      expiresAt: legacyApproval?.expiresAt,
    }, { projectId: null, workflow: null, evidenceDigest: null, policyHash: null, expiresAt: null });
    await store.close();

    const inspected = new DatabaseSync(path);
    assert.equal((inspected.prepare("SELECT lease_epoch FROM workspaces WHERE id='legacy_fenced_ws'").get() as any).lease_epoch, 1);
    assert.throws(
      () => inspected.prepare("UPDATE workspaces SET lease_epoch=0 WHERE id='legacy_fenced_ws'").run(),
      /lease epoch cannot decrease/i,
    );
    inspected.close();
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
    db.prepare("UPDATE workspaces SET lease_epoch=1 WHERE id=?").run(workspace.id);
    assert.throws(
      () => db.prepare(`INSERT INTO workspace_leases
        (workspace_id,run_id,owner_id,mode,fencing_token,state,expires_at,heartbeat_at,acquired_at)
        VALUES (?,?,?,?,?,'active',?,?,?)`).run(
          workspace.id, "sqlite_intruder", "intruder", "writer", 1,
          new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), new Date().toISOString(),
        ),
      /workspace lease owner mismatch|invalid fenced workspace lease/i,
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

test("SQLite writer leases are renewable, fenced, quarantinable, and monotonically rotated", async () => {
  const clock = mutableStoreClock();
  const store = new SqliteStore(":memory:", { now: clock.now });
  try {
    await seed(store);
    await exerciseFencedWriterLeaseContract(store, "sqlite", clock);
  } finally {
    await store.close();
  }
});

test("SQLite sandbox instances enforce exact fenced lifecycle transitions", async () => {
  const clock = mutableStoreClock();
  const store = new SqliteStore(":memory:", { now: clock.now });
  try {
    await seed(store);
    await exerciseSandboxInstanceContract(store, "sqlite", clock);
    await exerciseComparisonContract(store, "sqlite", clock);
    await exerciseEngineeringRoutingAssessmentContract(store, "sqlite", clock);
  } finally {
    await store.close();
  }
});

test("SQLite artifact batches replay exactly and roll back artifacts with their outboxes", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await seed(store);
    await exerciseArtifactBatchContract(store, "sqlite");
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

test("queued-run start claims are exact-state, expiring compare-and-set claims", async () => {
  const clock = mutableStoreClock();
  const store = new SqliteStore(":memory:", { now: clock.now });
  try {
    await seed(store);
    await exerciseQueuedStartClaimContract(store, "sqlite", clock);
    await exerciseRunAdmissionContract(store, "sqlite");
  } finally {
    await store.close();
  }
});

test("pilot approvals bind project, workflow, evidence, policy, and authoritative expiry", async () => {
  const clock = mutableStoreClock();
  const store = new SqliteStore(":memory:", { now: clock.now });
  try {
    await seed(store);
    await exercisePilotApprovalBindingContract(store, "sqlite", clock);
    await exerciseScopedInferenceContract(store, "sqlite", clock);
  } finally {
    await store.close();
  }
});

test("restart reconciliation identifies queued runs, terminal and expired leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-restart-"));
  const path = join(root, "test.sqlite");
  const clock = mutableStoreClock();
  const base = clock.current();
  try {
    let store = new SqliteStore(path, { now: clock.now });
    await seed(store);
    await store.createRun(run("run_queued"));
    const completed = run("run_terminal", "completed");
    const completedWorkspace = workspaceBundle(completed.id);
    await store.createRunBundle({ run: completed, ...completedWorkspace });
    const active = run("run_expired", "running", new Date(base + 20_000).toISOString());
    const expiredWorkspace = workspaceBundle(active.id, active.id, new Date(base + 10_000).toISOString());
    expiredWorkspace.lease.heartbeatAt = new Date(base).toISOString();
    await store.createRunBundle({ run: active, ...expiredWorkspace });
    await store.close();

    clock.set(base + 20_000);
    store = new SqliteStore(path, { now: clock.now });
    const candidates = await store.listReconciliationCandidates(clock.now().toISOString());
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

async function preparePostgresVersion3LeaseFixture(databaseUrl: string): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const heartbeatAt = "2026-08-11T00:00:00.000Z";
  try {
    await pool.query(`CREATE TABLE schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const migration of loadMigrationFiles("postgres").filter((item) => item.version <= 3)) {
      await pool.query("BEGIN");
      try {
        await pool.query(migration.sql);
        await pool.query("INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)", [
          migration.version, migration.name, migration.checksum,
        ]);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
    await pool.query("BEGIN");
    try {
      await pool.query(`INSERT INTO projects
        (id,name,objective,current_milestone,health,linear_team,repository,vault_path,memory_namespace,created_at)
        VALUES ('ovalo','Ovalo','Objective','Milestone','on_track','OVA','repo','vault','namespace',$1)`, [heartbeatAt]);
      await pool.query(`INSERT INTO runs
        (id,project_id,root_runtime,workflow,status,stage_index,budget_usd,cost_usd,workspace_id,metadata_json,created_at)
        VALUES ('pg_legacy_fenced_run','ovalo','atomic','test','running',0,8,0,NULL,'{}',$1)`, [heartbeatAt]);
      await pool.query(`INSERT INTO workspaces(id,run_id,path,provider,status,created_at)
        VALUES ('pg_legacy_fenced_ws','pg_legacy_fenced_run','/tmp/pg-legacy-fenced','test','leased',$1)`, [heartbeatAt]);
      await pool.query(`INSERT INTO workspace_leases(workspace_id,run_id,mode,expires_at,heartbeat_at)
        VALUES ('pg_legacy_fenced_ws','pg_legacy_fenced_run','writer','2026-08-11T01:00:00.000Z',$1)`, [heartbeatAt]);
      await pool.query(`INSERT INTO approvals
        (id,run_id,action,exact_effect,state,evidence_json,requested_at)
        VALUES ('pg_legacy_nullable_approval','pg_legacy_fenced_run','prepare_pr','Legacy mock only','pending','[]',$1)`, [heartbeatAt]);
      await pool.query("UPDATE runs SET workspace_id='pg_legacy_fenced_ws' WHERE id='pg_legacy_fenced_run'");
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  } finally {
    await pool.end();
  }
}

test("PostgreSQL storage contract smoke", { skip: !postgresUrl }, async () => {
  await preparePostgresVersion3LeaseFixture(postgresUrl!);
  const clock = mutableStoreClock();
  let store = await PostgresStore.connect({
    databaseUrl: postgresUrl!, autoMigrate: true, maxConnections: 8, now: clock.now,
  });
  try {
    const migrationOutput = await store.migrate();
    const postgresMigrations = loadMigrationFiles("postgres");
    assert.deepEqual(migrationOutput.map((item) => item.version), postgresMigrations.map((item) => item.version));
    const repeatedMigrations = await store.migrate();
    assert.deepEqual(repeatedMigrations.map((item) => item.status), postgresMigrations.map(() => "already_applied"));
    assert.deepEqual(await store.healthCheck(), { ok: true, backend: "postgres", migrationsCurrent: true });
    assert.deepEqual(await store.getWorkspaceLease("pg_legacy_fenced_ws"), {
      workspaceId: "pg_legacy_fenced_ws",
      runId: "pg_legacy_fenced_run",
      ownerId: "pg_legacy_fenced_run",
      mode: "writer",
      fencingToken: 1,
      state: "active",
      expiresAt: "2026-08-11T01:00:00.000Z",
      heartbeatAt: "2026-08-11T00:00:00.000Z",
      acquiredAt: "2026-08-11T00:00:00.000Z",
      quarantinedAt: null,
      quarantineReason: null,
    });
    const legacyApproval = await store.getApproval("pg_legacy_nullable_approval");
    assert.deepEqual({
      projectId: legacyApproval?.projectId,
      workflow: legacyApproval?.workflow,
      evidenceDigest: legacyApproval?.evidenceDigest,
      policyHash: legacyApproval?.policyHash,
      expiresAt: legacyApproval?.expiresAt,
    }, { projectId: null, workflow: null, evidenceDigest: null, policyHash: null, expiresAt: null });

    await store.resetOperationalData();
    await seed(store);
    await exerciseFencedWriterLeaseContract(store, "postgres", clock);
    await exerciseSandboxInstanceContract(store, "postgres", clock);
    await exerciseComparisonContract(store, "postgres", clock);
    await exerciseEngineeringRoutingAssessmentContract(store, "postgres", clock);
    await exerciseArtifactBatchContract(store, "postgres");
    await exerciseApprovalRequestContract(store, "postgres");
    await exerciseMismatchedApprovalEventContract(store, "postgres");
    await exerciseQueuedStartClaimContract(store, "postgres", clock);
    await exerciseRunAdmissionContract(store, "postgres");
    await exercisePilotApprovalBindingContract(store, "postgres", clock);
    await exerciseScopedInferenceContract(store, "postgres", clock);
    await exercisePostgresApprovalLockExpiry(store, postgresUrl!, clock);
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
    await direct.query("UPDATE workspaces SET lease_epoch=1 WHERE id=$1", [directWorkspace.id]);
    await assert.rejects(
      direct.query(`INSERT INTO workspace_leases
        (workspace_id,run_id,owner_id,mode,fencing_token,state,expires_at,heartbeat_at,acquired_at)
        VALUES ($1,$2,'intruder','writer',1,'active',now()+interval '1 minute',now(),now())`,
        [directWorkspace.id, directIntruder.id]),
      /fk_workspace_lease_owner|foreign key/i,
    );
    await direct.end();

    const rollbackRun = run("pg_rollback");
    const conflictingWorkspace: WorkspaceRecord = {
      ...winnerWorkspace, runId: rollbackRun.id, path: "/tmp/pg-rollback",
    };
    const conflictingLease: WriterLeaseRequest = {
      workspaceId: winnerWorkspace.id, runId: rollbackRun.id, ownerId: "owner_pg_rollback", mode: "writer",
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
    assert.equal((await store.listPendingOutbox(1_000)).filter((value) =>
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
    const reconciliationBase = clock.current();
    const expired = run("pg_expired", "running", new Date(reconciliationBase + 20_000).toISOString());
    const expiredBundle = workspaceBundle(expired.id, expired.id, new Date(reconciliationBase + 10_000).toISOString());
    expiredBundle.lease.heartbeatAt = new Date(reconciliationBase).toISOString();
    await store.createRunBundle({
      run: expired,
      ...expiredBundle,
    });

    await store.close();
    clock.set(reconciliationBase + 20_000);
    store = await PostgresStore.connect({
      databaseUrl: postgresUrl!, autoMigrate: false, maxConnections: 4, now: clock.now,
    });
    const reconciliation = await store.listReconciliationCandidates(clock.now().toISOString());
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
    store = await PostgresStore.connect({
      databaseUrl: postgresUrl!, autoMigrate: false, maxConnections: 4, now: clock.now,
    });
  } finally {
    await store.resetOperationalData().catch(() => undefined);
    await store.close().catch(() => undefined);
  }
});
