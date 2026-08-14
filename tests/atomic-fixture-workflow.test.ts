import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
  ATOMIC_FIXTURE_PACKAGE_NAME,
  ATOMIC_FIXTURE_PACKAGE_VERSION,
  ATOMIC_FIXTURE_PATHS,
  ATOMIC_FIXTURE_REQUEST,
  applyReviewedAtomicFixtureImplementation,
  emitAtomicFixtureEvidence,
  preflightAtomicFixture,
  runBoundedCommand,
  runAtomicFixtureChecks,
  runAtomicFixtureVerifier,
  validateAtomicFixtureInputs,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";

const template = resolve("fixtures/atomic-pilot-template");

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

function fixture(): {
  root: string;
  workspace: string;
  context: string;
  stagedWorkflowSha256: string;
  inputs: Record<string, string>;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-workflow-")));
  const workspace = join(root, "workspace");
  const context = join(root, "context");
  cpSync(template, workspace, { recursive: true });
  mkdirSync(context, { recursive: true });
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["add", "."]);
  git(workspace, [
    "-c", "user.name=Valkyrie Test",
    "-c", "user.email=valkyrie-test@example.invalid",
    "commit", "--quiet", "-m", "fixture baseline",
  ]);
  const runId = "run_atomic_fixture_test";
  cpSync(resolve("packages/atomic-workflow-architect"), join(context, "atomic-package"), { recursive: true });
  const stagedWorkflowPath = join(context, "atomic-package", "workflows", "atomic-fixture-pilot.ts");
  const stagedWorkflowSha256 = sha(readFileSync(stagedWorkflowPath, "utf8"));
  const stagedCoreSha256 = sha(readFileSync(join(context, "atomic-package", "lib", "atomic-fixture-pilot-core.mjs"), "utf8"));
  const stagedPackageJsonSha256 = sha(readFileSync(join(context, "atomic-package", "package.json"), "utf8"));
  const contextPack = `${JSON.stringify({
    schemaVersion: "1.0.0",
    runId,
    projectId: "fixture",
    taskId: "FIX-5",
    objective: ATOMIC_FIXTURE_REQUEST,
    authorityRule: "Accepted Project Brain decisions are authoritative for rationale.",
    automaticEpisodicCapture: false,
    limits: { maxEntries: 10, maxCharacters: 12_000, excerptCharacters: 1_600 },
    entries: [],
  })}`;
  const contract = `${JSON.stringify({
    schemaVersion: "1.0.0",
    runId,
    projectId: "fixture",
    taskId: "FIX-5",
    request: ATOMIC_FIXTURE_REQUEST,
    rootRuntime: "atomic",
    workflow: "atomic-fixture-pilot",
    finalAction: "stop_before_external_action",
    automaticEpisodicCapture: false,
    contextPack: { checksum: sha(contextPack), uri: "context://fixture/FIX-5" },
    atomicPackage: {
      name: ATOMIC_FIXTURE_PACKAGE_NAME,
      version: ATOMIC_FIXTURE_PACKAGE_VERSION,
      workflowSha256: stagedWorkflowSha256,
      coreSha256: stagedCoreSha256,
      packageJsonSha256: stagedPackageJsonSha256,
    },
  }, null, 2)}\n`;
  const launchManifest = `${JSON.stringify({
    schema_version: "1.1.0",
    run_id: runId,
    project_id: "fixture",
    task_id: "FIX-5",
    request: ATOMIC_FIXTURE_REQUEST,
    request_class: "feature",
    intent: "implement",
    root_runtime: "atomic",
    context_pack_ref: "context://fixture/FIX-5",
    contract_ref: "artifact://run_atomic_fixture_test/run-contract",
    workflow: {
      name: "atomic-fixture-pilot",
      path: stagedWorkflowPath,
      version: "1.0.0",
      content_hash: `sha256:${stagedWorkflowSha256}`,
      trust_state: "package-reviewed",
    },
    workspace_owner: "control-plane",
    workspace_id: "workspace_atomic_fixture_test",
    workspace_ref: "workspace://workspace_atomic_fixture_test",
    writer_lease: {
      lease_id: "lease_atomic_fixture_test",
      holder_run_id: runId,
      workspace_id: "workspace_atomic_fixture_test",
      owner_id: "atomic_fixture_writer",
      fencing_token: 7,
      mode: "exclusive-writer",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    sandbox_policy_id: "sandbox_atomic_fixture_test",
    durability_required: false,
    crossProcessResume: false,
    final_action: "stop_before_pr",
    budget: { currency: "USD", max_cost_usd: 0 },
    bounds: {
      max_duration_minutes: 2,
      max_turns: 1,
      max_repairs: 0,
      max_child_depth: 0,
      max_concurrency: 1,
    },
    model_policy: {
      planner: "none:deterministic-tool-only",
      worker: "none:deterministic-tool-only",
      reviewers: ["fresh-deterministic-process"],
      fallbacks: [],
    },
    approvals: [{
      action: "external_final_action",
      exact_effect: "Stop before PR creation, merge, deployment, or canonical-memory promotion.",
      required: true,
    }],
    idempotency_key: "atomic-fixture-workflow-test",
    correlation_id: runId,
  })}\n`;
  writeFileSync(join(context, "context-pack.json"), contextPack, "utf8");
  writeFileSync(join(context, "run-contract.json"), contract, "utf8");
  writeFileSync(join(context, "atomic-launch-manifest.json"), launchManifest, "utf8");
  return {
    root,
    workspace,
    context,
    stagedWorkflowSha256,
    inputs: {
      control_plane_run_id: runId,
      contract_sha256: sha(contract),
      expected_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
    },
  };
}

