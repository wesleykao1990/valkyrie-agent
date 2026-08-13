import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { canonicalJson } from "../apps/control-plane/src/store.ts";
import {
  ExternalFinalActionCoordinator,
  ExternalFinalActionError,
} from "../apps/control-plane/src/external-final-action.ts";
import type { Artifact, Run } from "../apps/control-plane/src/types.ts";

const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);
const NEXT_HEAD_OID = "c".repeat(40);
const POLICY_HASH = "d".repeat(64);
const CONNECTOR_POLICY_DIGEST = "9".repeat(64);
const AT = "2026-08-13T00:00:00.000Z";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactDigest(artifacts: readonly Artifact[]): string {
  return sha(canonicalJson(artifacts.map((item) => ({
    id: item.id, kind: item.kind, uri: item.uri, checksum: item.checksum, mediaType: item.mediaType,
  })).sort((left, right) => left.kind.localeCompare(right.kind) || left.uri.localeCompare(right.uri) || left.id.localeCompare(right.id))));
}

function makeRun(id: string, projectId = "project_1", workflow = "workflow_1"): Run {
  return {
    id,
    taskId: null,
    projectId,
    rootRuntime: "atomic",
    workflow,
    status: "completed",
    stage: "evidence",
    stageIndex: 3,
    budgetUsd: 10,
    costUsd: 1,
    workspaceId: null,
    nativeRunId: null,
    nextActionAt: null,
    startedAt: AT,
    completedAt: AT,
    metadata: {},
    createdAt: AT,
  };
}

function makeArtifact(runId: string, suffix = "report"): Artifact {
  return {
    id: `artifact_${suffix}`,
    runId,
    kind: suffix,
    uri: `artifact://runs/${runId}/${suffix}.json`,
    checksum: "e".repeat(64),
    mediaType: "application/json",
    createdAt: AT,
  };
}

class FakeGitAuthority {
  readonly policy = {
    projectId: "project_1",
    repositoryIdentity: "github.com/acme/project",
    baseRef: "main",
    headRef: "feature/remote",
    policyDigest: "f".repeat(64),
    checkPolicyDigest: "1".repeat(64),
  };
  snapshot = {
    provider: "git" as const,
    projectId: "project_1",
    repositoryIdentity: "github.com/acme/project",
    remoteUrlIdentity: "github.com/acme/project",
    baseRef: "main",
    baseCommit: BASE_OID,
    baseTree: "2".repeat(40),
    headRef: "feature/remote",
    headCommit: HEAD_OID,
    headTree: "3".repeat(40),
    clean: true as const,
    patchDigest: "4".repeat(64),
    patchBytes: 10,
    checkPolicyDigest: "1".repeat(64),
    policyDigest: "f".repeat(64),
    observedAt: AT,
  };

  async read(): Promise<typeof this.snapshot> {
    return { ...this.snapshot };
  }
}

class FakeGithubGateway {
  readonly policy = {
    owner: "acme",
    repo: "project",
    baseRef: "main",
    headRef: "feature/remote",
    approvedBaseOid: BASE_OID,
    approvedHeadOid: HEAD_OID,
  };
  readonly calls: Array<{ actionId: string; title: string; body: string }> = [];
  refs = { baseOid: BASE_OID, headOid: HEAD_OID };
  timeout = false;
  onInspect?: (count: number) => void;
  private inspectCount = 0;

  async inspectRefs() {
    this.inspectCount += 1;
    this.onInspect?.(this.inspectCount);
    return {
      provider: "github" as const,
      owner: "acme",
      repo: "project",
      repositoryIdentity: "github.com/acme/project",
      baseRef: "main",
      baseOid: this.refs.baseOid,
      headRef: "feature/remote",
      headOid: this.refs.headOid,
      observedAt: AT,
    };
  }

