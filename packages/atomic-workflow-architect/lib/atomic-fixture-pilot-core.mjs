import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const ATOMIC_FIXTURE_WORKFLOW_NAME = "atomic-fixture-pilot";
export const ATOMIC_FIXTURE_WORKFLOW_VERSION = "1.0.0";
export const ATOMIC_FIXTURE_REQUEST =
  "Implement normalizeProjectSlug in the disposable Atomic pilot fixture and stop after verified evidence for control-plane approval.";
export const ATOMIC_FIXTURE_TARGET = "src/normalize-project-slug.js";
export const ATOMIC_FIXTURE_TEST = "test/normalize-project-slug.test.js";
export const ATOMIC_FIXTURE_CONTRACT = "run-contract.json";
export const ATOMIC_FIXTURE_CONTEXT_PACK = "context-pack.json";
export const ATOMIC_FIXTURE_LAUNCH_MANIFEST = "atomic-launch-manifest.json";
export const ATOMIC_FIXTURE_STAGED_WORKFLOW = "atomic-package/workflows/atomic-fixture-pilot.ts";
export const ATOMIC_FIXTURE_STAGED_CORE = "atomic-package/lib/atomic-fixture-pilot-core.mjs";
export const ATOMIC_FIXTURE_STAGED_PACKAGE_JSON = "atomic-package/package.json";
export const ATOMIC_FIXTURE_PACKAGE_NAME = "wesley-atomic-workflow-architect";
export const ATOMIC_FIXTURE_PACKAGE_VERSION = "0.2.1";
export const ATOMIC_FIXTURE_CONTEXT_ROOT = "/run-context";
export const ATOMIC_FIXTURE_OUTPUT_ROOT = ".valkyrie-output";
export const ATOMIC_FIXTURE_PATHS = Object.freeze({
  evidence: ".valkyrie-output/evidence.json",
  patch: ".valkyrie-output/candidate.patch",
  checks: ".valkyrie-output/checks.json",
  verifier: ".valkyrie-output/verifier.json",
  memoryProposal: ".valkyrie-output/memory-proposal.json",
  draftPrMock: ".valkyrie-output/draft-pr-mock.json",
  contextPack: ".valkyrie-output/context-pack.json",
  runContract: ".valkyrie-output/run-contract.json",
  launchManifest: ".valkyrie-output/atomic-launch-manifest.json",
});
export const ATOMIC_FIXTURE_BOUNDS = Object.freeze({
  max_elapsed_seconds: 120,
  max_command_seconds: 15,
  max_output_bytes_per_command: 65_536,
  max_turns: 1,
  max_repair_rounds: 0,
  max_concurrency: 1,
  max_child_depth: 0,
});
export const ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256 =
  "8db91027a68c9d7bd68bb2c3d04e592ca29039f15b8df506cfce0de6e27f69d2";
export const ATOMIC_FIXTURE_TEST_SHA256 =
  "6579991c2416d72108ff5dead2d3889a7c2f4adc50c5eeaa2e2a896396f751da";
export const ATOMIC_FIXTURE_IMPLEMENTATION = `export function normalizeProjectSlug(value) {
  if (typeof value !== "string") {
    throw new TypeError("Project slug must be a string");
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new TypeError("Project slug must contain at least one alphanumeric character");
  }

  return normalized;
}
`;
export const ATOMIC_FIXTURE_IMPLEMENTATION_SHA256 = sha256(ATOMIC_FIXTURE_IMPLEMENTATION);

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FIXED_INPUT_NAMES = [
  "contract_sha256",
  "control_plane_run_id",
  "expected_before_sha256",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new Error("control_plane_run_id must be a safe 1-128 character run ID");
  }
  return value;
}

export function validateAtomicFixtureInputs(value) {
  const input = plainObject(value, "Atomic fixture inputs");
  const names = Object.keys(input).sort();
  if (names.length !== FIXED_INPUT_NAMES.length
    || names.some((name, index) => name !== FIXED_INPUT_NAMES[index])) {
    throw new Error(`Atomic fixture inputs must contain exactly ${FIXED_INPUT_NAMES.join(", ")}`);
  }
  const expectedBefore = assertHash(input.expected_before_sha256, "expected_before_sha256");
  if (expectedBefore !== ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256) {
    throw new Error("expected_before_sha256 does not identify the reviewed disposable fixture");
  }
  return Object.freeze({
    control_plane_run_id: assertRunId(input.control_plane_run_id),
    contract_sha256: assertHash(input.contract_sha256, "contract_sha256"),
    expected_before_sha256: expectedBefore,
  });
}

