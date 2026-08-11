import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/store.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import { createMockAdapters } from "../apps/control-plane/src/mock-runtimes.ts";
import { ControlPlaneService } from "../apps/control-plane/src/service.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "control-plane-test-"));
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Ovalo", "Decisions"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects", "Ovalo", "Decisions", "ADR.md"), "---\nauthority: canonical\nstatus: accepted\n---\n# Decision\nUse bounded evidence.\n");
  const store = new SqliteStore(join(root, "test.sqlite"));
  store.seedProjects([{
    id: "ovalo", name: "Ovalo", objective: "Language learning", currentMilestone: "Speaking MVP", health: "on_track",
    linearTeam: "OVA", repository: "ovalo/app", vaultPath: "Projects/Ovalo", memoryNamespace: "projects/ovalo"
  }]);
  const brain = new LocalProjectBrain(brainRoot);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const adapters = createMockAdapters(store, workspaces, join(root, "artifacts"), 0);
  const service = new ControlPlaneService(store, brain, workspaces, adapters);
  return { root, brainRoot, store, service };
}

async function tickUntil(service: ControlPlaneService, predicate: () => boolean, limit = 30) {
  for (let i = 0; i < limit; i++) {
    await service.tick();
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("Condition not reached");
}

test("Atomic lifecycle requires approval and creates governed memory proposal", async () => {
  const { root, brainRoot, store, service } = setup();
  try {
    const started = await service.startRun({ projectId: "ovalo", objective: "Implement a verified pronunciation improvement", runtime: "atomic", maxCostUsd: 8 });
    const runId = started.run.run.id;
    await tickUntil(service, () => store.getRun(runId)?.status === "awaiting_approval");
    const approval = store.listApprovals("pending")[0];
    assert.ok(approval);
    assert.equal(store.listLeases().length, 1);
    await service.resolveApproval(approval.id, "approve");
    await tickUntil(service, () => store.getRun(runId)?.status === "completed");
    assert.equal(store.getRun(runId)?.status, "completed");
    assert.equal(store.listLeases().length, 0);
    assert.ok(store.listArtifacts(runId).length >= 3);
    const proposals = store.listMemoryProposals("proposed");
    assert.equal(proposals.length, 1);
    const result = service.resolveMemoryProposal(proposals[0].id, "promote");
    assert.equal(result?.state, "promoted");
    assert.ok(result?.targetNote);
    const promotedPath = join(brainRoot, String(result?.targetNote));
    assert.ok(existsSync(promotedPath));
    assert.match(readFileSync(promotedPath, "utf8"), /verified implementation and review lesson/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idea capture detects an exact duplicate", () => {
  const { root, store, service } = setup();
  try {
    const first = service.captureIdea({ projectId: "ovalo", title: "Generate a listening lesson from a short-form video" });
    const second = service.captureIdea({ projectId: "ovalo", title: "Generate a listening lesson from a short-form video" });
    assert.equal(first.status, "created");
    assert.equal(second.status, "duplicate");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