  async createDraftPullRequest(input: { actionId: string; title: string; body: string }) {
    this.calls.push(input);
    if (this.timeout) {
      throw Object.assign(new Error("timeout"), { code: "GITHUB_TIMEOUT", retryable: true, ambiguous: true });
    }
    return {
      provider: "github" as const,
      kind: "draft-pull-request" as const,
      actionId: input.actionId,
      stableMarker: `<!-- valkyrie-action:${input.actionId} -->`,
      externalId: "101",
      number: 101,
      owner: "acme",
      repo: "project",
      baseRef: "main",
      baseOid: this.refs.baseOid,
      headRef: "feature/remote",
      headOid: this.refs.headOid,
      title: input.title,
      bodyHash: sha(`${input.body}\n\n<!-- valkyrie-action:${input.actionId} -->`),
      payloadHash: "6".repeat(64),
      externalRevision: "rev-101",
      observedAt: AT,
      requestHash: sha(JSON.stringify(input)),
      draft: true as const,
      reconciled: false,
      replayed: false,
    };
  }
}

class FakeLinearGateway {
  readonly policy = { teamId: "linear_team_1", projectId: "linear_project_1", issueId: "issue_1" };
  readonly calls: Array<{ actionId: string; issueId: string; body: string }> = [];
  readonly issueCalls: Array<{ actionId: string; title: string; description: string }> = [];
  async readProject(projectId: string) {
    return {
      provider: "linear" as const,
      kind: "project" as const,
      providerId: projectId,
      revision: AT,
      observedAt: AT,
      payloadHash: "6".repeat(64),
      payload: { id: projectId, name: "Project", team: { id: "linear_team_1" }, updatedAt: AT },
    };
  }
  async readIssue(issueId: string) {
    return {
      provider: "linear" as const,
      kind: "issue" as const,
      providerId: issueId,
      externalId: issueId,
      revision: AT,
      updatedAt: AT,
      observedAt: AT,
      payloadHash: "7".repeat(64),
      payload: { id: issueId, title: "Evidence", team: { id: "linear_team_1" }, project: { id: "linear_project_1" }, updatedAt: AT },
    };
  }
  async createEvidenceComment(input: { actionId: string; issueId: string; body: string }) {
    this.calls.push(input);
    return {
      provider: "linear" as const,
      kind: "comment" as const,
      actionId: input.actionId,
      stableId: "comment_1",
      stableMarker: `<!-- valkyrie-action:${input.actionId} -->`,
      externalId: "comment_1",
      externalRevision: "rev-comment",
      observedAt: AT,
      payloadHash: "8".repeat(64),
      requestHash: sha(JSON.stringify(input)),
      replayed: false,
      reconciled: false,
      payload: { id: "comment_1", issueId: input.issueId, body: input.body, updatedAt: AT },
    };
  }
  async createIssue(input: { actionId: string; title: string; description: string }) {
    this.issueCalls.push(input);
    return {
      provider: "linear" as const,
      kind: "issue" as const,
      actionId: input.actionId,
      stableId: "created_issue_1",
      stableMarker: `<!-- valkyrie-action:${input.actionId} -->`,
      externalId: "created_issue_1",
      externalRevision: "rev-created-issue",
      observedAt: AT,
      payloadHash: "a".repeat(64),
      requestHash: sha(JSON.stringify(input)),
      replayed: false,
      reconciled: false,
    };
  }
}

interface Fixture {
  store: SqliteStore;
  run: Run;
  git: FakeGitAuthority;
  github: FakeGithubGateway;
  linear: FakeLinearGateway;
  evidence: { runId: string; projectId: string; workflow: string; evidenceDigest: string; policyHash: string; artifacts: Artifact[] };
  coordinator: ExternalFinalActionCoordinator;
  advance(ms: number): void;
  now(): Date;
}

