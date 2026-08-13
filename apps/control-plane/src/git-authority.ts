import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const GIT_COMMAND = "/usr/bin/git";
export const GIT_MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const GIT_MAX_PATCH_BYTES = 8 * 1024 * 1024;
export const GIT_MAX_CHECKS = 32;

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_REF = /^(?:[A-Za-z0-9_][A-Za-z0-9_./-]{0,254})$/u;
const SAFE_REMOTE_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const FORBIDDEN_REF = /(?:\.\.|\.lock$|[~^:?*\[\\\s])/u;
const SAFE_CHECK_ARGUMENT = /^[^\u0000\r\n]{0,512}$/u;

export type GitAuthorityErrorCode =
  | "GIT_POLICY_INVALID"
  | "GIT_REPOSITORY_INVALID"
  | "GIT_COMMAND_FAILED"
  | "GIT_COMMAND_TIMEOUT"
  | "GIT_COMMAND_OUTPUT_TOO_LARGE"
  | "GIT_REPOSITORY_DIRTY"
  | "GIT_REMOTE_INVALID"
  | "GIT_REMOTE_MISMATCH"
  | "GIT_REF_INVALID"
  | "GIT_REF_NOT_FOUND"
  | "GIT_REF_DRIFT"
  | "GIT_POLICY_DRIFT"
  | "GIT_PATCH_TOO_LARGE"
  | "GIT_SCHEMA_INVALID";

export class GitAuthorityError extends Error {
  readonly code: GitAuthorityErrorCode;
  readonly retryable: boolean;

  constructor(code: GitAuthorityErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "GitAuthorityError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export interface GitCheckPolicy {
  readonly id: string;
  readonly executable: string;
  readonly argv?: readonly string[];
  readonly maxOutputBytes?: number;
}

/**
 * This is an accepted host-side policy, not a request shape.  Once a provider
 * is constructed, callers cannot supply a repository path, ref, remote, or
 * command to any read operation.
 */
export interface GitAuthorityPolicyInput {
  readonly projectId: string;
  readonly repositoryPath: string;
  readonly repositoryIdentity?: string;
  readonly repositoryOwner?: string;
  readonly repositoryName?: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly approvedBaseCommit?: string;
  readonly approvedBaseTree?: string;
  readonly approvedHeadCommit?: string;
  readonly approvedHeadTree?: string;
  readonly checkPolicy: readonly GitCheckPolicy[];
  readonly policyVersion?: string;
}

export interface GitAuthorityPolicy {
  readonly projectId: string;
  readonly repositoryIdentity: string;
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly approvedBaseCommit?: string;
  readonly approvedBaseTree?: string;
  readonly approvedHeadCommit?: string;
  readonly approvedHeadTree?: string;
  readonly checkPolicy: readonly GitCheckPolicy[];
  readonly checkPolicyDigest: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
}

export interface GitAuthoritySnapshot {
  readonly provider: "git";
  readonly projectId: string;
  readonly repositoryIdentity: string;
  readonly remoteUrlIdentity: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly headRef: string;
  readonly headCommit: string;
  readonly headTree: string;
  readonly clean: true;
  readonly patchDigest: string;
  readonly patchBytes: number;
  readonly checkPolicyDigest: string;
  readonly policyDigest: string;
  readonly observedAt: string;
}

export interface GitAuthorityReadResult {
  readonly snapshot: GitAuthoritySnapshot;
  readonly replayed: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function gitCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(gitCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${gitCanonicalJson(item)}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

function safeText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitAuthorityError("GIT_POLICY_INVALID", `${field} is invalid`);
  }
  return value;
}

function safeProjectId(value: unknown): string {
  const result = safeText(value, "Git project ID", 128);
  if (!SAFE_ID.test(result)) throw new GitAuthorityError("GIT_POLICY_INVALID", "Git project ID is invalid");
  return result;
}

function safeRef(value: unknown, field: string): string {
  const result = safeText(value, field, 256);
  if (result.startsWith("-") || !SAFE_REF.test(result) || FORBIDDEN_REF.test(result)) {
    throw new GitAuthorityError("GIT_REF_INVALID", `${field} is invalid`);
  }
  return result;
}

function safeOid(value: unknown, field: string): string {
  const result = safeText(value, field, 64).toLowerCase();
  if (!SHA.test(result)) throw new GitAuthorityError("GIT_POLICY_INVALID", `${field} is not a Git object ID`);
  return result;
}

function canonicalRepositoryIdentity(owner: string, name: string): string {
  if (!SAFE_REMOTE_PART.test(owner) || !SAFE_REMOTE_PART.test(name)) {
    throw new GitAuthorityError("GIT_POLICY_INVALID", "GitHub repository identity is invalid");
  }
  return `github.com/${owner}/${name.replace(/\.git$/u, "")}`;
}

/**
 * Return the only supported identity form.  Userinfo, ports, paths outside
 * GitHub, and query/fragment components are rejected before they can affect a
 * command or a snapshot.
 */
export function canonicalGitHubRemote(value: unknown): string {
  const raw = safeText(value, "Git remote URL", 512);
  if (raw.includes("\\") || raw.includes("@") && !raw.startsWith("git@github.com:")) {
    throw new GitAuthorityError("GIT_REMOTE_INVALID", "Git remote URL contains unsupported credentials or syntax");
  }
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(raw);
  if (ssh) return canonicalRepositoryIdentity(ssh[1], ssh[2]);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GitAuthorityError("GIT_REMOTE_INVALID", "Git remote URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com"
      || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new GitAuthorityError("GIT_REMOTE_INVALID", "Git remote URL must be canonical GitHub HTTPS without credentials");
  }
  const path = parsed.pathname.replace(/^\//u, "");
  const match = /^([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(path);
  if (!match) throw new GitAuthorityError("GIT_REMOTE_INVALID", "Git remote URL repository path is invalid");
  return canonicalRepositoryIdentity(match[1], match[2]);
}

function validateCheckPolicy(checks: readonly GitCheckPolicy[]): readonly GitCheckPolicy[] {
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > GIT_MAX_CHECKS) {
    throw new GitAuthorityError("GIT_POLICY_INVALID", "Git check policy must contain 1-32 checks");
  }
  const seen = new Set<string>();
  return Object.freeze(checks.map((check) => {
    if (!check || typeof check !== "object") throw new GitAuthorityError("GIT_POLICY_INVALID", "Git check policy entry is invalid");
    const id = safeText(check.id, "Git check ID", 128);
    if (!SAFE_ID.test(id) || seen.has(id)) throw new GitAuthorityError("GIT_POLICY_INVALID", "Git check IDs must be unique safe identifiers");
    seen.add(id);
    if (!isAbsolute(check.executable) || check.executable !== resolve(check.executable)
        || check.executable.includes("\0") || check.executable.startsWith("-")) {
      throw new GitAuthorityError("GIT_POLICY_INVALID", "Git check executable must be an absolute path");
    }
    const argv = [...(check.argv ?? [])];
    if (argv.length > 64 || argv.some((arg) => typeof arg !== "string" || !SAFE_CHECK_ARGUMENT.test(arg))) {
      throw new GitAuthorityError("GIT_POLICY_INVALID", "Git check arguments are invalid or unbounded");
    }
    const maxOutputBytes = check.maxOutputBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > GIT_MAX_COMMAND_OUTPUT_BYTES) {
      throw new GitAuthorityError("GIT_POLICY_INVALID", "Git check output bound is invalid");
    }
    return Object.freeze({ id, executable: check.executable, argv: Object.freeze(argv), maxOutputBytes });
  }));
}

function assertRepositoryPath(value: unknown): string {
  const path = safeText(value, "Git repository path", 4_096);
  if (!isAbsolute(path)) throw new GitAuthorityError("GIT_POLICY_INVALID", "Git repository path must be absolute");
  const requested = resolve(path);
  if (!existsSync(requested)) throw new GitAuthorityError("GIT_REPOSITORY_INVALID", "Git repository is unavailable");
  const status = lstatSync(requested);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new GitAuthorityError("GIT_REPOSITORY_INVALID", "Git repository must be a regular non-symlink directory");
  }
  const real = realpathSync(requested);
  const gitEntry = resolve(real, ".git");
  if (!existsSync(gitEntry)) throw new GitAuthorityError("GIT_REPOSITORY_INVALID", "Git repository metadata is missing");
  const gitStatus = lstatSync(gitEntry);
  if (gitStatus.isSymbolicLink() || (!gitStatus.isDirectory() && !gitStatus.isFile())) {
    throw new GitAuthorityError("GIT_REPOSITORY_INVALID", "Git repository metadata is invalid");
  }
  return real;
}

export function createGitAuthorityPolicy(input: GitAuthorityPolicyInput): GitAuthorityPolicy {
  const projectId = safeProjectId(input.projectId);
  const repositoryPath = assertRepositoryPath(input.repositoryPath);
  let repositoryIdentity = input.repositoryIdentity;
  if (!repositoryIdentity && input.repositoryOwner && input.repositoryName) {
    repositoryIdentity = canonicalRepositoryIdentity(
      safeText(input.repositoryOwner, "Git repository owner", 128),
      safeText(input.repositoryName, "Git repository name", 128),
    );
  }
  if (!repositoryIdentity) throw new GitAuthorityError("GIT_POLICY_INVALID", "Git repository identity is required");
  repositoryIdentity = canonicalGitHubRemote(
    repositoryIdentity.startsWith("github.com/") ? `https://${repositoryIdentity}` : repositoryIdentity,
  );
  const baseRef = safeRef(input.baseRef, "Git base ref");
  const headRef = safeRef(input.headRef, "Git head ref");
  const checkPolicy = validateCheckPolicy(input.checkPolicy);
  const checkPolicyDigest = sha256(gitCanonicalJson(checkPolicy));
  const policyVersion = safeText(input.policyVersion ?? "git-authority-v1", "Git policy version", 128);
  const approvedBaseCommit = input.approvedBaseCommit === undefined ? undefined : safeOid(input.approvedBaseCommit, "Approved base commit");
  const approvedBaseTree = input.approvedBaseTree === undefined ? undefined : safeOid(input.approvedBaseTree, "Approved base tree");
  const approvedHeadCommit = input.approvedHeadCommit === undefined ? undefined : safeOid(input.approvedHeadCommit, "Approved head commit");
  const approvedHeadTree = input.approvedHeadTree === undefined ? undefined : safeOid(input.approvedHeadTree, "Approved head tree");
  const policyDigest = sha256(gitCanonicalJson({
    schemaVersion: 1,
    projectId,
    repositoryIdentity,
    baseRef,
    headRef,
    approvedBaseCommit,
    approvedBaseTree,
    approvedHeadCommit,
    approvedHeadTree,
    checkPolicyDigest,
    policyVersion,
  }));
  return Object.freeze({
    projectId,
    repositoryIdentity,
    repositoryPath,
    baseRef,
    headRef,
    approvedBaseCommit,
    approvedBaseTree,
    approvedHeadCommit,
    approvedHeadTree,
    checkPolicy,
    checkPolicyDigest,
    policyVersion,
    policyDigest,
  });
}

interface GitCommandResult {
  readonly stdout: Uint8Array;
  readonly stderrBytes: number;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_EDITOR: "/usr/bin/true",
    GIT_SEQUENCE_EDITOR: "/usr/bin/true",
    GIT_EXTERNAL_DIFF: "/usr/bin/false",
    GIT_DIFF_OPTS: "",
    GIT_SSH_COMMAND: "/usr/bin/false",
  };
}

function commandError(code: GitAuthorityErrorCode, retryable = false): GitAuthorityError {
  return new GitAuthorityError(code, "Git authority command failed", { retryable });
}

/** Spawn only the fixed Git executable with bounded output and no ambient env. */
function runGit(repositoryPath: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number): Promise<GitCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(GIT_COMMAND, ["-C", repositoryPath, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let exceeded = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      try { child.kill("SIGTERM"); } catch { /* child already exited */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* child already exited */ }
        hardKillTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPromise(commandError(timedOut ? "GIT_COMMAND_TIMEOUT" : "GIT_COMMAND_FAILED", timedOut));
        }, 750);
        hardKillTimer.unref();
      }, 250);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        terminate();
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        exceeded = true;
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        exceeded = true;
        terminate();
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      rejectPromise(commandError("GIT_COMMAND_FAILED"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (timedOut) rejectPromise(commandError("GIT_COMMAND_TIMEOUT", true));
      else if (exceeded) rejectPromise(commandError("GIT_COMMAND_OUTPUT_TOO_LARGE"));
      else if (code !== 0) rejectPromise(commandError("GIT_COMMAND_FAILED"));
      else resolvePromise({ stdout: Buffer.concat(stdout), stderrBytes });
    });
  });
}

