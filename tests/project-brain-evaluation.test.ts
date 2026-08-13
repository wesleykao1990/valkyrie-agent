import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectBrainEvaluationFixture,
  evaluateProjectBrainProvider,
  runProjectBrainEvaluation,
} from "../apps/control-plane/src/project-brain-evaluation.ts";
import { LocalProjectBrainProvider } from "../apps/control-plane/src/project-brain-provider.ts";

test("Project Brain evaluation proves local isolation, ranking, suppression, deletion, determinism, and read-only behavior", async () => {
  const fixture = createProjectBrainEvaluationFixture();
  try {
    const provider = new LocalProjectBrainProvider(fixture.brain);
    const result = await evaluateProjectBrainProvider({ provider, fixture });
    const { measurements, packs, packBytes } = result;
    assert.equal(measurements.passed, true);
    assert.equal(measurements.isolation.crossProjectHits, 0);
    assert.deepEqual(measurements.isolation.leakedSources, []);
    assert.equal(measurements.ranking.hitAt, 1);
    assert.equal(measurements.ranking.expectedSource, fixture.currentDecisionSource);
    assert.deepEqual(measurements.suppression.leakedSources, []);
    assert.equal(measurements.deletion.presentBefore, true);
    assert.equal(measurements.deletion.presentAfter, false);
    assert.equal(measurements.determinism.checksumsEqual, true);
    assert.equal(measurements.determinism.bytesEqual, true);
    assert.equal(measurements.readOnly.changed, false);
    assert.deepEqual(measurements.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 });
    assert.ok(measurements.latency.totalMs >= 0);
    assert.ok(measurements.latency.searchMs >= 0);
    assert.ok(measurements.latency.acceptedDecisionsMs >= 0);
    assert.ok(measurements.latency.contextPackMs >= 0);
    assert.equal(packBytes.beforeDeletion, packBytes.repeated);
    assert.deepEqual(packs.beforeDeletion, packs.repeated);
    assert.notEqual(packBytes.beforeDeletion, packBytes.afterDeletion, "deletion must affect the next pack");
    assert.equal(packs.afterDeletion.entries.some((entry) => entry.source === fixture.currentDecisionSource), false);
  } finally {
    fixture.dispose();
  }
});
test("evaluation returns pack bytes separately from measurements and aliases the harness entry point", async () => {
  const fixture = createProjectBrainEvaluationFixture();
  try {
    const provider = new LocalProjectBrainProvider(fixture.brain);
    const first = await evaluateProjectBrainProvider({ provider, fixture, runId: "run-a", taskId: "task-a" });
    fixture.dispose();

    const secondFixture = createProjectBrainEvaluationFixture();
    try {
      const second = await runProjectBrainEvaluation({
        provider: new LocalProjectBrainProvider(secondFixture.brain),
        fixture: secondFixture,
        runId: "run-a",
        taskId: "task-a",
      });
      assert.equal(typeof first.measurements.latency.totalMs, "number");
      assert.equal(first.packBytes.beforeDeletion, second.packBytes.beforeDeletion);
      assert.equal(first.measurements.determinism.firstChecksum, second.measurements.determinism.firstChecksum);
      assert.equal(first.measurements.usage.costUsd, 0);
    } finally {
      secondFixture.dispose();
    }
  } catch (error) {
    fixture.dispose();
    throw error;
  }
});