async function fixture(runId = "run_1"): Promise<Fixture> {
  // The store is deliberately authoritative; keep its deterministic clock
  // ahead of the legacy outbox helper's wall-clock timestamp.
  let nowMs = Date.now() + 60_000;
  const store = new SqliteStore(":memory:", { now: () => new Date(nowMs) });
  await store.migrate();
  await store.seedProjects([{
    id: "project_1",
    name: "Project 1",
    objective: "Test project",
    currentMilestone: "M7",
    health: "on_track",
    linearTeam: "team_1",
    repository: "github.com/acme/project",
    vaultPath: "Projects/project_1",
    memoryNamespace: "projects/project_1",
    createdAt: AT,
  }]);
  const run = makeRun(runId);
  await store.createRun(run);
  const artifacts = [makeArtifact(runId)];
  const evidence = {
    runId,
    projectId: run.projectId,
    workflow: run.workflow!,
    evidenceDigest: artifactDigest(artifacts),
    policyHash: POLICY_HASH,
    artifacts,
  };
  const git = new FakeGitAuthority();
  const github = new FakeGithubGateway();
  const linear = new FakeLinearGateway();
  const coordinator = new ExternalFinalActionCoordinator({
    store,
    evidenceAuthority: () => evidence,
    projectPolicy: { projectId: run.projectId, connectorPolicyDigest: CONNECTOR_POLICY_DIGEST, workflow: run.workflow!, repositoryIdentity: "github.com/acme/project", owner: "acme", repo: "project", baseRef: "main", headRef: "feature/remote", linearIssueId: "issue_1", linearProjectId: "linear_project_1", linearTeamId: "linear_team_1" },
    gitAuthority: git,
    githubGateway: github,
    linearGateway: linear,
    now: () => new Date(nowMs),
    retryDelayMs: 1_000,
  });
  return {
    store, run, git, github, linear, evidence, coordinator,
    advance(ms: number) { nowMs += ms; },
    now() { return new Date(nowMs); },
  };
}

async function close(item: Fixture): Promise<void> {
  await item.store.close();
}

async function prepareAndApprove(item: Fixture, actionId = "github_action") {
  const prepared = await item.coordinator.prepareGithubDraftPr({
    runId: item.run.id,
    title: "Evidence-bound draft",
    body: "A bounded evidence summary",
    actionId,
  });
  const approved = await item.coordinator.resolveApproval({
    planId: prepared.id,
    state: "approved",
    decision: "approve exact draft",
    resolvedBy: "operator_1",
  });
  return { prepared, approved };
}

test("preparation binds completed evidence, fixed Git/GitHub refs, marker, and deterministic hashes", async () => {
  const item = await fixture();
  try {
    const first = await item.coordinator.prepareGithubDraftPr({ runId: item.run.id, title: "Evidence-bound draft", body: "A bounded evidence summary", actionId: "github_action" });
    const replay = await item.coordinator.prepareGithubDraftPr({ runId: item.run.id, title: "Evidence-bound draft", body: "A bounded evidence summary", actionId: "github_action" });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(first.marker, "<!-- valkyrie-action:github_action -->");
    assert.equal(first.target.repositoryIdentity, "github.com/acme/project");
    assert.equal(first.target.baseOid, BASE_OID);
    assert.equal(first.target.headOid, HEAD_OID);
    assert.equal(first.spec.titleHash, sha("Evidence-bound draft"));
    assert.equal(first.spec.bodyHash, sha("A bounded evidence summary\n\n<!-- valkyrie-action:github_action -->"));
    await assert.rejects(
      item.coordinator.prepareGithubDraftPr({ runId: item.run.id, title: "Changed title", body: "A bounded evidence summary", actionId: "github_action" }),
      /different|conflict|request/i,
    );
    assert.equal((await item.store.getRun(item.run.id))?.status, "completed");
  } finally {
    await close(item);
  }
});

