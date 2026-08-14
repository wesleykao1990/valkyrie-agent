import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextPackChecksum, LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import type { Project } from "../apps/control-plane/src/types.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-brain-"));
  const project: Project = {
    id: "fixture", name: "Fixture", objective: "Bounded memory", currentMilestone: "Pilot", health: "on_track",
    linearTeam: "FIX", repository: "fixture/repo", vaultPath: "Projects/Fixture", memoryNamespace: "projects/fixture",
    createdAt: new Date().toISOString(),
  };
  const decisions = join(root, project.vaultPath, "Decisions");
  mkdirSync(decisions, { recursive: true });
  mkdirSync(join(root, "Shared"), { recursive: true });
  writeFileSync(join(root, project.vaultPath, "Project.md"), "---\ntype: project\nstatus: accepted\nauthority: canonical\nproject: fixture\n---\n# Fixture\nUse bounded context.\n");
  writeFileSync(join(decisions, "old.md"), "---\nid: old\ntype: decision\nstatus: accepted\nauthority: canonical\nproject: fixture\n---\n# Old\nDo the stale thing.\n");
  writeFileSync(join(decisions, "new.md"), "---\nid: new\ntype: decision\nstatus: accepted\nauthority: canonical\nproject: fixture\nsupersedes: [old]\n---\n# New\nUse deterministic evidence.\n");
  writeFileSync(join(decisions, "draft.md"), "---\nid: draft\ntype: decision\nstatus: stale\nauthority: canonical\nproject: fixture\n---\n# Draft\nDo not retrieve this.\n");
  writeFileSync(join(root, "Shared", "Policy.md"), "---\ntype: policy\nstatus: accepted\nauthority: canonical\nproject: shared\n---\n# Policy\nNever silently promote memory.\n");
  return { root, project, brain: new LocalProjectBrain(root) };
}

test("Project Brain builds deterministic bounded context from accepted non-superseded canonical Markdown", () => {
  const { root, project, brain } = fixture();
  try {
    const first = brain.buildContextPack(project, "deterministic evidence", { runId: "run-1", taskId: "task-1" });
    const second = brain.buildContextPack(project, "deterministic evidence", { runId: "run-1", taskId: "task-1" });
    assert.deepEqual(second, first);
    assert.equal(contextPackChecksum(second), contextPackChecksum(first));
    assert.ok(first.entries.some((entry) => entry.title === "New"));
    assert.ok(first.entries.some((entry) => entry.title === "Policy"));
    assert.ok(first.entries.every((entry) => entry.authority === "canonical" && entry.status === "accepted"));
    assert.ok(first.entries.every((entry) => entry.title !== "Old" && entry.title !== "Draft"));
    assert.ok(first.entries.reduce((total, entry) => total + entry.excerpt.length, 0) <= first.limits.maxCharacters);
    assert.equal(first.automaticEpisodicCapture, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion requires an exact reviewed preview and is idempotent only for identical content", () => {
  const { root, project, brain } = fixture();
  try {
    const preview = brain.previewPromotion(project, {
      proposalId: "memory_safe_1",
      claim: "Use the exact reviewed context contract.",
      evidence: ["test evidence"],
      approvedBy: "wesley",
      approvedAt: "2026-08-11T12:00:00.000Z",
    });
    assert.equal(preview.target, "Projects/Fixture/Decisions/memory_safe_1.md");
    assert.equal(preview.approvedBy, "wesley");
    assert.match(preview.content, /Use the exact reviewed context contract\./);
    assert.match(preview.content, /- test evidence/);
    assert.equal(existsSync(preview.path), false, "previewing must not write canonical memory");
    assert.equal(brain.promote(project, preview), preview.target);
    assert.equal(brain.promote(project, preview), preview.target);
    assert.ok(existsSync(preview.path));
    assert.match(readFileSync(preview.path, "utf8"), /approved_at: 2026-08-11/);
    assert.throws(() => brain.promote(project, { ...preview, content: `${preview.content}\ntampered` }), /content or path changed/);
    assert.throws(() => brain.promote(project, { ...preview, previewHash: "0".repeat(64) }), /preview hash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project Brain rejects a project vault path outside its configured root", () => {
  const { root, project, brain } = fixture();
  try {
    assert.throws(() => brain.buildContextPack({ ...project, vaultPath: "../outside" }, "anything", { runId: "run-2" }), /escaped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project Brain search never returns notes owned by another project", () => {
  const { root, project, brain } = fixture();
  try {
    writeFileSync(
      join(root, "Shared", "Other.md"),
      "---\ntype: policy\nstatus: accepted\nauthority: canonical\nproject: other-project\n---\n# Other project\nCROSS_PROJECT_MEMORY_SENTINEL\n",
      "utf8",
    );
    const results = brain.search(project, "CROSS_PROJECT_MEMORY_SENTINEL");
    assert.ok(results.every((result) => result.title !== "Other project"));
    assert.ok(results.every((result) => !result.excerpt.includes("CROSS_PROJECT_MEMORY_SENTINEL")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project Brain rejects a symlinked vault ancestor before preview or promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-brain-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "valkyrie-brain-outside-"));
  try {
    mkdirSync(join(root, "Projects"), { recursive: true });
    symlinkSync(outside, join(root, "Projects", "Escape"));
    const brain = new LocalProjectBrain(root);
    const project: Project = {
      id: "escape", name: "Escape", objective: "Must stay contained", currentMilestone: "Pilot", health: "on_track",
      linearTeam: "ESC", repository: "fixture/escape", vaultPath: "Projects/Escape", memoryNamespace: "projects/escape",
      createdAt: new Date().toISOString(),
    };
    assert.throws(
      () => brain.previewPromotion(project, {
        proposalId: "memory_escape",
        claim: "This must never be written through the symlink.",
        evidence: [],
        approvedAt: "2026-08-11T12:00:00.000Z",
      }),
      /realpath escaped/,
    );
    assert.equal(existsSync(join(outside, "Decisions", "memory_escape.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