function assertContained(root, candidate, label) {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escaped its fixed root`);
  }
}

async function readFixedRegularFile(rootPath, relativePath, label) {
  const root = resolve(rootPath);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root must be a regular non-symlink directory`);
  }
  const realRoot = await realpath(root);
  const candidate = resolve(root, ...relativePath.split("/"));
  assertContained(root, candidate, label);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const realCandidate = await realpath(candidate);
  assertContained(realRoot, realCandidate, label);
  const body = await readFile(realCandidate);
  if (body.byteLength > 256 * 1024) throw new Error(`${label} exceeds its fixed size bound`);
  return { path: realCandidate, body, sha256: sha256(body) };
}

function commandError(executable, args, result) {
  const error = new Error(
    `${executable} ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
  );
  error.exitCode = result.exitCode;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  return error;
}

export function runBoundedCommand(executable, args, options) {
  const timeoutMs = options.timeoutMs ?? ATOMIC_FIXTURE_BOUNDS.max_command_seconds * 1_000;
  const maxOutputBytes = options.maxOutputBytes ?? ATOMIC_FIXTURE_BOUNDS.max_output_bytes_per_command;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_VALUE_0: options.cwd,
        HOME: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NO_COLOR: "1",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(rejectPromise, new Error(`${executable} was cancelled`));
    };
    const collect = (stream, chunk) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(rejectPromise, new Error(`${executable} exceeded its aggregate output bound`));
        return;
      }
      const combined = Buffer.concat([stream === "stdout" ? stdout : stderr, chunk]);
      if (stream === "stdout") stdout = combined;
      else stderr = combined;
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(rejectPromise, new Error(`${executable} exceeded its ${timeoutMs}ms timeout`));
    }, timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => finish(rejectPromise, error));
    child.once("close", (code, signal) => {
      const result = {
        exitCode: typeof code === "number" ? code : -1,
        signal: signal ?? null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      };
      finish(resolvePromise, result);
    });
  });
}

async function requireSuccessfulCommand(executable, args, options) {
  const result = await runBoundedCommand(executable, args, options);
  if (result.exitCode !== 0) throw commandError(executable, args, result);
  return result;
}

function assertContract(contract, inputs, packageIdentity) {
  if (contract.runId !== inputs.control_plane_run_id) throw new Error("Run contract does not match the control-plane run ID");
  if (contract.request !== ATOMIC_FIXTURE_REQUEST) throw new Error("Run contract request is not the literal reviewed fixture task");
  if (contract.rootRuntime !== "atomic") throw new Error("Run contract rootRuntime must be atomic");
  if (contract.workflow !== ATOMIC_FIXTURE_WORKFLOW_NAME) throw new Error("Run contract workflow mismatch");
  if (contract.finalAction !== "stop_before_external_action") {
    throw new Error("Run contract finalAction must stop before external action");
  }
  if (contract.automaticEpisodicCapture !== false) {
    throw new Error("Run contract must keep automatic episodic capture disabled");
  }
  if (typeof contract.projectId !== "string" || !contract.projectId) throw new Error("Run contract projectId is required");
  const contextPack = plainObject(contract.contextPack, "Run contract contextPack");
  assertHash(contextPack.checksum, "Run contract contextPack.checksum");
  const atomicPackage = plainObject(contract.atomicPackage, "Run contract atomicPackage");
  if (atomicPackage.name !== ATOMIC_FIXTURE_PACKAGE_NAME
      || atomicPackage.version !== ATOMIC_FIXTURE_PACKAGE_VERSION
      || atomicPackage.workflowSha256 !== packageIdentity.workflowSha256
      || atomicPackage.coreSha256 !== packageIdentity.coreSha256
      || atomicPackage.packageJsonSha256 !== packageIdentity.packageJsonSha256) {
    throw new Error("Run contract Atomic package identity does not match the staged reviewed executable package");
  }
}

function assertContextPack(contextPack, contract, inputs) {
  if (contextPack.runId !== inputs.control_plane_run_id) throw new Error("Context pack does not match the control-plane run ID");
  if (contextPack.projectId !== contract.projectId) throw new Error("Context pack projectId does not match the run contract");
  if (contextPack.objective !== ATOMIC_FIXTURE_REQUEST) throw new Error("Context pack objective is not the literal fixture task");
  if (contextPack.automaticEpisodicCapture !== false) {
    throw new Error("Context pack must keep automatic episodic capture disabled");
  }
}

function assertLaunchManifest(launch, contract, inputs, stagedWorkflow) {
  if (launch.schema_version !== "1.1.0") throw new Error("Launch manifest schema_version must be 1.1.0");
  if (launch.run_id !== inputs.control_plane_run_id) throw new Error("Launch manifest does not match the control-plane run ID");
  if (launch.project_id !== contract.projectId) throw new Error("Launch manifest project_id does not match the run contract");
  if (launch.request !== ATOMIC_FIXTURE_REQUEST) throw new Error("Launch manifest request is not the literal fixture task");
  if (launch.root_runtime !== "atomic") throw new Error("Launch manifest root_runtime must be atomic");
  const workflow = plainObject(launch.workflow, "Launch manifest workflow");
  if (workflow.name !== ATOMIC_FIXTURE_WORKFLOW_NAME || workflow.version !== ATOMIC_FIXTURE_WORKFLOW_VERSION) {
    throw new Error("Launch manifest workflow identity mismatch");
  }
  if (workflow.trust_state !== "package-reviewed") throw new Error("Launch manifest workflow must be package-reviewed");
  if (workflow.path !== stagedWorkflow.path || workflow.content_hash !== `sha256:${stagedWorkflow.sha256}`) {
    throw new Error("Launch manifest workflow path/hash does not match the staged read-only package");
  }
  if (launch.workspace_owner !== "control-plane") throw new Error("Launch manifest workspace_owner must be control-plane");
  if (typeof launch.workspace_id !== "string" || !launch.workspace_id) throw new Error("Launch manifest workspace_id is required");
  const writerLease = plainObject(launch.writer_lease, "Launch manifest writer_lease");
  if (writerLease.holder_run_id !== inputs.control_plane_run_id) {
    throw new Error("Launch manifest writer lease holder does not match the control-plane run ID");
  }
  if (writerLease.workspace_id !== launch.workspace_id) {
    throw new Error("Launch manifest writer lease workspace does not match workspace_id");
  }
  if (typeof writerLease.owner_id !== "string" || !writerLease.owner_id) {
    throw new Error("Launch manifest writer lease owner_id is required");
  }
  if (!Number.isSafeInteger(writerLease.fencing_token) || writerLease.fencing_token < 1) {
    throw new Error("Launch manifest writer lease fencing_token must be a positive integer within the safe range");
  }
  if (launch.crossProcessResume !== false) throw new Error("Launch manifest crossProcessResume must remain false");
  if (launch.final_action !== "stop_before_pr") throw new Error("Launch manifest final_action must stop before PR creation");
  const bounds = plainObject(launch.bounds, "Launch manifest bounds");
  if (bounds.max_duration_minutes !== 2
    || bounds.max_turns !== ATOMIC_FIXTURE_BOUNDS.max_turns
    || bounds.max_repairs !== ATOMIC_FIXTURE_BOUNDS.max_repair_rounds
    || bounds.max_child_depth !== ATOMIC_FIXTURE_BOUNDS.max_child_depth
    || bounds.max_concurrency !== ATOMIC_FIXTURE_BOUNDS.max_concurrency) {
    throw new Error("Launch manifest bounds do not match the reviewed fixture workflow bounds");
  }
}

export async function preflightAtomicFixture(options) {
  const inputs = validateAtomicFixtureInputs(options.inputs);
  const workspacePath = await realpath(resolve(options.workspacePath));
  const contextRoot = options.contextRoot ?? ATOMIC_FIXTURE_CONTEXT_ROOT;
  const source = await readFixedRegularFile(workspacePath, ATOMIC_FIXTURE_TARGET, "Fixture source");
  const test = await readFixedRegularFile(workspacePath, ATOMIC_FIXTURE_TEST, "Fixture test");
  const contract = await readFixedRegularFile(
    contextRoot,
    ATOMIC_FIXTURE_CONTRACT,
    "Run contract",
  );
  const contextPack = await readFixedRegularFile(
    contextRoot,
    ATOMIC_FIXTURE_CONTEXT_PACK,
    "Context pack",
  );
  const launchManifest = await readFixedRegularFile(
    contextRoot,
    ATOMIC_FIXTURE_LAUNCH_MANIFEST,
    "Atomic launch manifest",
  );
  const stagedWorkflow = await readFixedRegularFile(
    contextRoot,
    ATOMIC_FIXTURE_STAGED_WORKFLOW,
    "Staged Atomic fixture workflow",
  );
  const stagedCore = await readFixedRegularFile(
    contextRoot,
    ATOMIC_FIXTURE_STAGED_CORE,
    "Staged Atomic fixture executable core",
  );
  const stagedPackageJson = await readFixedRegularFile(
    contextRoot,
    ATOMIC_FIXTURE_STAGED_PACKAGE_JSON,
    "Staged Atomic package manifest",
  );
  if (source.sha256 !== inputs.expected_before_sha256) throw new Error("Fixture source does not match expected_before_sha256");
  if (test.sha256 !== ATOMIC_FIXTURE_TEST_SHA256) throw new Error("Fixture tests do not match the reviewed test contract");
  if (contract.sha256 !== inputs.contract_sha256) throw new Error("Run contract content does not match contract_sha256");
  let parsed;
  try {
    parsed = plainObject(JSON.parse(contract.body.toString("utf8")), "Run contract");
  } catch (error) {
    throw new Error("Run contract is not valid JSON", { cause: error });
  }
  let packageManifest;
  try {
    packageManifest = plainObject(JSON.parse(stagedPackageJson.body.toString("utf8")), "Staged Atomic package manifest");
  } catch (error) {
    throw new Error("Staged Atomic package manifest is not valid JSON", { cause: error });
  }
  if (packageManifest.name !== ATOMIC_FIXTURE_PACKAGE_NAME || packageManifest.version !== ATOMIC_FIXTURE_PACKAGE_VERSION) {
    throw new Error("Staged Atomic package name/version is not the reviewed fixture package");
  }
  const packageIdentity = {
    name: ATOMIC_FIXTURE_PACKAGE_NAME,
    version: ATOMIC_FIXTURE_PACKAGE_VERSION,
    workflowSha256: stagedWorkflow.sha256,
    coreSha256: stagedCore.sha256,
    packageJsonSha256: stagedPackageJson.sha256,
  };
  assertContract(parsed, inputs, packageIdentity);
  const contractContext = plainObject(parsed.contextPack, "Run contract contextPack");
  if (contractContext.checksum !== contextPack.sha256) throw new Error("Context pack content does not match the run contract checksum");
  let parsedContextPack;
  let parsedLaunchManifest;
  try {
    parsedContextPack = plainObject(JSON.parse(contextPack.body.toString("utf8")), "Context pack");
    parsedLaunchManifest = plainObject(JSON.parse(launchManifest.body.toString("utf8")), "Atomic launch manifest");
  } catch (error) {
    throw new Error("Context pack or Atomic launch manifest is not valid JSON", { cause: error });
  }
  assertContextPack(parsedContextPack, parsed, inputs);
  assertLaunchManifest(parsedLaunchManifest, parsed, inputs, stagedWorkflow);

  const gitPath = options.gitPath ?? "/usr/bin/git";
  const clean = await requireSuccessfulCommand(gitPath, ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: workspacePath,
    signal: options.signal,
  });
  if (clean.stdout !== "") throw new Error("Disposable fixture must be clean before Atomic writes");
  return {
    control_plane_run_id: inputs.control_plane_run_id,
    contract_sha256: contract.sha256,
    expected_before_sha256: source.sha256,
    test_sha256: test.sha256,
    context_pack_sha256: contextPack.sha256,
    launch_manifest_sha256: launchManifest.sha256,
    atomic_workflow_sha256: stagedWorkflow.sha256,
    atomic_core_sha256: stagedCore.sha256,
    atomic_package_json_sha256: stagedPackageJson.sha256,
    atomic_package_name: ATOMIC_FIXTURE_PACKAGE_NAME,
    atomic_package_version: ATOMIC_FIXTURE_PACKAGE_VERSION,
    project_id: parsed.projectId,
    task_id: typeof parsed.taskId === "string" ? parsed.taskId : null,
    request: parsed.request,
    final_action: parsed.finalAction,
    workspace_path: workspacePath,
  };
}

export async function applyReviewedAtomicFixtureImplementation(options) {
  const source = await readFixedRegularFile(options.workspacePath, ATOMIC_FIXTURE_TARGET, "Fixture source");
  if (source.sha256 === ATOMIC_FIXTURE_IMPLEMENTATION_SHA256) {
    return { source_after_sha256: source.sha256, recovered_identical_write: true };
  }
  if (source.sha256 !== options.expectedBeforeSha256
    || options.expectedBeforeSha256 !== ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256) {
    throw new Error("Fixture source changed after preflight");
  }
  await writeFile(source.path, ATOMIC_FIXTURE_IMPLEMENTATION, { encoding: "utf8", flag: "w", mode: 0o644 });
  const after = await readFixedRegularFile(options.workspacePath, ATOMIC_FIXTURE_TARGET, "Fixture source");
  if (after.sha256 !== ATOMIC_FIXTURE_IMPLEMENTATION_SHA256) throw new Error("Reviewed fixture implementation write was not exact");
  return { source_after_sha256: after.sha256, recovered_identical_write: false };
}

async function writeStableArtifact(workspacePath, relativePath, value) {
  const workspace = await realpath(resolve(workspacePath));
  const destination = resolve(workspace, ...relativePath.split("/"));
  assertContained(workspace, destination, "Fixture artifact");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const realParent = await realpath(dirname(destination));
  assertContained(workspace, realParent, "Fixture artifact parent");
  const body = typeof value === "string" ? value : canonicalJson(value);
  try {
    await writeFile(destination, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Existing ${relativePath} must be a single-link regular file`);
    }
    const realDestination = await realpath(destination);
    assertContained(workspace, realDestination, "Existing fixture artifact");
    const existing = await readFile(destination, "utf8");
    if (existing !== body) throw new Error(`Existing ${relativePath} does not match deterministic replay`);
  }
  return { path: relativePath, sha256: sha256(body), size_bytes: Buffer.byteLength(body) };
}