test("preparation rejects wrong run identity, artifact/evidence drift, missing head, and ref drift", async () => {
  const wrongProject = await fixture("run_wrong_project");
  try {
    await assert.rejects(wrongProject.coordinator.prepareGithubDraftPr({ runId: wrongProject.run.id, projectId: "other_project", title: "x", body: "y" }), (error: unknown) => error instanceof ExternalFinalActionError && error.code === "EXTERNAL_ACTION_EVIDENCE_INVALID");
    wrongProject.github.refs.headOid = "";
    await assert.rejects(wrongProject.coordinator.prepareGithubDraftPr({ runId: wrongProject.run.id, title: "x", body: "y", actionId: "no_head" }), (error: unknown) => error instanceof ExternalFinalActionError && error.code === "EXTERNAL_ACTION_REMOTE_HEAD_MISSING");
  } finally {
    await close(wrongProject);
  }

  const drift = await fixture("run_drift");
  let driftEvidence = false;
  const original = drift.coordinator;
  driftEvidence = false;
  const evidenceResolver = () => {
    if (driftEvidence) return { ...drift.evidence, policyHash: "9".repeat(64) };
    return drift.evidence;
  };
  const coordinator = new ExternalFinalActionCoordinator({
    store: drift.store,
    evidenceAuthority: evidenceResolver,
    projectPolicy: { projectId: drift.run.projectId, connectorPolicyDigest: CONNECTOR_POLICY_DIGEST, workflow: drift.run.workflow!, repositoryIdentity: "github.com/acme/project", owner: "acme", repo: "project", baseRef: "main", headRef: "feature/remote" },
    gitAuthority: drift.git,
    githubGateway: drift.github,
    now: () => drift.now(),
  });
  try {
    const prepared = await coordinator.prepareGithubDraftPr({ runId: drift.run.id, title: "x", body: "y", actionId: "drift_action" });
    await coordinator.resolveApproval({ planId: prepared.id, state: "approved", decision: "approve", resolvedBy: "operator_1" });
    driftEvidence = true;
    await assert.rejects(coordinator.processOneAuthorizedDelivery({ ownerId: "worker_drift" }), (error: unknown) => error instanceof ExternalFinalActionError && error.code === "EXTERNAL_ACTION_EVIDENCE_DRIFT");
    assert.equal(drift.github.calls.length, 0);
    assert.equal((await drift.store.getRun(drift.run.id))?.status, "completed");
  } finally {
    await close(drift);
    void original;
  }
});

test("evidence and project-policy resolvers fail closed on run, workflow, digest, and project mismatches", async () => {
  const item = await fixture("run_identity");
  try {
    const withEvidence = (evidence: Fixture["evidence"]) => new ExternalFinalActionCoordinator({
      store: item.store,
      evidenceAuthority: () => evidence,
      projectPolicy: { projectId: item.run.projectId, connectorPolicyDigest: CONNECTOR_POLICY_DIGEST, workflow: item.run.workflow!, repositoryIdentity: "github.com/acme/project", owner: "acme", repo: "project", baseRef: "main", headRef: "feature/remote" },
      gitAuthority: item.git,
      githubGateway: item.github,
      now: () => item.now(),
    });
    await assert.rejects(withEvidence({ ...item.evidence, runId: "other_run" }).prepareGithubDraftPr({ runId: item.run.id, title: "x", body: "y", actionId: "wrong_run" }), /different run|identity/i);
    await assert.rejects(withEvidence({ ...item.evidence, workflow: "other_workflow" }).prepareGithubDraftPr({ runId: item.run.id, title: "x", body: "y", actionId: "wrong_workflow" }), /workflow|identity/i);
    await assert.rejects(withEvidence({ ...item.evidence, evidenceDigest: "0".repeat(64) }).prepareGithubDraftPr({ runId: item.run.id, title: "x", body: "y", actionId: "wrong_digest" }), /digest|artifacts/i);
    const wrongPolicy = new ExternalFinalActionCoordinator({
      store: item.store,
      evidenceAuthority: () => item.evidence,
      projectPolicy: { projectId: "other_project", connectorPolicyDigest: CONNECTOR_POLICY_DIGEST, workflow: item.run.workflow!, repositoryIdentity: "github.com/acme/project", owner: "acme", repo: "project", baseRef: "main", headRef: "feature/remote" },
      gitAuthority: item.git,
      githubGateway: item.github,
      now: () => item.now(),
    });
    await assert.rejects(wrongPolicy.prepareGithubDraftPr({ runId: item.run.id, title: "x", body: "y", actionId: "wrong_policy" }), /policy|project/i);
  } finally {
    await close(item);
  }
});