test("credential-free Atomic fixture core preserves the literal contract and emits bounded evidence", async () => {
  const item = fixture();
  try {
    const preflight = await preflightAtomicFixture({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
    });
    assert.equal(preflight.control_plane_run_id, item.inputs.control_plane_run_id);
    assert.equal(preflight.expected_before_sha256, ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256);

    const implementation = await applyReviewedAtomicFixtureImplementation({
      workspacePath: item.workspace,
      expectedBeforeSha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
    });
    assert.equal(implementation.source_after_sha256, ATOMIC_FIXTURE_IMPLEMENTATION_SHA256);

    const checks = await runAtomicFixtureChecks({
      workspacePath: item.workspace,
      nodePath: process.execPath,
    });
    assert.equal(checks.passed, true);
    assert.deepEqual(checks.changed_paths, ["src/normalize-project-slug.js"]);

    const verifier = await runAtomicFixtureVerifier({
      workspacePath: item.workspace,
      nodePath: process.execPath,
      contractSha256: item.inputs.contract_sha256,
      checks,
    });
    assert.equal(verifier.passed, true);
    assert.equal(verifier.context_mode, "fresh-deterministic-process");
    assert.equal(verifier.model_execution_attempted, false);

    const output = await emitAtomicFixtureEvidence({
      workspacePath: item.workspace,
      nativeRunId: "11111111-2222-4333-8444-555555555555",
      contextRoot: item.context,
      preflight,
      implementation,
      checks,
      verifier,
    });
    assert.deepEqual(output, {
      evidence_manifest_path: ATOMIC_FIXTURE_PATHS.evidence,
      patch_path: ATOMIC_FIXTURE_PATHS.patch,
      check_path: ATOMIC_FIXTURE_PATHS.checks,
      verifier_path: ATOMIC_FIXTURE_PATHS.verifier,
      memory_proposal_path: ATOMIC_FIXTURE_PATHS.memoryProposal,
      draft_pr_mock_path: ATOMIC_FIXTURE_PATHS.draftPrMock,
      context_pack_path: ATOMIC_FIXTURE_PATHS.contextPack,
      run_contract_path: ATOMIC_FIXTURE_PATHS.runContract,
      launch_manifest_path: ATOMIC_FIXTURE_PATHS.launchManifest,
      source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      repair_count: 0,
      checks_passed: true,
      verifier_passed: true,
    });

    const evidence = JSON.parse(readFileSync(join(item.workspace, ATOMIC_FIXTURE_PATHS.evidence), "utf8"));
    assert.equal(evidence.workflow.name, "atomic-fixture-pilot");
    assert.equal(evidence.workflow.version, "1.0.0");
    assert.equal(evidence.workflow.content_sha256, item.stagedWorkflowSha256);
    assert.equal(evidence.atomic_package.name, ATOMIC_FIXTURE_PACKAGE_NAME);
    assert.equal(evidence.atomic_package.version, ATOMIC_FIXTURE_PACKAGE_VERSION);
    assert.equal(evidence.atomic_package.workflow_sha256, item.stagedWorkflowSha256);
    assert.equal(evidence.atomic_package.core_sha256, preflight.atomic_core_sha256);
    assert.equal(evidence.atomic_package.package_json_sha256, preflight.atomic_package_json_sha256);
    assert.equal(evidence.control_plane_run_id, item.inputs.control_plane_run_id);
    assert.equal(evidence.contract_sha256, item.inputs.contract_sha256);
    assert.equal(evidence.source_before_sha256, ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256);
    assert.equal(evidence.source_after_sha256, ATOMIC_FIXTURE_IMPLEMENTATION_SHA256);
    assert.deepEqual(evidence.changed_paths, ["src/normalize-project-slug.js"]);
    assert.equal(evidence.checks_passed, true);
    assert.equal(evidence.verifier_passed, true);
    assert.equal(evidence.repair_count, 0);
    assert.equal(evidence.final_action, "stop_before_external_action");
    assert.equal(evidence.external_actions.github_request_performed, false);
    assert.equal(evidence.external_actions.memory_promoted, false);
    assert.equal(evidence.context_copies.context_pack.checksum_equal, true);
    assert.equal(evidence.context_copies.run_contract.checksum_equal, true);
    assert.equal(evidence.context_copies.atomic_launch_manifest.checksum_equal, true);
    assert.equal(
      readFileSync(join(item.workspace, ATOMIC_FIXTURE_PATHS.runContract), "utf8"),
      readFileSync(join(item.context, "run-contract.json"), "utf8"),
    );
    assert.equal(
      readFileSync(join(item.workspace, ATOMIC_FIXTURE_PATHS.contextPack), "utf8"),
      readFileSync(join(item.context, "context-pack.json"), "utf8"),
    );
    assert.equal(
      readFileSync(join(item.workspace, ATOMIC_FIXTURE_PATHS.launchManifest), "utf8"),
      readFileSync(join(item.context, "atomic-launch-manifest.json"), "utf8"),
    );

    const memory = JSON.parse(readFileSync(join(item.workspace, ATOMIC_FIXTURE_PATHS.memoryProposal), "utf8"));
    assert.equal(memory.status, "proposed");
    assert.equal(memory.automatic_capture, false);
    assert.equal(memory.canonical_promotion, false);
    const draftPr = JSON.parse(readFileSync(join(item.workspace, ATOMIC_FIXTURE_PATHS.draftPrMock), "utf8"));
    assert.equal(draftPr.mock, true);
    assert.equal(draftPr.external_request_performed, false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic fixture inputs reject an unreviewed source hash and extra authority", () => {
  const valid = {
    control_plane_run_id: "run_atomic_fixture_input",
    contract_sha256: "a".repeat(64),
    expected_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  };
  assert.deepEqual(validateAtomicFixtureInputs(valid), valid);
  assert.throws(
    () => validateAtomicFixtureInputs({ ...valid, expected_before_sha256: "b".repeat(64) }),
    /reviewed disposable fixture/,
  );
  assert.throws(
    () => validateAtomicFixtureInputs({ ...valid, command: "arbitrary" }),
    /must contain exactly/,
  );
});

test("Atomic fixture command output bound is aggregate across stdout and stderr", async () => {
  await assert.rejects(
    runBoundedCommand(process.execPath, [
      "-e",
      "process.stdout.write('123456'); process.stderr.write('abcdef');",
    ], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 10,
    }),
    /exceeded its aggregate output bound/,
  );
});

test("Atomic fixture preflight rejects an unbound or non-integer writer fence", async () => {
  const item = fixture();
  const manifestPath = join(item.context, "atomic-launch-manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const missingOwner = structuredClone(manifest);
    delete missingOwner.writer_lease.owner_id;
    writeFileSync(manifestPath, `${JSON.stringify(missingOwner)}\n`, "utf8");
    await assert.rejects(preflightAtomicFixture({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
    }), /owner_id/);

    const nonIntegerFence = structuredClone(manifest);
    nonIntegerFence.writer_lease.fencing_token = 1.5;
    writeFileSync(manifestPath, `${JSON.stringify(nonIntegerFence)}\n`, "utf8");
    await assert.rejects(preflightAtomicFixture({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
    }), /positive integer/);

    const unsafeFence = structuredClone(manifest);
    unsafeFence.writer_lease.fencing_token = Number.MAX_SAFE_INTEGER + 1;
    writeFileSync(manifestPath, `${JSON.stringify(unsafeFence)}\n`, "utf8");
    await assert.rejects(preflightAtomicFixture({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
    }), /safe range/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic fixture preflight rejects a staged executable core that differs from the contract binding", async () => {
  const item = fixture();
  try {
    writeFileSync(
      join(item.context, "atomic-package", "lib", "atomic-fixture-pilot-core.mjs"),
      "export const tampered = true;\n",
      "utf8",
    );
    await assert.rejects(preflightAtomicFixture({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
    }), /package identity does not match/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
