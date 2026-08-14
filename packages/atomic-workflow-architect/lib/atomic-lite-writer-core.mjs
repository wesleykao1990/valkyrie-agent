import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Atomic Lite is deliberately a contract-only package slice.  This module has
 * no HTTP/MCP/runtime dependency: it validates a control-plane handoff,
 * exposes bounded custom tools, runs literal deterministic checks, and emits
 * checksummed evidence.
 */
export const ATOMIC_LITE_WORKFLOW_NAME = "atomic-lite-writer";
export const ATOMIC_LITE_WORKFLOW_VERSION = "1.0.0";
export const ATOMIC_LITE_CONTEXT_ROOT = "/run-context";
export const ATOMIC_LITE_CONTRACT_PATH = "atomic-lite-contract.json";
export const ATOMIC_LITE_POLICY_PATH = "atomic-lite-policy.json";
export const ATOMIC_LITE_CONTEXT_PATH = "atomic-lite-context.json";
export const ATOMIC_LITE_GIT_EXECUTABLE = "/usr/bin/git";
// A killed check is not considered bounded until its child has either emitted
// close or this fixed grace period has elapsed.  This keeps timeout/output
// enforcement from resolving while a descendant still holds the pipes open.
export const ATOMIC_LITE_POST_KILL_CLOSE_MS = 1_000;
export const ATOMIC_LITE_OUTPUT_ROOT = ".valkyrie-atomic-lite-output";
export const ATOMIC_LITE_OUTPUT_PATHS = Object.freeze({
  evidence: `${ATOMIC_LITE_OUTPUT_ROOT}/evidence.json`,
  delta: `${ATOMIC_LITE_OUTPUT_ROOT}/delta.json`,
  patch: `${ATOMIC_LITE_OUTPUT_ROOT}/candidate.patch`,
  checksInitial: `${ATOMIC_LITE_OUTPUT_ROOT}/checks-initial.json`,
  checksFinal: `${ATOMIC_LITE_OUTPUT_ROOT}/checks-final.json`,
  review: `${ATOMIC_LITE_OUTPUT_ROOT}/review.json`,
  context: `${ATOMIC_LITE_OUTPUT_ROOT}/atomic-lite-context.json`,
  contract: `${ATOMIC_LITE_OUTPUT_ROOT}/atomic-lite-contract.json`,
  policy: `${ATOMIC_LITE_OUTPUT_ROOT}/atomic-lite-policy.json`,
});

export const ATOMIC_LITE_BOUNDS = Object.freeze({
  max_elapsed_seconds: 900,
  max_command_seconds: 60,
  max_output_bytes_per_check: 256 * 1024,
  max_output_bytes_total: 1024 * 1024,
  max_file_bytes: 1024 * 1024,
  max_allowlisted_files: 128,
  max_checks: 8,
  max_argv_items: 32,
  max_argv_item_bytes: 1024,
  max_artifact_bytes: 512 * 1024,
});

export const ATOMIC_LITE_EXCLUDED_NATIVE_TOOLS = Object.freeze([
  "read", "write", "edit", "bash", "web", "web_search", "fetch_content",
  "subagent", "intercom", "ask_user", "ask_user_question",
]);

export const ATOMIC_LITE_TOOL_NAMES = Object.freeze({
  list: "atomic_lite_list",
  read: "atomic_lite_read",
  write: "atomic_lite_write",
});

export const ATOMIC_LITE_POLICY_EXAMPLE = Object.freeze({
  schemaVersion: "1.0.0",
  workflow: ATOMIC_LITE_WORKFLOW_NAME,
  maxRepairRounds: 1,
  reviewerRequired: false,
  workspace: { read: ["src/index.js", "test/index.test.js"], write: ["src/index.js"] },
  checks: [{
    id: "tests",
    executable: "/usr/local/bin/node",
    argv: ["--test"],
    timeoutSeconds: 15,
    maxOutputBytes: 65_536,
  }],
  bounds: {
    maxElapsedSeconds: 120,
    maxCommandSeconds: 15,
    maxOutputBytes: 65_536,
    maxFileBytes: 65_536,
    maxFiles: 16,
  },
});

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_SCHEMA_VERSION = /^\d+\.\d+\.\d+$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_ENTRIES = 16;
const MAX_CONTEXT_AUTHORITY_BYTES = 128;
const MAX_CONTEXT_CONTENT_BYTES = 8 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_FINDINGS = 16;
const MAX_FINDING_BYTES = 1000;
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "cmd.exe", "powershell", "pwsh"]);
const SHELL_FLAGS = new Set(["-c", "--command", "-Command", "/c", "/C"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function exactKeysOneOf(value, variants, label) {
  const actual = Object.keys(value).sort().join("\u0000");
  const matching = variants.find((variant) => [...variant].sort().join("\u0000") === actual);
  if (!matching) {
    throw new Error(`${label} has unexpected fields`);
  }
  return matching;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe ID`);
  return value;
}

function bool(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  if (value.includes("\u0000")) throw new Error(`${label} must not contain NUL`);
  return value;
}

function parseJson(body, label) {
  try {
    return object(JSON.parse(body.toString("utf8")), label);
  } catch (error) {
    if (error?.message?.includes("must be a JSON object")) throw error;
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
}

function contained(root, candidate, label) {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escaped its workspace root`);
  }
}