function exactChangedPath(porcelain) {
  const entries = porcelain.split("\0").filter(Boolean);
  return entries.length === 1 && entries[0] === ` M ${ATOMIC_FIXTURE_TARGET}`;
}

export async function runAtomicFixtureChecks(options) {
  const workspacePath = await realpath(resolve(options.workspacePath));
  const nodePath = options.nodePath ?? "/usr/local/bin/node";
  const gitPath = options.gitPath ?? "/usr/bin/git";
  const node = await requireSuccessfulCommand(nodePath, ["--test"], { cwd: workspacePath, signal: options.signal });
  const diffCheck = await requireSuccessfulCommand(gitPath, ["diff", "--check"], { cwd: workspacePath, signal: options.signal });
  const status = await requireSuccessfulCommand(gitPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: workspacePath,
    signal: options.signal,
  });
  if (!exactChangedPath(status.stdout)) throw new Error("Atomic fixture changed paths outside the exact source allowlist");
  const source = await readFixedRegularFile(workspacePath, ATOMIC_FIXTURE_TARGET, "Fixture source");
  if (source.sha256 !== ATOMIC_FIXTURE_IMPLEMENTATION_SHA256) throw new Error("Fixture implementation is not the reviewed candidate");
  const report = {
    schema_version: "1.0.0",
    passed: true,
    source_after_sha256: source.sha256,
    changed_paths: [ATOMIC_FIXTURE_TARGET],
    commands: [
      { argv: ["/usr/local/bin/node", "--test"], exit_code: node.exitCode, passed: true },
      { argv: ["/usr/bin/git", "diff", "--check"], exit_code: diffCheck.exitCode, passed: true },
    ],
    change_gate: { exact_allowlist: [ATOMIC_FIXTURE_TARGET], passed: true },
  };
  const artifact = await writeStableArtifact(workspacePath, ATOMIC_FIXTURE_PATHS.checks, report);
  return { ...report, artifact };
}

