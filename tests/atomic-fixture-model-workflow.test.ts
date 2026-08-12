import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ATOMIC_FIXTURE_IMPLEMENTATION,
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";
import {
  ATOMIC_FIXTURE_MODEL_PATHS,
  ATOMIC_FIXTURE_MODEL_REQUEST,
  emitAtomicFixtureModelEvidence,
  preflightAtomicFixtureModel,
  runAtomicFixtureModelChecks,
  validateAtomicFixtureModelInputs,
  writeAtomicFixtureModelReview,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function git(cwd: string, args: string[]): void {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-model-workflow-")));
  const workspace = join(root, "workspace");
  const context = join(root, "context");
  cpSync(resolve("fixtures/atomic-pilot-template"), workspace, { recursive: true });
  mkdirSync(context);
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["add", "."]);
  git(workspace, ["-c", "user.name=Valkyrie Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
  const inputs = {
    control_plane_run_id: "run_atomic_model_fixture",
    expected_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
    capability_policy_sha256: "a".repeat(64),
    package_sha256: "b".repeat(64),
    contract_sha256: "",
  };
  const contextPack = `${JSON.stringify({ schemaVersion: "1.0.0", entries: [] })}\n`;
  const contract = `${JSON.stringify({
    schemaVersion: "1.0.0", runId: inputs.control_plane_run_id, projectId: "atomic-pilot", taskId: "M5B",
    request: ATOMIC_FIXTURE_MODEL_REQUEST, rootRuntime: "atomic", workflow: "atomic-fixture-model-pilot",
    finalAction: "stop_before_external_action", crossProcessResume: false,
    atomicPackage: { packageSha256: inputs.package_sha256 },
    inference: { policySha256: inputs.capability_policy_sha256, credentialInWriter: false, fakeProvider: false },
  }, null, 2)}\n`;
  inputs.contract_sha256 = sha(contract);
  const launch = `${JSON.stringify({
    schema_version: "1.0.0-model-prelive", run_id: inputs.control_plane_run_id,
    inference_policy_sha256: inputs.capability_policy_sha256, package_sha256: inputs.package_sha256,
    crossProcessResume: false,
  })}\n`;
  writeFileSync(join(context, "context-pack.json"), contextPack);
  writeFileSync(join(context, "run-contract.json"), contract);
  writeFileSync(join(context, "atomic-model-launch-manifest.json"), launch);
  return { root, workspace, context, inputs };
}

test("model workflow core binds policy, runs deterministic gates, and emits pre-live evidence", async () => {
  const item = fixture();
  try {
    assert.equal((await preflightAtomicFixtureModel({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs })).contract_sha256, item.inputs.contract_sha256);
    writeFileSync(join(item.workspace, "src/normalize-project-slug.js"), ATOMIC_FIXTURE_IMPLEMENTATION);
    const checks = await runAtomicFixtureModelChecks({ workspacePath: item.workspace, round: "initial", nodePath: process.execPath });
    assert.equal(checks.passed, true);
    const verifier = await writeAtomicFixtureModelReview({ workspacePath: item.workspace, round: "initial", review: { approved: true, findings: [] } });
    const output = await emitAtomicFixtureModelEvidence({
      workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs,
      nativeRunId: "11111111-2222-4333-8444-555555555555", checks, verifier, repairCount: 0,
    });
    assert.equal(output.live_provider_verified, false);
    assert.equal(output.repair_count, 0);
    const evidence = JSON.parse(readFileSync(join(item.workspace, ATOMIC_FIXTURE_MODEL_PATHS.evidence), "utf8"));
    assert.equal(evidence.model_execution_expected, true);
    assert.equal(evidence.live_provider_verified, false);
    assert.equal(evidence.capability_policy_sha256, item.inputs.capability_policy_sha256);
    assert.equal(evidence.package_sha256, item.inputs.package_sha256);
    assert.deepEqual(
      readFileSync(join(item.workspace, ATOMIC_FIXTURE_MODEL_PATHS.contextPack)),
      readFileSync(join(item.context, "context-pack.json")),
      "context-pack evidence is an exact byte copy rather than a serialized Buffer",
    );
    assert.deepEqual(readFileSync(join(item.workspace, ATOMIC_FIXTURE_MODEL_PATHS.runContract)), readFileSync(join(item.context, "run-contract.json")));
    assert.deepEqual(readFileSync(join(item.workspace, ATOMIC_FIXTURE_MODEL_PATHS.launchManifest)), readFileSync(join(item.context, "atomic-model-launch-manifest.json")));
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test("model workflow refuses unbound input and retains evidence-backed repair findings", async () => {
  const item = fixture();
  try {
    assert.throws(() => validateAtomicFixtureModelInputs({ ...item.inputs, provider_key: "secret" }), /exactly/i);
    await assert.rejects(writeAtomicFixtureModelReview({
      workspacePath: item.workspace, round: "initial", review: { approved: true, findings: ["contradiction"] },
    }), /cannot retain findings/i);
    const review = await writeAtomicFixtureModelReview({
      workspacePath: item.workspace, round: "initial", review: { approved: false, findings: ["test failure at slug edge case"] },
    });
    assert.equal(review.approved, false);
    assert.deepEqual(review.findings, ["test failure at slug edge case"]);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});