test("wrong approval binding stays pending and expiry is delegated to the authoritative store", async () => {
  const item = await fixture("run_approval");
  try {
    const prepared = await item.coordinator.prepareGithubDraftPr({ runId: item.run.id, title: "x", body: "y", actionId: "approval_action" });
    await assert.rejects(item.store.resolveExternalActionPlanApproval({
      planId: prepared.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "operator_1",
      expectedBinding: {
        action: prepared.approvalAction,
        exactEffect: prepared.exactEffect,
        projectId: prepared.projectId,
        workflow: prepared.workflow,
        evidenceDigest: "0".repeat(64),
        policyHash: prepared.policyHash,
        expiresAt: prepared.expiresAt,
      },
    }), /binding|evidence/i);
    assert.equal((await item.coordinator.getPlan(prepared.id))?.state, "pending_approval");
  } finally {
    await close(item);
  }
});

test("authorized GitHub processing performs one provider spend and atomically completes delivery", async () => {
  const item = await fixture("run_success");
  try {
    const { prepared } = await prepareAndApprove(item, "success_action");
    assert.equal((await item.store.listPendingOutbox(1000)).filter((event) => event.topic === "external.action.authorized").length, 1);
    const completed = await item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_success" });
    assert.equal(completed?.state, "succeeded");
    assert.equal(item.github.calls.length, 1);
    assert.equal((await item.store.getRun(item.run.id))?.status, "completed");
    assert.equal((await item.coordinator.getPlan(prepared.id))?.providerReceipt?.externalId, "101");
    assert.equal((await item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_success" })), null);
    assert.equal(item.github.calls.length, 1);
  } finally {
    await close(item);
  }
});

test("restart after durable begin becomes ambiguous without repeating the provider mutation", async () => {
  const item = await fixture("run_interrupted");
  try {
    const { prepared, approved } = await prepareAndApprove(item, "interrupted_action");
    const first = (await item.store.claimOutboxDeliveries({
      consumerId: "external-final-action",
      ownerId: "worker_before_crash",
      topics: ["external.action.authorized"],
      claimUntil: new Date(item.now().getTime() + 1_000).toISOString(),
      limit: 1,
    }))[0]!;
    await item.store.beginExternalActionAttempt({
      planId: approved.plan.id,
      delivery: {
        outboxId: first.outboxId,
        consumerId: first.consumerId,
        ownerId: "worker_before_crash",
        claimToken: first.claimToken!,
      },
    });
    item.advance(2_000);
    await assert.rejects(
      item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_after_restart" }),
      (error: unknown) => error instanceof ExternalFinalActionError && error.code === "EXTERNAL_ACTION_AMBIGUOUS",
    );
    assert.equal(item.github.calls.length, 0);
    assert.equal((await item.coordinator.getPlan(prepared.id))?.state, "ambiguous");
  } finally {
    await close(item);
  }
});

test("Git/ref preflight failure occurs before provider call and leaves the authorized plan retryable", async () => {
  const item = await fixture("run_preflight");
  try {
    const { prepared } = await prepareAndApprove(item, "preflight_action");
    item.git.snapshot.headCommit = NEXT_HEAD_OID;
    item.github.refs.headOid = NEXT_HEAD_OID;
    await assert.rejects(item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_preflight" }), (error: unknown) => error instanceof ExternalFinalActionError && error.code === "EXTERNAL_ACTION_REMOTE_DRIFT");
    assert.equal(item.github.calls.length, 0);
    assert.equal((await item.coordinator.getPlan(prepared.id))?.state, "authorized");
    const authorized = (await item.store.listExternalActionPlans({ state: "authorized" })).find((plan) => plan.id === prepared.id);
    assert.ok(authorized);
  } finally {
    await close(item);
  }
});

test("timeout is ambiguous and reconciliation has exact zero/one/multiple outcomes", async () => {
  const item = await fixture("run_ambiguous");
  try {
    const { prepared } = await prepareAndApprove(item, "ambiguous_action");
    item.github.timeout = true;
    await assert.rejects(item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_ambiguous" }), (error: unknown) => error instanceof ExternalFinalActionError && error.code === "EXTERNAL_ACTION_AMBIGUOUS");
    assert.equal((await item.coordinator.getPlan(prepared.id))?.state, "ambiguous");
    const zero = await item.coordinator.reconcileAmbiguousPlan({ planId: prepared.id, operatorId: "reconciler_1", outcome: "zero", matchCount: 0 });
    assert.equal(zero.state, "ambiguous");
    const one = await item.coordinator.reconcileAmbiguousPlan({ planId: prepared.id, operatorId: "reconciler_1", outcome: "one", matchCount: 1, externalId: "101", externalRevision: "rev-101", payloadHash: "6".repeat(64) });
    assert.equal(one.state, "succeeded");

    const multiple = await fixture("run_multiple");
    try {
      const { prepared: duplicate } = await prepareAndApprove(multiple, "multiple_action");
      multiple.github.timeout = true;
      await assert.rejects(multiple.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_multiple" }));
      const quarantined = await multiple.coordinator.reconcileAmbiguousPlan({ planId: duplicate.id, operatorId: "reconciler_2", outcome: "multiple", matchCount: 2 });
      assert.equal(quarantined.state, "quarantined");
      await assert.rejects(multiple.coordinator.reconcileAmbiguousPlan({ planId: duplicate.id, operatorId: "reconciler_2", outcome: "one", matchCount: 1, externalId: "101", externalRevision: "rev", payloadHash: "6".repeat(64) }), /reconciliation|ambiguous|state/i);
    } finally {
      await close(multiple);
    }
  } finally {
    await close(item);
  }
});

test("Linear evidence comments use the fixed policy issue and one stable comment action", async () => {
  const item = await fixture("run_linear");
  try {
    const prepared = await item.coordinator.prepareLinearEvidenceComment({ runId: item.run.id, body: "Evidence comment", actionId: "linear_action" });
    assert.equal(prepared.kind, "linear_evidence_comment");
    assert.equal(prepared.target.issueId, "issue_1");
    await item.coordinator.resolveApproval({ planId: prepared.id, state: "approved", decision: "approve", resolvedBy: "operator_linear" });
    const completed = await item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_linear" });
    assert.equal(completed?.state, "succeeded");
    assert.equal(item.linear.calls.length, 1);
    assert.equal(item.linear.calls[0]?.issueId, "issue_1");
    await assert.rejects(item.coordinator.prepareLinearEvidenceComment({ runId: item.run.id, issueId: "issue_other", body: "Evidence comment", actionId: "linear_other" }), /fixed|policy|issue/i);
  } finally {
    await close(item);
  }
});

test("Linear issue creation is inert until an exact evidence-bound approval", async () => {
  const item = await fixture("run_linear_issue");
  try {
    const prepared = await item.coordinator.prepareLinearIssue({
      runId: item.run.id,
      title: "Approved issue title",
      description: "Approved issue description",
      actionId: "linear_issue_action",
    });
    assert.equal(prepared.kind, "linear_create_issue");
    assert.deepEqual(prepared.target, { teamId: "linear_team_1", projectId: "linear_project_1" });
    assert.equal(item.linear.issueCalls.length, 0);
    assert.equal((await item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_before_approval" })), null);
    assert.equal(item.linear.issueCalls.length, 0);
    await item.coordinator.resolveApproval({
      planId: prepared.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "operator_linear_issue",
    });
    const completed = await item.coordinator.processOneAuthorizedDelivery({ ownerId: "worker_linear_issue" });
    assert.equal(completed?.state, "succeeded");
    assert.deepEqual(item.linear.issueCalls, [{
      actionId: prepared.id,
      title: "Approved issue title",
      description: "Approved issue description",
    }]);
  } finally {
    await close(item);
  }
});

test("connector-policy digest and fixed Linear target are revalidated after approval", async () => {
  const digestDrift = await fixture("run_connector_digest_drift");
  let githubPolicy = {
    projectId: digestDrift.run.projectId,
    connectorPolicyDigest: CONNECTOR_POLICY_DIGEST,
    workflow: digestDrift.run.workflow!,
    repositoryIdentity: "github.com/acme/project",
    owner: "acme",
    repo: "project",
    baseRef: "main",
    headRef: "feature/remote",
  };
  const githubCoordinator = new ExternalFinalActionCoordinator({
    store: digestDrift.store,
    evidenceAuthority: () => digestDrift.evidence,
    projectPolicy: () => githubPolicy,
    gitAuthority: digestDrift.git,
    githubGateway: digestDrift.github,
    now: () => digestDrift.now(),
  });
  try {
    const prepared = await githubCoordinator.prepareGithubDraftPr({
      runId: digestDrift.run.id,
      title: "Digest-bound draft",
      body: "Digest-bound body",
      actionId: "connector_digest_action",
    });
    await githubCoordinator.resolveApproval({
      planId: prepared.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "operator_digest",
    });
    githubPolicy = { ...githubPolicy, connectorPolicyDigest: "8".repeat(64) };
    await assert.rejects(
      githubCoordinator.processOneAuthorizedDelivery({ ownerId: "worker_digest" }),
      (error: unknown) => error instanceof ExternalFinalActionError
        && error.code === "EXTERNAL_ACTION_POLICY_MISMATCH",
    );
    assert.equal(digestDrift.github.calls.length, 0);
  } finally {
    await close(digestDrift);
  }

  const targetDrift = await fixture("run_connector_target_drift");
  let linearPolicy = {
    projectId: targetDrift.run.projectId,
    connectorPolicyDigest: CONNECTOR_POLICY_DIGEST,
    workflow: targetDrift.run.workflow!,
    linearIssueId: "issue_1",
    linearProjectId: "linear_project_1",
    linearTeamId: "linear_team_1",
  };
  const linearCoordinator = new ExternalFinalActionCoordinator({
    store: targetDrift.store,
    evidenceAuthority: () => targetDrift.evidence,
    projectPolicy: () => linearPolicy,
    linearGateway: targetDrift.linear,
    now: () => targetDrift.now(),
  });
  try {
    const prepared = await linearCoordinator.prepareLinearEvidenceComment({
      runId: targetDrift.run.id,
      body: "Target-bound evidence",
      actionId: "connector_target_action",
    });
    await linearCoordinator.resolveApproval({
      planId: prepared.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "operator_target",
    });
    linearPolicy = { ...linearPolicy, linearIssueId: "issue_2" };
    await assert.rejects(
      linearCoordinator.processOneAuthorizedDelivery({ ownerId: "worker_target" }),
      (error: unknown) => error instanceof ExternalFinalActionError
        && error.code === "EXTERNAL_ACTION_POLICY_MISMATCH",
    );
    assert.equal(targetDrift.linear.calls.length, 0);
  } finally {
    await close(targetDrift);
  }

  const createTargetDrift = await fixture("run_connector_create_target_drift");
  let createPolicy = {
    projectId: createTargetDrift.run.projectId,
    connectorPolicyDigest: CONNECTOR_POLICY_DIGEST,
    workflow: createTargetDrift.run.workflow!,
    linearIssueId: "issue_1",
    linearProjectId: "linear_project_1",
    linearTeamId: "linear_team_1",
  };
  const createCoordinator = new ExternalFinalActionCoordinator({
    store: createTargetDrift.store,
    evidenceAuthority: () => createTargetDrift.evidence,
    projectPolicy: () => createPolicy,
    linearGateway: createTargetDrift.linear,
    now: () => createTargetDrift.now(),
  });
  try {
    const prepared = await createCoordinator.prepareLinearIssue({
      runId: createTargetDrift.run.id,
      title: "Policy-bound issue",
      description: "The team and project must remain the reviewed target.",
      actionId: "connector_create_target_action",
    });
    await createCoordinator.resolveApproval({
      planId: prepared.id,
      state: "approved",
      decision: "approve",
      resolvedBy: "operator_create_target",
    });
    createPolicy = { ...createPolicy, linearProjectId: "linear_project_2" };
    await assert.rejects(
      createCoordinator.processOneAuthorizedDelivery({ ownerId: "worker_create_target" }),
      (error: unknown) => error instanceof ExternalFinalActionError
        && error.code === "EXTERNAL_ACTION_POLICY_MISMATCH",
    );
    assert.equal(createTargetDrift.linear.issueCalls.length, 0);
  } finally {
    await close(createTargetDrift);
  }
});