export async function runAtomicFixtureVerifier(options) {
  if (options.checks?.passed !== true) throw new Error("Independent verifier requires a passing check artifact");
  const workspacePath = await realpath(resolve(options.workspacePath));
  const checksFile = await readFixedRegularFile(workspacePath, ATOMIC_FIXTURE_PATHS.checks, "Check artifact");
  const source = await readFixedRegularFile(workspacePath, ATOMIC_FIXTURE_TARGET, "Fixture source");
  const test = await readFixedRegularFile(workspacePath, ATOMIC_FIXTURE_TEST, "Fixture test");
  if (checksFile.sha256 !== options.checks.artifact.sha256) throw new Error("Check artifact changed before independent verification");
  if (source.sha256 !== ATOMIC_FIXTURE_IMPLEMENTATION_SHA256) throw new Error("Independent verifier rejected the candidate source hash");
  if (test.sha256 !== ATOMIC_FIXTURE_TEST_SHA256) throw new Error("Independent verifier rejected the fixture test hash");

  const candidateUrl = pathToFileURL(join(workspacePath, ATOMIC_FIXTURE_TARGET)).href;
  const probe = [
    `import { normalizeProjectSlug } from ${JSON.stringify(candidateUrl)};`,
    `const cases = ${JSON.stringify([
      ["  Wesley Project OS  ", "wesley-project-os"],
      ["---Ovalo___M5 / Pilot---", "ovalo-m5-pilot"],
    ])};`,
    "for (const [input, expected] of cases) { if (normalizeProjectSlug(input) !== expected) process.exit(21); }",
    "try { normalizeProjectSlug(' -- ___ '); process.exit(22); } catch (error) { if (!/alphanumeric/.test(String(error))) process.exit(23); }",
    "try { normalizeProjectSlug(42); process.exit(24); } catch (error) { if (!/string/.test(String(error))) process.exit(25); }",
  ].join("\n");
  const nodePath = options.nodePath ?? "/usr/local/bin/node";
  await requireSuccessfulCommand(nodePath, ["--input-type=module", "--eval", probe], {
    cwd: workspacePath,
    signal: options.signal,
  });
  const report = {
    schema_version: "1.0.0",
    context_mode: "fresh-deterministic-process",
    passed: true,
    inputs: {
      contract_sha256: options.contractSha256,
      checks_sha256: checksFile.sha256,
      source_sha256: source.sha256,
      tests_sha256: test.sha256,
    },
    acceptance: {
      trim_and_lowercase: true,
      collapse_non_alphanumeric_runs: true,
      trim_hyphens: true,
      reject_empty_after_normalization: true,
      reject_non_string: true,
    },
    model_execution_attempted: false,
  };
  const artifact = await writeStableArtifact(workspacePath, ATOMIC_FIXTURE_PATHS.verifier, report);
  return { ...report, artifact };
}

