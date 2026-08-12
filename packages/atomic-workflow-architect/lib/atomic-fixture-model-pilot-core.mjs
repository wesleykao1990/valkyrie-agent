import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  ATOMIC_FIXTURE_TARGET,
  ATOMIC_FIXTURE_TEST,
  runBoundedCommand,
} from "./atomic-fixture-pilot-core.mjs";

export const ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME = "atomic-fixture-model-pilot";
export const ATOMIC_FIXTURE_MODEL_WORKFLOW_VERSION = "0.1.0-prelive";
export const ATOMIC_FIXTURE_MODEL_REQUEST =
  "Implement normalizeProjectSlug in the disposable Atomic pilot fixture using the bounded model workflow and stop after verified evidence for control-plane approval.";
export const ATOMIC_FIXTURE_MODEL_CONTEXT_ROOT = "/run-context";
export const ATOMIC_FIXTURE_MODEL_OUTPUT_ROOT = ".valkyrie-model-output";
export const ATOMIC_FIXTURE_MODEL_ALIASES = Object.freeze({
  implementer: "valkyrie-implementer/fixture-implementer:medium",
  verifier_initial: "valkyrie-verifier-initial/fixture-verifier-initial:medium",
  repair: "valkyrie-repair/fixture-repair:medium",
  verifier_final: "valkyrie-verifier-final/fixture-verifier-final:medium",
});
export const ATOMIC_FIXTURE_MODEL_BOUNDS = Object.freeze({
  max_elapsed_seconds: 240,
  max_command_seconds: 15,
  max_output_bytes_per_command: 65_536,
  max_turns: 4,
  max_repair_rounds: 1,
  max_concurrency: 1,
  max_child_depth: 0,
});
export const ATOMIC_FIXTURE_MODEL_PATHS = Object.freeze({
  evidence: ".valkyrie-model-output/evidence.json",
  patch: ".valkyrie-model-output/candidate.patch",
  checksInitial: ".valkyrie-model-output/checks-initial.json",
  verifierInitial: ".valkyrie-model-output/verifier-initial.json",
  checksFinal: ".valkyrie-model-output/checks-final.json",
  verifierFinal: ".valkyrie-model-output/verifier-final.json",
  memoryProposal: ".valkyrie-model-output/memory-proposal.json",
  draftPrMock: ".valkyrie-model-output/draft-pr-mock.json",
  contextPack: ".valkyrie-model-output/context-pack.json",
  runContract: ".valkyrie-model-output/run-contract.json",
  launchManifest: ".valkyrie-model-output/atomic-model-launch-manifest.json",
});

