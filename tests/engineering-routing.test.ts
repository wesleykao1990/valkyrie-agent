import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import { createMockAdapters } from "../apps/control-plane/src/mock-runtimes.ts";
import { ControlPlaneService, ENGINEERING_ROUTING_ASSESSMENT_TTL_MS } from "../apps/control-plane/src/service.ts";
import type { ProductionConnectorRegistry } from "../apps/control-plane/src/production-connectors.ts";

async function fixture(options: { connectors?: ProductionConnectorRegistry } = {}) {
  let nowMs = Date.parse("2026-08-13T00:00:00.000Z");
  const root = mkdtempSync(join(tmpdir(), "valkyrie-engineering-routing-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Ovalo", "Decisions"), { recursive: true });
  mkdirSync(join(brainRoot, "Projects", "Other", "Decisions"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects", "Ovalo", "Decisions", "Accepted.md"), [
    "---", "project: ovalo", "authority: canonical", "status: accepted", "type: decision", "---",
    "# Accepted routing context", "Use bounded deterministic evidence.", "",
  ].join("\n"));
  const store = new SqliteStore(join(root, "routing.sqlite"), { now: () => new Date(nowMs) });
  await store.seedProjects([
    {
      id: "ovalo", name: "Ovalo", objective: "Language learning", currentMilestone: "Speaking MVP", health: "on_track",
      linearTeam: "OVA", repository: "ovalo/app", vaultPath: "Projects/Ovalo", memoryNamespace: "projects/ovalo",
      createdAt: new Date(nowMs).toISOString(),
    },
    {
      id: "other", name: "Other", objective: "Isolation", currentMilestone: "Fixture", health: "on_track",
      linearTeam: "OTH", repository: "other/app", vaultPath: "Projects/Other", memoryNamespace: "projects/other",
      createdAt: new Date(nowMs).toISOString(),
    },
  ]);
  await store.createTask({
    id: "task_ovalo_parser", projectId: "ovalo", source: "linear-prototype", sourceId: "OVA-10",
    title: "Bounded parser", objective: "Implement a bounded parser in two files with unit tests.",
    status: "planned", priority: "normal", createdAt: new Date(nowMs).toISOString(),
  });
  await store.createTask({
    id: "task_other", projectId: "other", source: "linear-prototype", sourceId: "OTH-1",
    title: "Other task", objective: "Remain isolated", status: "planned", priority: "normal",
    createdAt: new Date(nowMs).toISOString(),
  });
  const brain = new LocalProjectBrain(brainRoot);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"), { now: () => new Date(nowMs) });
  const service = new ControlPlaneService(
    store,
    brain,
    workspaces,
    createMockAdapters(store, workspaces, join(root, "artifacts"), 0),
    { now: () => new Date(nowMs), ...(options.connectors ? { connectors: options.connectors } : {}) },
  );
  return { root, store, service, advance(ms: number) { nowMs += ms; } };
}

function liveAuthorityFixture(): ProductionConnectorRegistry {
  const observedAt = "2026-08-13T00:00:00.000Z";
  const projectSnapshot = {
    provider: "linear" as const, kind: "project" as const, providerId: "linear_project_1",
    externalId: "linear_project_1", revision: observedAt, updatedAt: observedAt,
    observedAt, payloadHash: "a".repeat(64), payload: { id: "linear_project_1" },
  };
  const issueSnapshot = {
    provider: "linear" as const, kind: "issue" as const, providerId: "linear_issue_1",
    externalId: "linear_issue_1", revision: observedAt, updatedAt: observedAt,
    observedAt, payloadHash: "b".repeat(64), payload: { id: "linear_issue_1" },
  };
  return {
    policyForProject(projectId: string) {
      return projectId === "ovalo" ? {
        projectId,
        linear: { teamId: "linear_team_1", projectId: "linear_project_1" },
        git: { repositoryIdentity: "github.com/acme/ovalo" },
      } : undefined;
    },
    linearForProject(projectId: string) {
      return projectId === "ovalo" ? {
        readProject: async () => projectSnapshot,
        readIssue: async () => issueSnapshot,
      } : undefined;
    },
    gitForProject(projectId: string) {
      return projectId === "ovalo" ? {
        read: async () => ({
          provider: "git" as const, projectId, repositoryIdentity: "github.com/acme/ovalo",
          remoteUrlIdentity: "github.com/acme/ovalo", baseRef: "main", baseCommit: "c".repeat(40),
          baseTree: "d".repeat(40), headRef: "feature/m7", headCommit: "e".repeat(40),
          headTree: "f".repeat(40), clean: true as const, patchDigest: "1".repeat(64), patchBytes: 10,
          checkPolicyDigest: "2".repeat(64), policyDigest: "3".repeat(64), observedAt,
        }),
      } : undefined;
    },
  } as unknown as ProductionConnectorRegistry;
}