function decode(result: GitCommandResult, field: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
  } catch {
    throw new GitAuthorityError("GIT_SCHEMA_INVALID", `Git ${field} output is not valid UTF-8`);
  }
}

function parseOid(result: GitCommandResult, field: string): string {
  const value = decode(result, field).toLowerCase();
  if (!SHA.test(value)) throw new GitAuthorityError("GIT_SCHEMA_INVALID", `Git ${field} output is invalid`);
  return value;
}

function parseSingleLine(result: GitCommandResult, field: string): string {
  const value = decode(result, field);
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new GitAuthorityError("GIT_SCHEMA_INVALID", `Git ${field} output is invalid`);
  return value;
}

function parseRemote(result: GitCommandResult): string {
  const value = parseSingleLine(result, "remote identity");
  return canonicalGitHubRemote(value);
}

function parseStatus(result: GitCommandResult): void {
  const value = decode(result, "status");
  if (value.length > 0) throw new GitAuthorityError("GIT_REPOSITORY_DIRTY", "Git repository must be clean");
}

function compareApproved(actual: string, expected: string | undefined, field: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new GitAuthorityError("GIT_POLICY_DRIFT", `${field} does not match the accepted Git policy`);
  }
}

/**
 * Host-side Git implementation authority.  It is read-only: all operations
 * use Git inspection/diff commands and never accept a caller path, ref, or
 * command after policy construction.
 */