const SHA = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INPUTS = ["capability_policy_sha256", "contract_sha256", "control_plane_run_id", "expected_before_sha256", "package_sha256"];

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function digest(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function contained(root, candidate, label) {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new Error(`${label} escaped its root`);
}
async function readRegular(rootInput, relativePath, label, max = 512 * 1024) {
  const root = resolve(rootInput);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} root is invalid`);
  const realRoot = await realpath(root);
  const candidate = resolve(root, ...relativePath.split("/"));
  contained(root, candidate, label);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw new Error(`${label} is not a bounded regular file`);
  const real = await realpath(candidate);
  contained(realRoot, real, label);
  const body = await readFile(real);
  return { body, sha256: hash(body), path: real };
}
async function writeArtifact(workspace, relativePath, value) {
  const destination = resolve(workspace, ...relativePath.split("/"));
  contained(resolve(workspace), destination, "model artifact");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, Buffer.isBuffer(value) || typeof value === "string" ? value : json(value), { mode: 0o600 });
  const body = await readFile(destination);
  return { path: relativePath, sha256: hash(body), size_bytes: body.byteLength };
}

export function validateAtomicFixtureModelInputs(value) {
  const input = object(value, "Atomic model fixture inputs");
  const names = Object.keys(input).sort();
  if (names.length !== INPUTS.length || names.some((name, index) => name !== INPUTS[index])) {
    throw new Error(`Atomic model fixture inputs must contain exactly ${INPUTS.join(", ")}`);
  }
  if (typeof input.control_plane_run_id !== "string" || !SAFE_ID.test(input.control_plane_run_id)) throw new Error("control_plane_run_id is invalid");
  if (input.expected_before_sha256 !== ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256) throw new Error("expected_before_sha256 is not the reviewed fixture");
  return Object.freeze({
    control_plane_run_id: input.control_plane_run_id,
    contract_sha256: digest(input.contract_sha256, "contract_sha256"),
    expected_before_sha256: input.expected_before_sha256,
    capability_policy_sha256: digest(input.capability_policy_sha256, "capability_policy_sha256"),
    package_sha256: digest(input.package_sha256, "package_sha256"),
  });
}

export async function preflightAtomicFixtureModel(options) {
  const workspace = resolve(options.workspacePath);
  const context = resolve(options.contextRoot);
  const contractFile = await readRegular(context, "run-contract.json", "model run contract");
  if (contractFile.sha256 !== options.inputs.contract_sha256) throw new Error("Model run contract checksum mismatch");
  const contract = object(JSON.parse(contractFile.body.toString("utf8")), "model run contract");
  if (contract.runId !== options.inputs.control_plane_run_id || contract.workflow !== ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME
      || contract.request !== ATOMIC_FIXTURE_MODEL_REQUEST || contract.rootRuntime !== "atomic"
      || contract.finalAction !== "stop_before_external_action" || contract.crossProcessResume !== false) {
    throw new Error("Model run contract does not match the literal reviewed pilot");
  }
  const inference = object(contract.inference, "model run contract inference");
  if (inference.policySha256 !== options.inputs.capability_policy_sha256 || inference.credentialInWriter !== false
      || inference.fakeProvider !== false) throw new Error("Model inference policy binding is invalid");
  const packageIdentity = object(contract.atomicPackage, "model run contract package");
  if (packageIdentity.packageSha256 !== options.inputs.package_sha256) throw new Error("Model package digest binding is invalid");
  const launch = await readRegular(context, "atomic-model-launch-manifest.json", "model launch manifest");
  const launchValue = object(JSON.parse(launch.body.toString("utf8")), "model launch manifest");
  if (launchValue.schema_version !== "1.0.0-model-prelive" || launchValue.run_id !== options.inputs.control_plane_run_id
      || launchValue.inference_policy_sha256 !== options.inputs.capability_policy_sha256
      || launchValue.package_sha256 !== options.inputs.package_sha256 || launchValue.crossProcessResume !== false) {
    throw new Error("Model launch manifest binding is invalid");
  }
  const source = await readRegular(workspace, ATOMIC_FIXTURE_TARGET, "model fixture source");
  const test = await readRegular(workspace, ATOMIC_FIXTURE_TEST, "model fixture test");
  if (source.sha256 !== options.inputs.expected_before_sha256) throw new Error("Model fixture source changed before implementation");
  return { contract_sha256: contractFile.sha256, launch_manifest_sha256: launch.sha256, test_sha256: test.sha256 };
}

export async function runAtomicFixtureModelChecks(options) {
  const workspace = resolve(options.workspacePath);
  const nodePath = options.nodePath ?? "/usr/local/bin/node";
  const gitPath = options.gitPath ?? "/usr/bin/git";
  const commands = [
    [nodePath, ["--test"]],
    [gitPath, ["diff", "--check"]],
    [gitPath, ["diff", "--name-only"]],
  ];
  const results = [];
  for (const [command, args] of commands) {
    const result = await runBoundedCommand(command, args, {
      cwd: workspace, signal: options.signal,
      timeoutMs: ATOMIC_FIXTURE_MODEL_BOUNDS.max_command_seconds * 1_000,
      maxOutputBytes: ATOMIC_FIXTURE_MODEL_BOUNDS.max_output_bytes_per_command,
    });
    results.push({ argv: [command, ...args], exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }
  const changed = results[2].stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
  const passed = results.every((result) => result.exit_code === 0) && changed.length === 1 && changed[0] === ATOMIC_FIXTURE_TARGET;
  const findings = [];
  if (results[0].exit_code !== 0) findings.push("node_test_failed");
  if (results[1].exit_code !== 0) findings.push("git_diff_check_failed");
  if (changed.length !== 1 || changed[0] !== ATOMIC_FIXTURE_TARGET) findings.push("changed_file_scope_failed");
  const artifact = await writeArtifact(workspace, options.round === "initial" ? ATOMIC_FIXTURE_MODEL_PATHS.checksInitial : ATOMIC_FIXTURE_MODEL_PATHS.checksFinal, {
    schema_version: "1.0.0", round: options.round, passed, findings, commands: results,
  });
  return { passed, findings, artifact };
}

export async function writeAtomicFixtureModelReview(options) {
  const review = object(options.review, "model verifier result");
  if (typeof review.approved !== "boolean" || !Array.isArray(review.findings) || review.findings.length > 8
      || review.findings.some((item) => typeof item !== "string" || item.length < 1 || item.length > 500)) {
    throw new Error("Model verifier result is outside its schema bound");
  }
  if (review.approved && review.findings.length !== 0) throw new Error("An approved verifier result cannot retain findings");
  const path = options.round === "initial" ? ATOMIC_FIXTURE_MODEL_PATHS.verifierInitial : ATOMIC_FIXTURE_MODEL_PATHS.verifierFinal;
  const artifact = await writeArtifact(options.workspacePath, path, {
    schema_version: "1.0.0", round: options.round, context: "fresh", approved: review.approved, findings: review.findings,
  });
  return { approved: review.approved, findings: [...review.findings], artifact };
}

export async function emitAtomicFixtureModelEvidence(options) {
  if (!options.checks.passed || !options.verifier.approved) throw new Error("Model evidence cannot be emitted without passing checks and fresh verification");
  const workspace = resolve(options.workspacePath);
  const patchResult = await runBoundedCommand("/usr/bin/git", ["diff", "--binary", "--", ATOMIC_FIXTURE_TARGET], {
    cwd: workspace, signal: options.signal, timeoutMs: 15_000, maxOutputBytes: 256 * 1024,
  });
  if (patchResult.exitCode !== 0 || !patchResult.stdout.trim()) throw new Error("Model candidate patch is missing");
  const patch = await writeArtifact(workspace, ATOMIC_FIXTURE_MODEL_PATHS.patch, patchResult.stdout);
  const copied = {};
  for (const [name, source] of [["contextPack", "context-pack.json"], ["runContract", "run-contract.json"], ["launchManifest", "atomic-model-launch-manifest.json"]]) {
    const item = await readRegular(options.contextRoot, source, `model ${name}`);
    copied[name] = await writeArtifact(workspace, ATOMIC_FIXTURE_MODEL_PATHS[name], item.body);
  }
  const memoryProposal = await writeArtifact(workspace, ATOMIC_FIXTURE_MODEL_PATHS.memoryProposal, {
    schema_version: "1.0.0", state: "proposed", claim: "The bounded model pilot completed the disposable slug-normalization fixture.",
    promotion: "separate_review_required",
  });
  const draftPrMock = await writeArtifact(workspace, ATOMIC_FIXTURE_MODEL_PATHS.draftPrMock, {
    schema_version: "1.0.0", action: "mock_only", external_action_performed: false,
  });
  const evidenceValue = {
    schema_version: "1.0.0-model-prelive",
    control_plane_run_id: options.inputs.control_plane_run_id,
    native_workflow_run_id: String(options.nativeRunId),
    workflow: ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME,
    package_sha256: options.inputs.package_sha256,
    capability_policy_sha256: options.inputs.capability_policy_sha256,
    repair_count: options.repairCount,
    checks: options.checks.artifact,
    verifier: options.verifier.artifact,
    patch,
    memory_proposal: memoryProposal,
    draft_pr_mock: draftPrMock,
    context: copied,
    model_execution_expected: true,
    live_provider_verified: false,
    final_action: "stop_before_external_action",
  };
  const evidence = await writeArtifact(workspace, ATOMIC_FIXTURE_MODEL_PATHS.evidence, evidenceValue);
  return {
    evidence_manifest_path: evidence.path, patch_path: patch.path,
    checks_initial_path: ATOMIC_FIXTURE_MODEL_PATHS.checksInitial,
    verifier_initial_path: ATOMIC_FIXTURE_MODEL_PATHS.verifierInitial,
    checks_final_path: options.checks.artifact.path, verifier_final_path: options.verifier.artifact.path,
    memory_proposal_path: memoryProposal.path, draft_pr_mock_path: draftPrMock.path,
    context_pack_path: copied.contextPack.path, run_contract_path: copied.runContract.path,
    launch_manifest_path: copied.launchManifest.path, repair_count: options.repairCount,
    checks_passed: true, verifier_passed: true, live_provider_verified: false,
  };
}