function validateRelativePath(value, label = "workspace path") {
  boundedString(value, label, MAX_PATH_BYTES);
  if (isAbsolute(value) || value.startsWith("/") || value.includes("\\") || /[\u0000\u0009\u000a\u000d]/u.test(value)) {
    throw new Error(`${label} must be a portable workspace-relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return value;
}

function checkList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > ATOMIC_LITE_BOUNDS.max_allowlisted_files) throw new Error(`${label} exceeds its item bound`);
  const result = value.map((item, index) => validateRelativePath(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique paths`);
  return result;
}

function normalizeWorkspace(value) {
  const workspace = object(value, "Atomic Lite policy workspace");
  exactKeys(workspace, ["read", "write"], "Atomic Lite policy workspace");
  return Object.freeze({ read: checkList(workspace.read, "workspace.read"), write: checkList(workspace.write, "workspace.write") });
}

function normalizeBounds(value) {
  const bounds = object(value, "Atomic Lite policy bounds");
  // The canonical shape is intentionally small.  maxFiles is the aggregate
  // allowlist bound; command/check output is bounded independently.
  exactKeys(bounds, ["maxElapsedSeconds", "maxCommandSeconds", "maxOutputBytes", "maxFileBytes", "maxFiles"], "Atomic Lite policy bounds");
  const normalized = {
    maxElapsedSeconds: integer(bounds.maxElapsedSeconds, "bounds.maxElapsedSeconds", 1, ATOMIC_LITE_BOUNDS.max_elapsed_seconds),
    maxCommandSeconds: integer(bounds.maxCommandSeconds, "bounds.maxCommandSeconds", 1, ATOMIC_LITE_BOUNDS.max_command_seconds),
    maxOutputBytes: integer(bounds.maxOutputBytes, "bounds.maxOutputBytes", 1, ATOMIC_LITE_BOUNDS.max_output_bytes_total),
    maxFileBytes: integer(bounds.maxFileBytes, "bounds.maxFileBytes", 1, ATOMIC_LITE_BOUNDS.max_file_bytes),
    maxFiles: integer(bounds.maxFiles, "bounds.maxFiles", 1, ATOMIC_LITE_BOUNDS.max_allowlisted_files),
  };
  if (normalized.maxCommandSeconds > normalized.maxElapsedSeconds) {
    throw new Error("bounds.maxCommandSeconds must not exceed bounds.maxElapsedSeconds");
  }
  return Object.freeze(normalized);
}

function normalizeCheck(value, index, bounds) {
  const check = object(value, `Atomic Lite policy checks[${index}]`);
  exactKeys(check, ["id", "executable", "argv", "timeoutSeconds", "maxOutputBytes"], `Atomic Lite policy checks[${index}]`);
  const checkId = id(check.id, `checks[${index}].id`);
  if (typeof check.executable !== "string" || !isAbsolute(check.executable) || check.executable.includes("\u0000")) {
    throw new Error(`checks[${index}].executable must be an absolute reviewed executable`);
  }
  const executableName = check.executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (SHELL_EXECUTABLES.has(executableName)) throw new Error(`checks[${index}].executable may not be a shell`);
  if (!Array.isArray(check.argv) || check.argv.length > ATOMIC_LITE_BOUNDS.max_argv_items) {
    throw new Error(`checks[${index}].argv exceeds its bound`);
  }
  const argv = check.argv.map((arg, argIndex) => {
    boundedString(arg, `checks[${index}].argv[${argIndex}]`, ATOMIC_LITE_BOUNDS.max_argv_item_bytes);
    if (SHELL_FLAGS.has(arg) || arg.includes("\n") || arg.includes("\r")) {
      throw new Error(`checks[${index}].argv may not contain shell execution text`);
    }
    return arg;
  });
  const timeoutSeconds = integer(check.timeoutSeconds, `checks[${index}].timeoutSeconds`, 1, bounds.maxCommandSeconds);
  const maxOutputBytes = integer(check.maxOutputBytes, `checks[${index}].maxOutputBytes`, 1, Math.min(bounds.maxOutputBytes, ATOMIC_LITE_BOUNDS.max_output_bytes_per_check));
  return Object.freeze({ id: checkId, executable: check.executable, argv, timeoutSeconds, maxOutputBytes });
}

export function validateAtomicLitePolicy(value) {
  const policy = object(value, "Atomic Lite policy");
  exactKeys(policy, ["schemaVersion", "workflow", "maxRepairRounds", "reviewerRequired", "workspace", "checks", "bounds"], "Atomic Lite policy");
  if (policy.schemaVersion !== "1.0.0" || !SAFE_SCHEMA_VERSION.test(policy.schemaVersion)) throw new Error("Atomic Lite policy schemaVersion must be 1.0.0");
  if (policy.workflow !== ATOMIC_LITE_WORKFLOW_NAME) throw new Error("Atomic Lite policy workflow mismatch");
  const maxRepairRounds = integer(policy.maxRepairRounds, "maxRepairRounds", 0, 1);
  const reviewerRequired = bool(policy.reviewerRequired, "reviewerRequired");
  const workspace = normalizeWorkspace(policy.workspace);
  const bounds = normalizeBounds(policy.bounds);
  if (workspace.read.length === 0 || workspace.write.length === 0) {
    throw new Error("Atomic Lite read and write allowlists must each contain at least one path");
  }
  if (workspace.write.some((path) => !workspace.read.includes(path))) {
    throw new Error("Every Atomic Lite write allowlist path must also be readable");
  }
  if (workspace.read.length + workspace.write.length > bounds.maxFiles) throw new Error("Atomic Lite allowlists exceed bounds.maxFiles");
  if (!Array.isArray(policy.checks) || policy.checks.length < 1 || policy.checks.length > ATOMIC_LITE_BOUNDS.max_checks) {
    throw new Error(`Atomic Lite policy checks must contain 1-${ATOMIC_LITE_BOUNDS.max_checks} checks`);
  }
  const checks = policy.checks.map((check, index) => normalizeCheck(check, index, bounds));
  if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new Error("Atomic Lite check IDs must be unique");
  return Object.freeze({
    schemaVersion: policy.schemaVersion,
    workflow: policy.workflow,
    maxRepairRounds,
    reviewerRequired,
    workspace,
    checks,
    bounds,
  });
}

export function validateAtomicLiteInputs(value) {
  const input = object(value, "Atomic Lite workflow inputs");
  exactKeys(input, ["control_plane_run_id", "contract_sha256", "policy_sha256", "context_sha256"], "Atomic Lite workflow inputs");
  return Object.freeze({
    control_plane_run_id: id(input.control_plane_run_id, "control_plane_run_id"),
    contract_sha256: hash(input.contract_sha256, "contract_sha256"),
    policy_sha256: hash(input.policy_sha256, "policy_sha256"),
    context_sha256: hash(input.context_sha256, "context_sha256"),
  });
}

function normalizeContract(value, inputs) {
  const contract = object(value, "Atomic Lite contract");
  exactKeysOneOf(contract, [
    ["schemaVersion", "runId", "projectId", "taskId", "request", "rootRuntime", "workflow", "finalAction", "policySha256", "contextSha256", "crossProcessResume"],
    ["schemaVersion", "runId", "projectId", "taskId", "request", "rootRuntime", "workflow", "finalAction", "policySha256", "contextSha256"],
  ], "Atomic Lite contract");
  if (contract.schemaVersion !== "1.0.0") throw new Error("Atomic Lite contract schemaVersion must be 1.0.0");
  if (contract.runId !== inputs.control_plane_run_id) throw new Error("Atomic Lite contract runId does not match control-plane run ID");
  if (contract.workflow !== ATOMIC_LITE_WORKFLOW_NAME) throw new Error("Atomic Lite contract workflow mismatch");
  if (contract.rootRuntime !== "atomic") throw new Error("Atomic Lite contract rootRuntime must be atomic");
  if (contract.finalAction !== "stop_before_external_action") throw new Error("Atomic Lite contract finalAction must stop_before_external_action");
  if (contract.crossProcessResume !== undefined && contract.crossProcessResume !== false) throw new Error("Atomic Lite crossProcessResume must remain false");
  if (contract.policySha256 !== inputs.policy_sha256) throw new Error("Atomic Lite contract policySha256 does not match policy_sha256");
  if (contract.contextSha256 !== inputs.context_sha256) throw new Error("Atomic Lite contract contextSha256 does not match context_sha256");
  boundedString(contract.request, "Atomic Lite contract request", MAX_REQUEST_BYTES);
  id(contract.runId, "Atomic Lite contract runId");
  id(contract.projectId, "Atomic Lite contract projectId");
  if (contract.taskId !== null) id(contract.taskId, "Atomic Lite contract taskId");
  return Object.freeze({ ...contract, crossProcessResume: contract.crossProcessResume ?? false });
}

function normalizeContext(value, contract) {
  const context = object(value, "Atomic Lite context");
  exactKeys(context, ["schemaVersion", "projectId", "taskId", "request", "acceptedContext"], "Atomic Lite context");
  if (context.schemaVersion !== "1.0.0") throw new Error("Atomic Lite context schemaVersion must be 1.0.0");
  if (context.projectId !== contract.projectId) throw new Error("Atomic Lite context projectId does not match contract");
  if (context.taskId !== contract.taskId) throw new Error("Atomic Lite context taskId does not match contract");
  if (context.request !== contract.request) throw new Error("Atomic Lite context request does not match contract");
  if (!Array.isArray(context.acceptedContext) || context.acceptedContext.length > MAX_CONTEXT_ENTRIES) {
    throw new Error(`Atomic Lite context acceptedContext must contain 0-${MAX_CONTEXT_ENTRIES} entries`);
  }
  const acceptedContext = context.acceptedContext.map((entry, index) => {
    const item = object(entry, `Atomic Lite context acceptedContext[${index}]`);
    exactKeys(item, ["authority", "content"], `Atomic Lite context acceptedContext[${index}]`);
    boundedString(item.authority, `acceptedContext[${index}].authority`, MAX_CONTEXT_AUTHORITY_BYTES);
    boundedString(item.content, `acceptedContext[${index}].content`, MAX_CONTEXT_CONTENT_BYTES);
    return Object.freeze({ authority: item.authority, content: item.content });
  });
  return Object.freeze({
    schemaVersion: context.schemaVersion,
    projectId: context.projectId,
    taskId: context.taskId,
    request: context.request,
    acceptedContext,
  });
}

function boundedContextSummary(context, contextSha256) {
  return Object.freeze({
    ref: `${ATOMIC_LITE_CONTEXT_ROOT}/${ATOMIC_LITE_CONTEXT_PATH}`,
    sha256: contextSha256,
    projectId: context.projectId,
    taskId: context.taskId,
    request: context.request,
    acceptedContext: context.acceptedContext.map((entry) => ({
      authority: entry.authority,
      content: entry.content.slice(0, 512),
    })),
  });
}

async function regularFile(rootInput, relativePath, label, maximum = MAX_CONTEXT_FILE_BYTES) {
  const root = resolve(rootInput);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} root must be a regular directory`);
  const realRoot = await realpath(root);
  const candidate = resolve(root, ...relativePath.split("/"));
  contained(root, candidate, label);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) {
    throw new Error(`${label} must be a bounded single-link regular file`);
  }
  const realCandidate = await realpath(candidate);
  contained(realRoot, realCandidate, label);
  const body = await readFile(realCandidate);
  if (body.byteLength > maximum) throw new Error(`${label} exceeds its byte bound`);
  return { path: realCandidate, body, sha256: sha256(body), size_bytes: body.byteLength };
}

async function workspaceRoot(rootInput) {
  const root = resolve(rootInput);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Atomic Lite workspace must be a regular non-symlink directory");
  return { root, realRoot: await realpath(root) };
}

async function inspectWorkspacePath(rootValue, relativePath, bounds, { allowMissing = true } = {}) {
  const { root, realRoot } = rootValue;
  validateRelativePath(relativePath);
  const candidate = resolve(root, ...relativePath.split("/"));
  contained(root, candidate, "Atomic Lite workspace path");
  // Check each existing ancestor.  A symlinked directory must not make an
  // allowlisted relative path point outside the reviewed workspace.
  const parts = relativePath.split("/");
  let ancestor = root;
  for (let index = 0; index < parts.length; index += 1) {
    ancestor = join(ancestor, parts[index]);
    let stat;
    try { stat = await lstat(ancestor); } catch (error) {
      if (error?.code === "ENOENT" && index === parts.length - 1 && allowMissing) return { path: candidate, relativePath, missing: true };
      if (error?.code === "ENOENT" && allowMissing) return { path: candidate, relativePath, missing: true };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Atomic Lite path ${relativePath} contains a symlink`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Atomic Lite path ancestor ${ancestor} is not a directory`);
  }
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Atomic Lite path ${relativePath} is not a single-link regular file`);
  if (stat.size > bounds.maxFileBytes) throw new Error(`Atomic Lite path ${relativePath} exceeds maxFileBytes`);
  const real = await realpath(candidate);
  contained(realRoot, real, `Atomic Lite path ${relativePath}`);
  const body = await readFile(real);
  if (body.byteLength > bounds.maxFileBytes) throw new Error(`Atomic Lite path ${relativePath} exceeds maxFileBytes`);
  return { path: real, relativePath, missing: false, size_bytes: body.byteLength, sha256: sha256(body), body };
}