test("authenticated intake persists the literal request and a fail-closed explainable route without launching", async () => {
  const item = await fixture();
  try {
    const literal = "Implement a bounded parser in two files with unit tests.";
    const result = await item.service.assessEngineeringRequest({
      projectId: "ovalo",
      taskId: "task_ovalo_parser",
      request: literal,
      preference: "auto",
      finalAction: "prepare_reviewable_result",
      idempotencyKey: "route_parser_v1",
    });
    assert.equal(result.replayed, false);
    assert.equal(result.assessment.literalRequest, literal);
    assert.equal(result.assessment.selectedShape, "atomic-lite");
    assert.equal(result.assessment.finalAction, "prepare_reviewable_result");
    assert.equal(result.assessment.status, "unsupported");
    assert.equal(result.assessment.executionSupported, false);
    assert.deepEqual(
      {
        linear: typeof result.assessment.contextSources.linear === "string"
          ? result.assessment.contextSources.linear
          : result.assessment.contextSources.linear.status,
        git: typeof result.assessment.contextSources.git === "string"
          ? result.assessment.contextSources.git
          : result.assessment.contextSources.git.status,
        projectBrain: typeof result.assessment.contextSources.projectBrain === "string"
          ? result.assessment.contextSources.projectBrain
          : result.assessment.contextSources.projectBrain.status,
      },
      { linear: "prototype", git: "unavailable", projectBrain: "accepted-local" },
    );
    assert.ok(result.assessment.unsupportedReasons.includes("general-atomic-lite-launch-unavailable"));
    assert.equal(result.launch.supported, false);
    assert.deepEqual(await item.store.listRuns(), []);
    assert.deepEqual(await item.store.listLeases(), []);
    const outbox = (await item.store.listPendingOutbox(1_000)).find((event) => event.aggregateId === result.assessment.id);
    assert.ok(outbox);
    assert.equal(JSON.stringify(outbox?.payload).includes(literal), false, "literal requests stay out of routing outbox payloads");
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("routing assessment idempotency replays exactly and conflicts on changed literal input", async () => {
  const item = await fixture();
  try {
    const input = {
      projectId: "ovalo",
      request: "Fix one typo in a single README file.",
      preference: "direct" as const,
      finalAction: "analysis_only" as const,
      idempotencyKey: "route_readme_v1",
    };
    const first = await item.service.assessEngineeringRequest(input);
    const replay = await item.service.assessEngineeringRequest(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.assessment.id, first.assessment.id);
    assert.equal(replay.assessment.literalRequest, input.request);
    await assert.rejects(item.service.assessEngineeringRequest({
      ...input,
      request: "Fix a different file with the same retry key.",
    }), /Idempotency|different request/i);
    assert.equal((await item.store.listEngineeringRoutingAssessments("ovalo")).length, 1);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("routing intake rejects score injection and cross-project task identity before persistence", async () => {
  const item = await fixture();
  try {
    await assert.rejects(item.service.assessEngineeringRequest({
      projectId: "ovalo",
      request: "Implement a bounded parser.",
      structure: 0,
    } as any), /scores are control-plane owned/);
    await assert.rejects(item.service.assessEngineeringRequest({
      projectId: "ovalo", taskId: "task_other", request: "Implement a bounded parser.",
    }), /does not belong/);
    await assert.rejects(item.service.assessEngineeringRequest({
      projectId: "ovalo", request: "Implement a bounded parser.", idempotencyKey: "unsafe key",
    }), /safe 1-128 character ID/i);
    assert.equal((await item.store.listEngineeringRoutingAssessments()).length, 0);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("assessment reads report expiry without converting the unsupported recommendation into a run", async () => {
  const item = await fixture();
  try {
    const created = await item.service.assessEngineeringRequest({
      projectId: "ovalo", request: "Explain the accepted routing policy in read-only mode.",
    });
    assert.equal((await item.service.getEngineeringRoutingAssessment(created.assessment.id)).expired, false);
    item.advance(ENGINEERING_ROUTING_ASSESSMENT_TTL_MS + 1);
    const read = await item.service.getEngineeringRoutingAssessment(created.assessment.id);
    assert.equal(read.expired, true);
    assert.equal(read.launch.supported, false);
    assert.deepEqual(await item.store.listRuns(), []);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("accepted Linear and Git gateways bind current revisions without authorizing a general launcher", async () => {
  const connectors = liveAuthorityFixture();
  const item = await fixture({ connectors });
  try {
    const result = await item.service.assessEngineeringRequest({
      projectId: "ovalo",
      taskId: "task_ovalo_parser",
      request: "Implement a bounded parser in two files with unit tests.",
    });
    assert.equal((result.assessment.contextSources.linear as { status: string }).status, "revision-bound");
    assert.equal((result.assessment.contextSources.git as { status: string }).status, "revision-bound");
    assert.deepEqual(result.assessment.unsupportedReasons, [
      "reviewed-general-launcher-unavailable",
      "general-atomic-lite-launch-unavailable",
    ]);
    assert.equal(result.assessment.executionSupported, false);
    const [projectBinding, taskBinding, gitBinding] = await Promise.all([
      item.store.getAuthorityBinding("linear", "project", "ovalo"),
      item.store.getAuthorityBinding("linear", "task", "task_ovalo_parser"),
      item.store.getAuthorityBinding("git", "project", "ovalo"),
    ]);
    assert.equal(projectBinding?.externalId, "linear_project_1");
    assert.equal(taskBinding?.externalId, "linear_issue_1");
    assert.equal(gitBinding?.revision, "e".repeat(40));
    const brief = await item.service.projectBrief("ovalo");
    assert.equal(brief.linearProjection.prototype, false);
    assert.equal(brief.linearProjection.authority.status, "revision-bound");
    assert.equal((brief.freshness.git as { status: string }).status, "revision-bound");
    const idea = await item.service.captureIdea({ projectId: "ovalo", title: "A new bounded connector idea" });
    assert.equal(typeof idea.linearAction, "string");
    assert.match(idea.linearAction!, /separate evidence-bound external-action plan and approval/);
    assert.deepEqual(await item.store.listRuns(), []);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