export class GitAuthorityProvider {
  readonly policy: GitAuthorityPolicy;
  private readonly timeoutMs: number;
  private readonly maxCommandOutputBytes: number;
  private readonly maxPatchBytes: number;
  private readonly clock: () => Date;

  constructor(options: {
    readonly policy: GitAuthorityPolicy;
    readonly timeoutMs?: number;
    readonly maxCommandOutputBytes?: number;
    readonly maxPatchBytes?: number;
    readonly now?: () => Date;
  }) {
    if (!options || !options.policy) throw new GitAuthorityError("GIT_POLICY_INVALID", "Git authority policy is required");
    this.policy = options.policy;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxCommandOutputBytes = options.maxCommandOutputBytes ?? GIT_MAX_COMMAND_OUTPUT_BYTES;
    this.maxPatchBytes = options.maxPatchBytes ?? GIT_MAX_PATCH_BYTES;
    this.clock = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000
        || !Number.isSafeInteger(this.maxCommandOutputBytes) || this.maxCommandOutputBytes < 1024 || this.maxCommandOutputBytes > GIT_MAX_COMMAND_OUTPUT_BYTES
        || !Number.isSafeInteger(this.maxPatchBytes) || this.maxPatchBytes < 1 || this.maxPatchBytes > GIT_MAX_PATCH_BYTES) {
      throw new GitAuthorityError("GIT_POLICY_INVALID", "Git authority bounds are invalid");
    }
  }

  async read(): Promise<GitAuthoritySnapshot> {
    const policy = this.policy;
    const remote = parseRemote(await runGit(policy.repositoryPath, ["config", "--get", "remote.origin.url"], this.timeoutMs, this.maxCommandOutputBytes));
    if (remote !== policy.repositoryIdentity) throw new GitAuthorityError("GIT_REMOTE_MISMATCH", "Git remote identity does not match the accepted repository");
    parseStatus(await runGit(policy.repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"], this.timeoutMs, this.maxCommandOutputBytes));
    const baseCommit = parseOid(await runGit(policy.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${policy.baseRef}^{commit}`], this.timeoutMs, this.maxCommandOutputBytes), "base commit");
    const baseTree = parseOid(await runGit(policy.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{tree}`], this.timeoutMs, this.maxCommandOutputBytes), "base tree");
    const headCommit = parseOid(await runGit(policy.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${policy.headRef}^{commit}`], this.timeoutMs, this.maxCommandOutputBytes), "head commit");
    const headTree = parseOid(await runGit(policy.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${headCommit}^{tree}`], this.timeoutMs, this.maxCommandOutputBytes), "head tree");
    compareApproved(baseCommit, policy.approvedBaseCommit, "Git base commit");
    compareApproved(baseTree, policy.approvedBaseTree, "Git base tree");
    compareApproved(headCommit, policy.approvedHeadCommit, "Git head commit");
    compareApproved(headTree, policy.approvedHeadTree, "Git head tree");
    const patch = await runGit(policy.repositoryPath, [
      "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
      "--src-prefix=a/", "--dst-prefix=b/", baseCommit, headCommit, "--",
    ], this.timeoutMs, this.maxPatchBytes);
    if (patch.stdout.byteLength > this.maxPatchBytes) throw new GitAuthorityError("GIT_PATCH_TOO_LARGE", "Git patch exceeded its byte bound");
    const observed = this.clock();
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) throw new GitAuthorityError("GIT_SCHEMA_INVALID", "Git observation clock is invalid");
    return Object.freeze({
      provider: "git" as const,
      projectId: policy.projectId,
      repositoryIdentity: policy.repositoryIdentity,
      remoteUrlIdentity: remote,
      baseRef: policy.baseRef,
      baseCommit,
      baseTree,
      headRef: policy.headRef,
      headCommit,
      headTree,
      clean: true as const,
      patchDigest: sha256(patch.stdout),
      patchBytes: patch.stdout.byteLength,
      checkPolicyDigest: policy.checkPolicyDigest,
      policyDigest: policy.policyDigest,
      observedAt: observed.toISOString(),
    });
  }

  inspect(): Promise<GitAuthoritySnapshot> {
    return this.read();
  }

  snapshot(): Promise<GitAuthoritySnapshot> {
    return this.read();
  }

  async verify(expected: GitAuthoritySnapshot): Promise<GitAuthoritySnapshot> {
    if (!expected || expected.provider !== "git" || expected.projectId !== this.policy.projectId
        || expected.repositoryIdentity !== this.policy.repositoryIdentity || expected.policyDigest !== this.policy.policyDigest
        || expected.checkPolicyDigest !== this.policy.checkPolicyDigest) {
      throw new GitAuthorityError("GIT_POLICY_DRIFT", "Git authority snapshot is not bound to the accepted policy");
    }
    const current = await this.read();
    if (current.baseCommit !== expected.baseCommit || current.baseTree !== expected.baseTree
        || current.headCommit !== expected.headCommit || current.headTree !== expected.headTree
        || current.patchDigest !== expected.patchDigest || current.remoteUrlIdentity !== expected.remoteUrlIdentity) {
      throw new GitAuthorityError("GIT_REF_DRIFT", "Git refs or repository content changed after authority inspection");
    }
    return current;
  }

  assertCurrent(expected: GitAuthoritySnapshot): Promise<GitAuthoritySnapshot> {
    return this.verify(expected);
  }
}

export { GitAuthorityProvider as GitAuthority };