function allAllowlistedPaths(policy) {
  return [...new Set([...policy.workspace.read, ...policy.workspace.write])].sort();
}

const atomicLiteOutputFiles = Object.freeze([...new Set(Object.values(ATOMIC_LITE_OUTPUT_PATHS))].sort());

function parsePorcelainZ(stdout) {
  const records = [];
  const values = stdout.split("\0");
  if (values.at(-1) === "") values.pop();
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (raw.length < 4 || raw[2] !== " ") throw new Error("Atomic Lite Git status emitted an invalid record");
    const code = raw.slice(0, 2);
    const path = raw.slice(3);
    // Rename/copy records contain a second NUL-delimited path. They are never
    // permitted, so reject before a second token could be mistaken for a
    // standalone status record.
    if (/[RC]/u.test(code)) throw new Error("Atomic Lite rejects renamed or copied workspace paths");
    validateRelativePath(path, "Atomic Lite Git status path");
    records.push({ code, path });
  }
  return records;
}

async function readGitObjectId(workspace, argv, label, signal) {
  const result = await runBoundedCommand(ATOMIC_LITE_GIT_EXECUTABLE, argv, {
    cwd: workspace.realRoot,
    signal,
    timeoutMs: 15_000,
    maxOutputBytes: 16 * 1024,
  });
  const value = result.stdout.trim();
  if (result.exit_code !== 0 || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new Error(`Atomic Lite could not inspect ${label}`);
  }
  return value;
}