export async function emitAtomicFixtureEvidence(options) {
  const workspacePath = await realpath(resolve(options.workspacePath));
  const gitPath = options.gitPath ?? "/usr/bin/git";
  const patchResult = await requireSuccessfulCommand(
    gitPath,
    ["diff", "--no-ext-diff", "--", ATOMIC_FIXTURE_TARGET],
    { cwd: workspacePath, signal: options.signal },
  );
  if (!patchResult.stdout.startsWith(`diff --git a/${ATOMIC_FIXTURE_TARGET} b/${ATOMIC_FIXTURE_TARGET}\n`)) {
    throw new Error("Candidate patch did not contain the exact fixture source diff");
  }
  const patch = await writeStableArtifact(workspacePath, ATOMIC_FIXTURE_PATHS.patch, patchResult.stdout);
  const contextRoot = options.contextRoot ?? ATOMIC_FIXTURE_CONTEXT_ROOT;
  const contextPackSource = await readFixedRegularFile(contextRoot, ATOMIC_FIXTURE_CONTEXT_PACK, "Context pack");
  const runContractSource = await readFixedRegularFile(contextRoot, ATOMIC_FIXTURE_CONTRACT, "Run contract");
  const launchManifestSource = await readFixedRegularFile(contextRoot, ATOMIC_FIXTURE_LAUNCH_MANIFEST, "Atomic launch manifest");
  if (contextPackSource.sha256 !== options.preflight.context_pack_sha256
    || runContractSource.sha256 !== options.preflight.contract_sha256
    || launchManifestSource.sha256 !== options.preflight.launch_manifest_sha256) {
    throw new Error("Run context changed after Atomic preflight");
  }
  const contextPackCopy = await writeStableArtifact(
    workspacePath,
    ATOMIC_FIXTURE_PATHS.contextPack,
    contextPackSource.body.toString("utf8"),
  );
  const runContractCopy = await writeStableArtifact(
    workspacePath,
    ATOMIC_FIXTURE_PATHS.runContract,
    runContractSource.body.toString("utf8"),
  );
  const launchManifestCopy = await writeStableArtifact(
    workspacePath,
    ATOMIC_FIXTURE_PATHS.launchManifest,
    launchManifestSource.body.toString("utf8"),
  );
  const memoryProposal = await writeStableArtifact(workspacePath, ATOMIC_FIXTURE_PATHS.memoryProposal, {
    schema_version: "1.0.0",
    status: "proposed",
    namespace: `projects/${options.preflight.project_id}`,
    proposition: "The disposable Atomic pilot candidate satisfied its fixed normalization contract and deterministic verifier.",
    evidence_ref: ATOMIC_FIXTURE_PATHS.evidence,
    evidence_binding: {
      control_plane_run_id: options.preflight.control_plane_run_id,
      contract_sha256: options.preflight.contract_sha256,
      source_after_sha256: options.implementation.source_after_sha256,
    },
    automatic_capture: false,
    canonical_promotion: false,
    promotion_requires_separate_human_action: true,
  });
  const draftPrMock = await writeStableArtifact(workspacePath, ATOMIC_FIXTURE_PATHS.draftPrMock, {
    schema_version: "1.0.0",
    mock: true,
    title: "Implement normalizeProjectSlug in disposable Atomic pilot fixture",
    body: "Deterministic integration evidence only. No GitHub request was made.",
    changed_paths: [ATOMIC_FIXTURE_TARGET],
    external_request_performed: false,
    requires_separate_control_plane_approval: true,
  });
  const evidence = {
    schema_version: "1.0.0",
    workflow: {
      name: ATOMIC_FIXTURE_WORKFLOW_NAME,
      version: ATOMIC_FIXTURE_WORKFLOW_VERSION,
      content_sha256: options.preflight.atomic_workflow_sha256,
      native_run_id: options.nativeRunId,
      root_runtime: "atomic",
      model_execution_attempted: false,
      network_required: "none",
    },
    atomic_package: {
      name: options.preflight.atomic_package_name,
      version: options.preflight.atomic_package_version,
      workflow_sha256: options.preflight.atomic_workflow_sha256,
      core_sha256: options.preflight.atomic_core_sha256,
      package_json_sha256: options.preflight.atomic_package_json_sha256,
    },
    control_plane_run_id: options.preflight.control_plane_run_id,
    contract_sha256: options.preflight.contract_sha256,
    source_before_sha256: options.preflight.expected_before_sha256,
    source_after_sha256: options.implementation.source_after_sha256,
    test_sha256: options.preflight.test_sha256,
    changed_paths: [ATOMIC_FIXTURE_TARGET],
    checks_passed: options.checks.passed === true,
    verifier_passed: options.verifier.passed === true,
    repair_count: 0,
    final_action: "stop_before_external_action",
    bounds: ATOMIC_FIXTURE_BOUNDS,
    artifacts: {
      patch,
      checks: options.checks.artifact,
      verifier: options.verifier.artifact,
      memory_proposal: memoryProposal,
      draft_pr_mock: draftPrMock,
      context_pack: contextPackCopy,
      run_contract: runContractCopy,
      atomic_launch_manifest: launchManifestCopy,
    },
    context_copies: {
      context_pack: {
        path: contextPackCopy.path,
        source_sha256: contextPackSource.sha256,
        copied_sha256: contextPackCopy.sha256,
        checksum_equal: contextPackSource.sha256 === contextPackCopy.sha256,
      },
      run_contract: {
        path: runContractCopy.path,
        source_sha256: runContractSource.sha256,
        copied_sha256: runContractCopy.sha256,
        checksum_equal: runContractSource.sha256 === runContractCopy.sha256,
      },
      atomic_launch_manifest: {
        path: launchManifestCopy.path,
        source_sha256: launchManifestSource.sha256,
        copied_sha256: launchManifestCopy.sha256,
        checksum_equal: launchManifestSource.sha256 === launchManifestCopy.sha256,
      },
    },
    external_actions: {
      github_request_performed: false,
      memory_promoted: false,
      deployment_performed: false,
    },
  };
  const evidenceArtifact = await writeStableArtifact(workspacePath, ATOMIC_FIXTURE_PATHS.evidence, evidence);
  return {
    evidence_manifest_path: evidenceArtifact.path,
    patch_path: patch.path,
    check_path: options.checks.artifact.path,
    verifier_path: options.verifier.artifact.path,
    memory_proposal_path: memoryProposal.path,
    draft_pr_mock_path: draftPrMock.path,
    context_pack_path: contextPackCopy.path,
    run_contract_path: runContractCopy.path,
    launch_manifest_path: launchManifestCopy.path,
    source_after_sha256: options.implementation.source_after_sha256,
    repair_count: 0,
    checks_passed: true,
    verifier_passed: true,
  };
}