function validateGitBaseline(value) {
  const baseline = object(value, "Atomic Lite Git baseline");
  exactKeys(baseline, ["executable", "worktree", "headCommit", "headTree", "indexTree"], "Atomic Lite Git baseline");
  if (baseline.executable !== ATOMIC_LITE_GIT_EXECUTABLE || baseline.worktree !== true) {
    throw new Error("Atomic Lite Git baseline identity is invalid");
  }
  for (const key of ["headCommit", "headTree", "indexTree"]) {
    if (!/^[a-f0-9]{40,64}$/u.test(String(baseline[key] ?? ""))) {
      throw new Error(`Atomic Lite Git baseline ${key} is invalid`);
    }
  }
  return baseline;
}

async function assertGitBaseline(workspace, baselineInput, signal) {
  const baseline = validateGitBaseline(baselineInput);
  const [headCommit, headTree, indexTree] = await Promise.all([
    readGitObjectId(workspace, ["rev-parse", "--verify", "HEAD"], "the admitted Git commit", signal),
    readGitObjectId(workspace, ["rev-parse", "--verify", "HEAD^{tree}"], "the admitted Git tree", signal),
    readGitObjectId(workspace, ["write-tree"], "the admitted Git index", signal),
  ]);
  if (headCommit !== baseline.headCommit || headTree !== baseline.headTree || indexTree !== baseline.indexTree) {
    throw new Error("Atomic Lite Git commit, tree, or index changed after admission");
  }
  return baseline;
}

async function inspectFullWorktreeStatus(workspace, policy, gitBaseline, signal) {
  await assertGitBaseline(workspace, gitBaseline, signal);
  const status = await runBoundedCommand(ATOMIC_LITE_GIT_EXECUTABLE, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ], {
    cwd: workspace.realRoot,
    signal,
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
  });
  if (status.exit_code !== 0) throw new Error("Atomic Lite could not inspect the complete Git worktree");
  const records = parsePorcelainZ(status.stdout);
  const writePaths = new Set(policy.workspace.write);
  const outputPaths = new Set(atomicLiteOutputFiles);
  const modifiedPaths = [];
  for (const record of records) {
    if (record.code === " M" && writePaths.has(record.path)) {
      modifiedPaths.push(record.path);
      continue;
    }
    if (record.code === "??" && outputPaths.has(record.path)) continue;
    throw new Error(`Atomic Lite worktree contains an undeclared change: ${record.code} ${record.path}`);
  }
  return { records, modifiedPaths: [...new Set(modifiedPaths)].sort() };
}

async function prepareAtomicLiteOutputFiles(workspace) {
  const outputRoot = resolve(workspace.root, ATOMIC_LITE_OUTPUT_ROOT);
  contained(workspace.root, outputRoot, "Atomic Lite output root");
  try {
    await lstat(outputRoot);
    throw new Error("Atomic Lite output root must not exist before preflight");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(outputRoot, { mode: 0o700 });
  const outputStat = await lstat(outputRoot);
  const realOutputRoot = await realpath(outputRoot);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("Atomic Lite output root is unsafe");
  contained(workspace.realRoot, realOutputRoot, "Atomic Lite output root");
  for (const relativePath of atomicLiteOutputFiles) {
    const destination = resolve(workspace.root, ...relativePath.split("/"));
    contained(workspace.root, destination, "Atomic Lite output placeholder");
    const handle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.close();
  }
}

async function openVerifiedExistingFile(rootValue, relativePath, label, maximum) {
  const candidate = resolve(rootValue.root, ...relativePath.split("/"));
  contained(rootValue.root, candidate, label);
  let handle;
  try {
    handle = await open(candidate, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const [openedStat, pathStat, realCandidate] = await Promise.all([
      handle.stat(),
      lstat(candidate),
      realpath(candidate),
    ]);
    if (!openedStat.isFile() || openedStat.isSymbolicLink() || openedStat.nlink !== 1 || openedStat.size > maximum
        || !pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1
        || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`${label} changed identity before its descriptor was secured`);
    }
    contained(rootValue.realRoot, realCandidate, label);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function proveGitWorktree(workspace, signal) {
  let executableStat;
  try { executableStat = await lstat(ATOMIC_LITE_GIT_EXECUTABLE); } catch (error) {
    throw new Error("Atomic Lite fixed Git executable is unavailable", { cause: error });
  }
  // The reviewed fixed path is the executable identity.  Some platform
  // images (including macOS developer images) expose /usr/bin/git as a
  // system hardlink, so single-link validation is reserved for workspace and
  // artifact files rather than rejecting the fixed executable itself.
  if (!executableStat.isFile() || executableStat.isSymbolicLink() || (executableStat.mode & 0o111) === 0) {
    throw new Error("Atomic Lite fixed Git executable must be a regular executable file");
  }
  const probe = await runBoundedCommand(ATOMIC_LITE_GIT_EXECUTABLE, ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspace.realRoot,
    signal,
    timeoutMs: 15_000,
    maxOutputBytes: 16 * 1024,
  });
  if (probe.exit_code !== 0 || probe.stdout.trim() !== "true") {
    throw new Error("Atomic Lite workspace must be a Git worktree");
  }
  const status = await runBoundedCommand(ATOMIC_LITE_GIT_EXECUTABLE, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ], { cwd: workspace.realRoot, signal, timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
  if (status.exit_code !== 0) throw new Error("Atomic Lite could not inspect the complete Git worktree");
  if (status.stdout.length !== 0) throw new Error("Atomic Lite workspace must be completely clean before implementation");
  const [headCommit, headTree, indexTree] = await Promise.all([
    readGitObjectId(workspace, ["rev-parse", "--verify", "HEAD"], "the admitted Git commit", signal),
    readGitObjectId(workspace, ["rev-parse", "--verify", "HEAD^{tree}"], "the admitted Git tree", signal),
    readGitObjectId(workspace, ["write-tree"], "the admitted Git index", signal),
  ]);
  if (headTree !== indexTree) throw new Error("Atomic Lite clean worktree index does not match its admitted tree");
  return Object.freeze({ executable: ATOMIC_LITE_GIT_EXECUTABLE, worktree: true, headCommit, headTree, indexTree });
}

export async function preflightAtomicLite(options) {
  const inputs = validateAtomicLiteInputs(options.inputs);
  const workspace = await workspaceRoot(options.workspacePath);
  const contextRoot = options.contextRoot ?? ATOMIC_LITE_CONTEXT_ROOT;
  const contractFile = await regularFile(contextRoot, ATOMIC_LITE_CONTRACT_PATH, "Atomic Lite contract");
  const policyFile = await regularFile(contextRoot, ATOMIC_LITE_POLICY_PATH, "Atomic Lite policy");
  const contextFile = await regularFile(contextRoot, ATOMIC_LITE_CONTEXT_PATH, "Atomic Lite context");
  if (contractFile.sha256 !== inputs.contract_sha256) throw new Error("Atomic Lite contract checksum mismatch");
  if (policyFile.sha256 !== inputs.policy_sha256) throw new Error("Atomic Lite policy checksum mismatch");
  if (contextFile.sha256 !== inputs.context_sha256) throw new Error("Atomic Lite context checksum mismatch");
  const contract = normalizeContract(parseJson(contractFile.body, "Atomic Lite contract"), inputs);
  const policy = validateAtomicLitePolicy(parseJson(policyFile.body, "Atomic Lite policy"));
  const context = normalizeContext(parseJson(contextFile.body, "Atomic Lite context"), contract);
  for (const check of policy.checks) {
    let executableStat;
    try { executableStat = await lstat(check.executable); } catch (error) {
      throw new Error(`Atomic Lite check executable is unavailable: ${check.executable}`, { cause: error });
    }
    if (!executableStat.isFile() || executableStat.isSymbolicLink() || executableStat.nlink !== 1 || (executableStat.mode & 0o111) === 0) {
      throw new Error(`Atomic Lite check executable must be a regular executable file: ${check.executable}`);
    }
  }
  const baseline = {};
  for (const relativePath of allAllowlistedPaths(policy)) {
    const item = await inspectWorkspacePath(workspace, relativePath, policy.bounds);
    if (policy.workspace.write.includes(relativePath) && item.missing) {
      throw new Error(`Atomic Lite write target must exist at baseline: ${relativePath}`);
    }
    baseline[relativePath] = item.missing ? null : { sha256: item.sha256, size_bytes: item.size_bytes };
  }
  const git = await proveGitWorktree(workspace, options.signal);
  // Create every workflow-owned artifact inode before any model or check can
  // run. Later writes open those exact existing files with O_NOFOLLOW and
  // compare descriptor/path identity before truncating.
  await prepareAtomicLiteOutputFiles(workspace);
  return Object.freeze({
    inputs,
    contextRoot: resolve(contextRoot),
    workspaceRoot: workspace.realRoot,
    contract,
    policy,
    context,
    contextSummary: boundedContextSummary(context, contextFile.sha256),
    contractFile: { sha256: contractFile.sha256, size_bytes: contractFile.size_bytes },
    policyFile: { sha256: policyFile.sha256, size_bytes: policyFile.size_bytes },
    contextFile: { sha256: contextFile.sha256, size_bytes: contextFile.size_bytes },
    git,
    baseline,
  });
}

function ensurePathAllowed(policy, relativePath, mode) {
  validateRelativePath(relativePath);
  const allowlist = mode === "write" ? policy.workspace.write : policy.workspace.read;
  if (!allowlist.includes(relativePath)) throw new Error(`Atomic Lite ${mode} path is not allowlisted: ${relativePath}`);
}

export async function listAtomicLiteFiles(options) {
  const policy = validateAtomicLitePolicy(options.policy);
  const root = await workspaceRoot(options.workspacePath);
  const entries = [];
  for (const relativePath of allAllowlistedPaths(policy)) {
    const item = await inspectWorkspacePath(root, relativePath, policy.bounds);
    entries.push(item.missing
      ? { path: relativePath, exists: false }
      : { path: relativePath, exists: true, size_bytes: item.size_bytes, sha256: item.sha256 });
  }
  return entries;
}

export async function readAtomicLiteFile(options) {
  const policy = validateAtomicLitePolicy(options.policy);
  ensurePathAllowed(policy, options.relativePath, "read");
  const item = await inspectWorkspacePath(await workspaceRoot(options.workspacePath), options.relativePath, policy.bounds, { allowMissing: false });
  return { path: options.relativePath, content: item.body.toString("utf8"), sha256: item.sha256, size_bytes: item.size_bytes };
}

export async function writeAtomicLiteFile(options) {
  const policy = validateAtomicLitePolicy(options.policy);
  ensurePathAllowed(policy, options.relativePath, "write");
  const content = boundedString(options.content, "Atomic Lite write content", policy.bounds.maxFileBytes);
  const root = await workspaceRoot(options.workspacePath);
  const existing = await inspectWorkspacePath(root, options.relativePath, policy.bounds);
  if (existing.missing) throw new Error(`Atomic Lite write target must exist at baseline: ${options.relativePath}`);
  const handle = await openVerifiedExistingFile(
    root,
    options.relativePath,
    `Atomic Lite write target ${options.relativePath}`,
    policy.bounds.maxFileBytes,
  );
  try {
    await handle.truncate(0);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await inspectWorkspacePath(root, options.relativePath, policy.bounds, { allowMissing: false });
  if (existing.missing && after.missing) throw new Error("Atomic Lite write did not create its target");
  return { path: options.relativePath, sha256: after.sha256, size_bytes: after.size_bytes };
}

/**
 * Construct custom tools only from the normalized preflight policy.  Callers
 * cannot inject a path or command through these tools; every operation checks
 * the reviewed allowlist again at execution time.
 */
function fallbackAtomicLiteToolSchemas(policy) {
  return {
    read: {
      type: "object",
      properties: {
        path: { type: "string", enum: [...policy.workspace.read], maxLength: MAX_PATH_BYTES },
      },
      required: ["path"],
      additionalProperties: false,
    },
    write: {
      type: "object",
      properties: {
        path: { type: "string", enum: [...policy.workspace.write], maxLength: MAX_PATH_BYTES },
        content: { type: "string", minLength: 1, maxLength: policy.bounds.maxFileBytes },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    list: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

function atomicLiteTypeBoxSchemas(policy, typebox) {
  if (!typebox || typeof typebox.Object !== "function" || typeof typebox.String !== "function"
    || typeof typebox.Literal !== "function" || typeof typebox.Union !== "function") {
    return fallbackAtomicLiteToolSchemas(policy);
  }
  const exactPathSchema = (paths) => typebox.Union(
    paths.map((path) => typebox.Literal(path)),
    // The enum and length options are redundant with the literal branches but
    // make the reviewed bounds visible to schema consumers as well.
    { enum: [...paths], maxLength: MAX_PATH_BYTES },
  );
  return {
    read: typebox.Object({
      path: exactPathSchema(policy.workspace.read),
    }, { additionalProperties: false }),
    write: typebox.Object({
      path: exactPathSchema(policy.workspace.write),
      content: typebox.String({ minLength: 1, maxLength: policy.bounds.maxFileBytes }),
    }, { additionalProperties: false }),
    list: typebox.Object({}, { additionalProperties: false }),
  };
}

/**
 * Construct custom tools only from the normalized preflight policy.  Callers
 * cannot inject a path or command through these tools; every operation checks
 * the reviewed allowlist again at execution time.  The workflow supplies the
 * pinned Atomic TypeBox namespace so `parameters` are genuine TSchema values,
 * not merely JSON-shaped lookalikes.  The no-TypeBox fallback keeps this core
 * independently testable without provider/package installation.
 * @param {any} [typebox]
 */
export function createAtomicLiteCustomTools(workspacePath, validatedPolicy, typebox = null) {
  const policy = validateAtomicLitePolicy(validatedPolicy);
  const workspace = workspacePath;
  const schemas = atomicLiteTypeBoxSchemas(policy, typebox);
  return [
    {
      name: ATOMIC_LITE_TOOL_NAMES.list,
      label: "List Atomic Lite allowlisted files",
      description: "List only the reviewed workspace-relative Atomic Lite files.",
      parameters: schemas.list,
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify(await listAtomicLiteFiles({ workspacePath: workspace, policy })) }] }),
    },
    {
      name: ATOMIC_LITE_TOOL_NAMES.read,
      label: "Read an Atomic Lite allowlisted file",
      description: "Read one reviewed workspace-relative file.",
      parameters: schemas.read,
      execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(await readAtomicLiteFile({ workspacePath: workspace, policy, relativePath: params?.path })) }] }),
    },
    {
      name: ATOMIC_LITE_TOOL_NAMES.write,
      label: "Write an Atomic Lite allowlisted file",
      description: "Write one bounded reviewed workspace-relative file.",
      parameters: schemas.write,
      execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(await writeAtomicLiteFile({ workspacePath: workspace, policy, relativePath: params?.path, content: params?.content })) }] }),
    },
  ];
}

function runBoundedCommand(executable, argv, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let terminationError = null;
    let timer = null;
    let postKillTimer = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
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
      if (timer !== null) clearTimeout(timer);
      if (postKillTimer !== null) clearTimeout(postKillTimer);
      options.signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill("SIGKILL");
      // Do not reject immediately: a child may still have buffered output or
      // descendants holding stdout/stderr open.  The close event is the normal
      // completion signal; this timer is the hard upper bound for that wait.
      postKillTimer = setTimeout(() => finish(
        rejectPromise,
        new Error(`${error.message}; Atomic Lite child did not close within ${ATOMIC_LITE_POST_KILL_CLOSE_MS}ms`),
      ), ATOMIC_LITE_POST_KILL_CLOSE_MS);
    };
    const abort = () => terminate(new Error("Atomic Lite deterministic check cancelled"));
    const collect = (target, chunk) => {
      if (settled || terminationError) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate(new Error("Atomic Lite deterministic check exceeded its aggregate output bound"));
        return;
      }
      if (target === "stdout") stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };
    timer = setTimeout(() => terminate(new Error("Atomic Lite deterministic check exceeded its timeout")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => {
      // Once a kill has been requested, close/postKillTimer owns completion;
      // an accompanying spawn/kill error must not bypass that bound.
      if (terminationError) return;
      finish(rejectPromise, error);
    });
    child.once("close", (code, signal) => {
      if (terminationError) {
        finish(rejectPromise, terminationError);
        return;
      }
      finish(resolvePromise, {
        exit_code: typeof code === "number" ? code : -1,
        signal: signal ?? null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        output_bytes: outputBytes,
      });
    });
  });
}

async function writeArtifact(workspacePath, relativePath, value, maximum = ATOMIC_LITE_BOUNDS.max_artifact_bytes) {
  const workspace = await workspaceRoot(workspacePath);
  if (!atomicLiteOutputFiles.includes(relativePath)) throw new Error("Atomic Lite artifact path is not workflow-owned");
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonicalJson(value));
  if (body.byteLength > maximum) throw new Error(`Atomic Lite artifact ${relativePath} exceeds its byte bound`);
  const handle = await openVerifiedExistingFile(workspace, relativePath, `Atomic Lite artifact ${relativePath}`, maximum);
  try {
    await handle.truncate(0);
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await regularFile(workspace.root, relativePath, `Atomic Lite artifact ${relativePath}`, maximum);
  if (after.sha256 !== sha256(body)) throw new Error(`Atomic Lite artifact ${relativePath} changed after its descriptor write`);
  return { path: relativePath, sha256: after.sha256, size_bytes: after.size_bytes };
}

function findingsForResults(results) {
  return results.filter((result) => result.exit_code !== 0 || result.error).map((result) => {
    if (result.error) return `${result.id}:${result.error}`.slice(0, MAX_FINDING_BYTES);
    return `${result.id}:exit_${result.exit_code}`.slice(0, MAX_FINDING_BYTES);
  }).slice(0, MAX_FINDINGS);
}

export async function runAtomicLiteChecks(options) {
  const policy = validateAtomicLitePolicy(options.policy);
  const round = options.round === "final" ? "final" : "initial";
  const workspace = (await workspaceRoot(options.workspacePath)).realRoot;
  const started = Date.now();
  const deadline = started + policy.bounds.maxElapsedSeconds * 1000;
  const results = [];
  let outputBytes = 0;
  for (const check of policy.checks) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      results.push({ id: check.id, argv: [check.executable, ...check.argv], error: "elapsed_bound_exceeded", exit_code: -1 });
      break;
    }
    const configuredTimeoutMs = check.timeoutSeconds * 1000;
    const timeoutMs = Math.min(configuredTimeoutMs, policy.bounds.maxCommandSeconds * 1000, remainingMs);
    // Equality still means the elapsed deadline owns this invocation: the
    // command timer and elapsed deadline otherwise race at the same instant.
    const elapsedLimited = remainingMs <= configuredTimeoutMs;
    try {
      const result = await runBoundedCommand(check.executable, check.argv, {
        cwd: workspace,
        signal: options.signal,
        timeoutMs,
        maxOutputBytes: Math.min(check.maxOutputBytes, policy.bounds.maxOutputBytes - outputBytes),
      });
      outputBytes += result.output_bytes;
      if (Date.now() > deadline) {
        results.push({ id: check.id, argv: [check.executable, ...check.argv], error: "elapsed_bound_exceeded", exit_code: -1 });
      } else {
        results.push({ id: check.id, argv: [check.executable, ...check.argv], ...result });
      }
    } catch (error) {
      const message = !options.signal?.aborted && elapsedLimited && Date.now() >= deadline
        ? "elapsed_bound_exceeded"
        : String(error?.message ?? error);
      results.push({ id: check.id, argv: [check.executable, ...check.argv], error: message, exit_code: -1 });
    }
  }
  try {
    await inspectFullWorktreeStatus(await workspaceRoot(options.workspacePath), policy, options.gitBaseline, options.signal);
  } catch (error) {
    results.push({
      id: "workspace-scope",
      argv: [],
      error: String(error?.message ?? error),
      exit_code: -1,
    });
  }
  const findings = findingsForResults(results);
  const passed = results.length === policy.checks.length && results.every((result) => result.exit_code === 0 && !result.error);
  const delta = options.baseline ? makeDelta(options.baseline, await currentFileSnapshot(options.workspacePath, policy)) : null;
  const artifact = await writeArtifact(options.workspacePath, round === "initial" ? ATOMIC_LITE_OUTPUT_PATHS.checksInitial : ATOMIC_LITE_OUTPUT_PATHS.checksFinal, {
    schemaVersion: "1.0.0",
    workflow: ATOMIC_LITE_WORKFLOW_NAME,
    round,
    passed,
    findings,
    changed_paths: delta?.changedPaths ?? [],
    delta,
    output_bytes: outputBytes,
    commands: results,
  });
  return { round, passed, findings, changed_paths: delta?.changedPaths ?? [], delta, commands: results, artifact };
}

function normalizeReview(value, reviewerRequired) {
  const review = object(value, "Atomic Lite review");
  exactKeys(review, ["approved", "findings"], "Atomic Lite review");
  bool(review.approved, "Atomic Lite review approved");
  if (!Array.isArray(review.findings) || review.findings.length > MAX_FINDINGS) throw new Error("Atomic Lite review findings exceed their bound");
  const findings = review.findings.map((item, index) => boundedString(item, `review.findings[${index}]`, MAX_FINDING_BYTES));
  if (review.approved && findings.length > 0) throw new Error("An approved Atomic Lite review cannot retain findings");
  if (reviewerRequired && !review.approved && findings.length === 0) throw new Error("A rejected Atomic Lite review must retain findings");
  return { approved: review.approved, findings };
}

export async function writeAtomicLiteReview(options) {
  if (options.reviewNotRequired) {
    const value = {
      schemaVersion: "1.0.0",
      workflow: ATOMIC_LITE_WORKFLOW_NAME,
      decision: "review-not-required",
      approved: true,
      findings: [],
      context: "deterministic-policy",
      modelExecutionAttempted: false,
    };
    const artifact = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.review, value);
    return { approved: true, findings: [], review_required: false, decision: "review-not-required", artifact };
  }
  const review = normalizeReview(options.review, true);
  const value = {
    schemaVersion: "1.0.0",
    workflow: ATOMIC_LITE_WORKFLOW_NAME,
    decision: review.approved ? "approved" : "rejected",
    approved: review.approved,
    findings: review.findings,
    context: "fresh",
    modelExecutionAttempted: true,
  };
  const artifact = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.review, value);
  return { ...review, review_required: true, decision: value.decision, artifact };
}

async function currentFileSnapshot(workspacePath, policy) {
  const root = await workspaceRoot(workspacePath);
  const files = {};
  for (const relativePath of allAllowlistedPaths(policy)) {
    const item = await inspectWorkspacePath(root, relativePath, policy.bounds);
    files[relativePath] = item.missing ? null : { sha256: item.sha256, size_bytes: item.size_bytes };
  }
  return files;
}

function makeDelta(baseline, current) {
  const paths = [...new Set([...Object.keys(baseline ?? {}), ...Object.keys(current ?? {})])].sort();
  const files = paths.map((path) => ({
    path,
    before: baseline?.[path] ?? null,
    after: current?.[path] ?? null,
    changed: JSON.stringify(baseline?.[path] ?? null) !== JSON.stringify(current?.[path] ?? null),
  }));
  return { schemaVersion: "1.0.0", files, changedPaths: files.filter((item) => item.changed).map((item) => item.path) };
}

async function collectReviewableGitPatch(workspacePath, policy, gitBaseline, signal, changedPaths) {
  const workspace = await workspaceRoot(workspacePath);
  const writePaths = [...policy.workspace.write].sort();
  const status = await inspectFullWorktreeStatus(workspace, policy, gitBaseline, signal);
  const names = await runBoundedCommand(ATOMIC_LITE_GIT_EXECUTABLE, [
    "diff", "--name-only", "--no-ext-diff", "--no-textconv", "--", ...writePaths,
  ], {
    cwd: workspace.realRoot,
    signal,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  if (names.exit_code !== 0) throw new Error("Atomic Lite could not collect changed write-target paths");
  const gitChangedPaths = names.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  const expected = [...changedPaths].sort();
  if (gitChangedPaths.length === 0 || expected.length === 0) throw new Error("Atomic Lite requires at least one changed write-target path");
  if (JSON.stringify(gitChangedPaths) !== JSON.stringify(expected)
      || JSON.stringify(status.modifiedPaths) !== JSON.stringify(expected)) {
    throw new Error("Atomic Lite Git changed paths do not match the bounded candidate delta");
  }
  const patch = await runBoundedCommand(ATOMIC_LITE_GIT_EXECUTABLE, [
    "diff", "--binary", "--no-ext-diff", "--no-textconv", "--", ...writePaths,
  ], {
    cwd: workspace.realRoot,
    signal,
    timeoutMs: 15_000,
    maxOutputBytes: ATOMIC_LITE_BOUNDS.max_artifact_bytes,
  });
  if (patch.exit_code !== 0 || patch.stdout.trim() === "") throw new Error("Atomic Lite candidate.patch is empty or unavailable");
  return { body: patch.stdout, changedPaths: gitChangedPaths };
}

async function verifyOutputArtifact(workspacePath, reference, label) {
  if (!reference || typeof reference !== "object" || typeof reference.path !== "string" || !SHA256.test(String(reference.sha256 ?? ""))) {
    throw new Error(`${label} reference is not checksummed`);
  }
  const file = await regularFile(workspacePath, reference.path, label, ATOMIC_LITE_BOUNDS.max_artifact_bytes);
  if (file.sha256 !== reference.sha256) throw new Error(`${label} hash binding changed`);
  return file;
}

export async function emitAtomicLiteEvidence(options) {
  const inputs = validateAtomicLiteInputs(options.inputs);
  const preflight = options.preflight ?? await preflightAtomicLite({ ...options, inputs });
  if (preflight.inputs.contract_sha256 !== inputs.contract_sha256 || preflight.inputs.policy_sha256 !== inputs.policy_sha256 || preflight.inputs.context_sha256 !== inputs.context_sha256) throw new Error("Atomic Lite evidence preflight input binding changed");
  const contractFile = await regularFile(preflight.contextRoot, ATOMIC_LITE_CONTRACT_PATH, "Atomic Lite contract");
  const policyFile = await regularFile(preflight.contextRoot, ATOMIC_LITE_POLICY_PATH, "Atomic Lite policy");
  const contextFile = await regularFile(preflight.contextRoot, ATOMIC_LITE_CONTEXT_PATH, "Atomic Lite context");
  if (contractFile.sha256 !== inputs.contract_sha256 || policyFile.sha256 !== inputs.policy_sha256 || contextFile.sha256 !== inputs.context_sha256) throw new Error("Atomic Lite evidence contract, policy, or context hash changed");
  if (!options.finalChecks?.passed) throw new Error("Atomic Lite evidence requires passing final deterministic checks");
  if (!options.review?.approved) throw new Error("Atomic Lite evidence requires approved review or review-not-required decision");
  if (Boolean(options.review.review_required) !== preflight.policy.reviewerRequired) {
    throw new Error("Atomic Lite review decision does not match trusted reviewerRequired policy");
  }
  const initialChecksFile = options.initialChecks?.artifact
    ? await verifyOutputArtifact(options.workspacePath, options.initialChecks.artifact, "Atomic Lite initial checks")
    : null;
  const finalChecksFile = await verifyOutputArtifact(options.workspacePath, options.finalChecks.artifact, "Atomic Lite final checks");
  const reviewFile = await verifyOutputArtifact(options.workspacePath, options.review.artifact, "Atomic Lite review");
  const finalChecksValue = parseJson(finalChecksFile.body, "Atomic Lite final checks artifact");
  if (finalChecksValue.round !== "final" || finalChecksValue.passed !== true) throw new Error("Atomic Lite final checks artifact does not prove a passing final round");
  const reviewValue = parseJson(reviewFile.body, "Atomic Lite review artifact");
  if (reviewValue.decision !== "approved" && reviewValue.decision !== "review-not-required") throw new Error("Atomic Lite review artifact decision is not accepted");
  if (reviewValue.approved !== true || (reviewValue.decision === "review-not-required") !== (options.review.review_required === false)
      || reviewValue.modelExecutionAttempted !== (options.review.review_required === true)) {
    throw new Error("Atomic Lite review artifact truth does not match the trusted review decision");
  }
  const current = await currentFileSnapshot(options.workspacePath, preflight.policy);
  const deltaValue = makeDelta(preflight.baseline, current);
  if (deltaValue.changedPaths.some((path) => !preflight.policy.workspace.write.includes(path))) {
    throw new Error("Atomic Lite candidate delta contains a non-writable path");
  }
  const gitPatch = await collectReviewableGitPatch(options.workspacePath, preflight.policy, preflight.git, options.signal, deltaValue.changedPaths);
  const deltaBody = canonicalJson(deltaValue);
  const delta = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.delta, deltaBody);
  const patch = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.patch, gitPatch.body);
  const copiedContract = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.contract, contractFile.body);
  const copiedPolicy = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.policy, policyFile.body);
  const context = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.context, contextFile.body);
  const evidenceValue = {
    schemaVersion: "1.0.0",
    workflow: ATOMIC_LITE_WORKFLOW_NAME,
    workflowVersion: ATOMIC_LITE_WORKFLOW_VERSION,
    control_plane_run_id: inputs.control_plane_run_id,
    native_workflow_run_id: options.nativeRunId == null ? null : String(options.nativeRunId),
    rootRuntime: "atomic",
    finalAction: "stop_before_external_action",
    repair_count: options.repairCount ?? 0,
    contract_sha256: contractFile.sha256,
    policy_sha256: policyFile.sha256,
    context_sha256: contextFile.sha256,
    contract: copiedContract,
    policy: copiedPolicy,
    context,
    delta,
    patch,
    checks_initial: initialChecksFile ? options.initialChecks.artifact : null,
    checks_final: options.finalChecks.artifact,
    review: options.review.artifact,
    reviewer_required: preflight.policy.reviewerRequired,
    review_decision: options.review.review_required ? (options.review.approved ? "approved" : "rejected") : "review-not-required",
    changed_paths: deltaValue.changedPaths,
    model_execution_attempted: true,
    reviewer_model_execution_attempted: options.review.review_required === true,
  };
  const evidence = await writeArtifact(options.workspacePath, ATOMIC_LITE_OUTPUT_PATHS.evidence, evidenceValue);
  return {
    evidence_manifest_path: evidence.path,
    patch_path: patch.path,
    delta_path: delta.path,
    checks_initial_path: options.initialChecks?.artifact?.path ?? null,
    checks_final_path: options.finalChecks.artifact.path,
    checks_sha256: options.finalChecks.artifact.sha256,
    review_path: options.review.artifact.path,
    review_decision_path: options.review.artifact.path,
    review_sha256: options.review.artifact.sha256,
    review_decision: evidenceValue.review_decision,
    repair_count: options.repairCount ?? 0,
    context_copy_path: context.path,
    context_path: context.path,
    context_pack_path: context.path,
    contract_copy_path: copiedContract.path,
    contract_path: copiedContract.path,
    run_contract_path: copiedContract.path,
    policy_copy_path: copiedPolicy.path,
    policy_path: copiedPolicy.path,
    contract_sha256: contractFile.sha256,
    policy_sha256: policyFile.sha256,
    context_sha256: context.sha256,
    checks_passed: true,
    reviewer_passed: true,
    model_execution_attempted: true,
    reviewer_model_execution_attempted: options.review.review_required === true,
    changed_paths: deltaValue.changedPaths,
    evidence_sha256: evidence.sha256,
  };
}

// Names used by integrations and tests can stay descriptive while preserving
// the single implementation above.
export const validateAtomicLiteWriterInputs = validateAtomicLiteInputs;
export const preflightAtomicLiteWriter = preflightAtomicLite;
export const createAtomicLiteTools = createAtomicLiteCustomTools;
export const runAtomicLiteWriterChecks = runAtomicLiteChecks;
export const persistAtomicLiteReview = writeAtomicLiteReview;
export const emitAtomicLiteWriterEvidence = emitAtomicLiteEvidence;
