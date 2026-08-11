import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const CONTAINER_ID = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const SHA256_IMAGE = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export type OciNetworkPolicy =
  | { mode: "none" }
  | { mode: "named"; name: string };

export interface OciResourceBounds {
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  tmpfsBytes: number;
}

export interface OciTimeoutBounds {
  preflightMs: number;
  startMs: number;
  inspectMs: number;
  readinessMs: number;
  runMs: number;
  stopMs: number;
  killMs: number;
  cleanupMs: number;
  terminationGraceMs: number;
  readinessPollMs: number;
}

export interface OciSandboxProviderOptions {
  /** The provider performs no spawn or filesystem mutation unless enabled. */
  enabled?: boolean;
  /** Absolute path to a local Docker-compatible CLI. */
  engineCommand: string;
  /** Trusted fixed prefix, used by deterministic test engines. */
  enginePrefixArgs?: string[];
  /** Optional explicit local Unix daemon socket; remote TCP/TLS endpoints reject. */
  engineSocket?: string;
  /** Images must be immutable digest references; tags are rejected. */
  image: string;
  workspaceRoot: string;
  contextRoot: string;
  artifactRoot: string;
  stateRoot: string;
  networkPolicy?: OciNetworkPolicy;
  resourceBounds?: Partial<OciResourceBounds>;
  timeoutBounds?: Partial<OciTimeoutBounds>;
  maxEngineOutputBytes?: number;
  maxRunOutputBytes?: number;
  user?: string;
  idleCommand?: string[];
}

export interface OciSandboxStartInput {
  runId: string;
  workspaceId: string;
  leaseOwnerId: string;
  fencingToken: number;
  workspacePath: string;
  /** A separately staged directory. It must not overlap the writable workspace. */
  contextPath: string;
  /** Portable path beneath the mounted run root. Defaults to the run root itself. */
  workingDirectoryRelativePath?: string;
}

export interface OciSandboxHandle {
  readonly runId: string;
  readonly workspaceId: string;
  readonly leaseOwnerId: string;
  readonly fencingToken: number;
  readonly containerId: string;
  readonly containerName: string;
  readonly workspacePath: string;
  readonly contextPath: string;
  readonly workspaceDigest: string;
  readonly contextDigest: string;
  readonly workingDirectoryRelativePath: string;
  readonly workingDirectoryDigest: string;
  status: "running" | "stopped" | "quarantined" | "cleaned";
}

export interface OciRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export type OciCleanupReason =
  | "CREATE_UNCERTAIN"
  | "INVALID_CONTAINER_ID"
  | "OWNERSHIP_MISMATCH"
  | "INSPECT_FAILED"
  | "STOP_FAILED"
  | "KILL_FAILED"
  | "REMOVE_FAILED";

export type OciCleanupResult =
  | { status: "cleaned" }
  | { status: "quarantined"; reason: OciCleanupReason; quarantineRecord: string };

export interface OciPreflightResult {
  enabled: boolean;
  available: boolean;
  engine: "docker-compatible";
  version?: string;
  reason?: "disabled" | "engine-unavailable";
}

export interface OciSandboxContract {
  provider: "docker-compatible";
  imageRef: string;
  policyHash: string;
}

export interface OciReconciliationExpectation {
  runId: string;
  workspaceId: string;
  leaseOwnerId: string;
  fencingToken: number;
  engineId: string | null;
  imageRef: string;
  policyHash: string;
  workspaceDigest: string;
  contextDigest: string;
  workdirDigest: string;
  cleanupAttempts: number;
}

export interface OciReconciliationResult {
  runId: string | null;
  workspaceId: string | null;
  containerId: string | null;
  outcome: "cleaned" | "absent" | "quarantined" | "unmatched";
  reason: string;
  cleanupAttempted: boolean;
}

/**
 * Deliberately evidence-only. Output and environment values are never retained.
 * Execute argv is represented by a digest so a caller cannot leak a token through
 * an argument and then recover it from the transcript.
 */
export interface OciCommandTranscriptEntry {
  sequence: number;
  operation: "preflight" | "inventory" | "create" | "start" | "inspect" | "execute" | "stop" | "kill" | "cleanup";
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
}

interface CommandResult extends OciRunResult {}

interface DockerInspect {
  Id?: unknown;
  Config?: {
    Image?: unknown;
    Labels?: Record<string, unknown> | null;
    WorkingDir?: unknown;
    User?: unknown;
  };
  HostConfig?: {
    NetworkMode?: unknown;
    IpcMode?: unknown;
    Privileged?: unknown;
    RestartPolicy?: { Name?: unknown; MaximumRetryCount?: unknown };
    ReadonlyRootfs?: unknown;
    Memory?: unknown;
    NanoCpus?: unknown;
    PidsLimit?: unknown;
    CapDrop?: unknown;
    SecurityOpt?: unknown;
    Tmpfs?: unknown;
    Init?: unknown;
  };
  State?: {
    Running?: unknown;
    Status?: unknown;
    Health?: { Status?: unknown };
  };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
  Mounts?: Array<{
    Type?: unknown;
    Source?: unknown;
    Destination?: unknown;
    RW?: unknown;
  }>;
}

interface OwnershipInspection {
  running: boolean;
  ready: boolean;
}

class OciEngineCommandError extends Error {
  readonly code: "SPAWN_FAILED" | "EXIT_NONZERO" | "TIMEOUT" | "OUTPUT_LIMIT";
  readonly exitCode: number | null;

  constructor(
    operation: OciCommandTranscriptEntry["operation"],
    code: OciEngineCommandError["code"],
    exitCode: number | null = null,
  ) {
    super(`OCI engine ${operation} failed (${code}${exitCode === null ? "" : `:${exitCode}`})`);
    this.name = "OciEngineCommandError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const DEFAULT_RESOURCES: OciResourceBounds = {
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pidsLimit: 128,
  tmpfsBytes: 64 * 1024 * 1024,
};

const DEFAULT_TIMEOUTS: OciTimeoutBounds = {
  preflightMs: 2_000,
  startMs: 20_000,
  inspectMs: 2_000,
  readinessMs: 10_000,
  runMs: 60_000,
  stopMs: 5_000,
  killMs: 3_000,
  cleanupMs: 5_000,
  terminationGraceMs: 250,
  readinessPollMs: 100,
};

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertFiniteInteger(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertFiniteNumber(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function assertArg(value: string, label: string): void {
  if (value.length === 0 || CONTROL_CHAR.test(value)) throw new Error(`${label} contains an invalid argument`);
}

function isContained(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${sep}`);
}

function resolveExistingDirectory(rootInput: string, candidateInput: string, label: string): string {
  const configuredRoot = resolve(rootInput);
  const requested = resolve(candidateInput);
  if (!isContained(configuredRoot, requested)) throw new Error(`${label} must be contained by its configured root`);
  const configuredRootStat = lstatSync(configuredRoot);
  if (!configuredRootStat.isDirectory() || configuredRootStat.isSymbolicLink()) {
    throw new Error(`${label} configured root must be a regular non-symlink directory`);
  }
  let pathCursor = configuredRoot;
  for (const part of relative(configuredRoot, requested).split(sep)) {
    pathCursor = join(pathCursor, part);
    if (lstatSync(pathCursor).isSymbolicLink()) throw new Error(`${label} cannot traverse a symbolic link`);
  }
  const root = realpathSync(configuredRoot);
  const candidateLstat = lstatSync(requested);
  if (!candidateLstat.isDirectory() || candidateLstat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  const candidate = realpathSync(requested);
  if (!isContained(root, candidate)) throw new Error(`${label} realpath escaped its configured root`);
  if (candidate.includes(",")) throw new Error(`${label} cannot contain a comma in a Docker bind mount`);
  return candidate;
}

function assertDisjoint(left: string, right: string): void {
  if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
    throw new Error("Writable workspace and read-only context paths must not overlap");
  }
}

function safeRelativeArtifactPath(value: string): string[] {
  if (!value || isAbsolute(value) || value.includes("\\") || CONTROL_CHAR.test(value)) {
    throw new Error("Artifact path must be a non-empty portable relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Artifact path contains an unsafe segment");
  }
  return parts;
}

function resolveWorkingDirectory(workspace: string, value: string | undefined): {
  relativePath: string;
  containerPath: string;
  digest: string;
} {
  const requested = value ?? ".";
  if (requested === ".") {
    return { relativePath: ".", containerPath: "/workspace", digest: sha(".") };
  }
  const parts = safeRelativeArtifactPath(requested);
  const relativePath = parts.join("/");
  const candidate = resolve(workspace, ...parts);
  if (!isContained(workspace, candidate)) throw new Error("Working directory escaped the workspace");
  assertNoSymlinkComponents(workspace, candidate);
  const item = lstatSync(candidate);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error("Working directory must be a regular non-symlink directory");
  }
  const real = realpathSync(candidate);
  if (!isContained(workspace, real)) throw new Error("Working directory realpath escaped the workspace");
  return {
    relativePath,
    containerPath: `/workspace/${relativePath}`,
    digest: sha(relativePath),
  };
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path escaped the workspace");
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    const item = lstatSync(cursor);
    if (item.isSymbolicLink()) throw new Error("Artifact path cannot traverse a symlink");
  }
}

function mkdirPrivateTree(root: string, parts: string[]): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact root must be a non-symlink directory");
  const realRoot = realpathSync(root);
  let cursor = realRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const item = lstatSync(cursor);
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("Artifact destination traverses an unsafe directory");
    const real = realpathSync(cursor);
    if (!isContained(realRoot, real)) throw new Error("Artifact destination escaped its root");
    cursor = real;
  }
  return cursor;
}

function writeJsonExclusive(path: string, value: Record<string, unknown>): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function replaceJson(path: string, value: Record<string, unknown>): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeJsonExclusive(temp, value);
  renameSync(temp, path);
}

function normalizeVersion(value: string): string {
  const version = value.trim();
  if (!version || version.length > 128 || CONTROL_CHAR.test(version)) return "unknown";
  return version;
}

/**
 * Docker-compatible OCI boundary for one disposable writer container per run.
 *
 * This module is intentionally not registered by config or runtime code. A
 * caller must explicitly enable and compose it after policy/lease checks.
 */
export class OciSandboxProvider {
  private readonly options: OciSandboxProviderOptions;
  private readonly enabled: boolean;
  private readonly resources: OciResourceBounds;
  private readonly timeouts: OciTimeoutBounds;
  private readonly network: OciNetworkPolicy;
  private readonly maxEngineOutputBytes: number;
  private readonly maxRunOutputBytes: number;
  private readonly user: string;
  private readonly idleCommand: string[];
  private readonly transcriptEntries: OciCommandTranscriptEntry[] = [];
  private readonly active = new Map<string, OciSandboxHandle>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly executionTails = new Map<string, Promise<void>>();
  private readonly quarantineReasons = new Map<string, OciCleanupReason>();
  private sequence = 0;

  constructor(options: OciSandboxProviderOptions) {
    this.options = options;
    this.enabled = options.enabled ?? false;
    this.resources = { ...DEFAULT_RESOURCES, ...options.resourceBounds };
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeoutBounds };
    this.network = options.networkPolicy ?? { mode: "none" };
    this.maxEngineOutputBytes = options.maxEngineOutputBytes ?? 256 * 1024;
    this.maxRunOutputBytes = options.maxRunOutputBytes ?? 1024 * 1024;
    this.user = options.user ?? this.defaultLocalUser();
    this.idleCommand = options.idleCommand ?? ["sleep", "infinity"];
    this.validateOptions();
  }

  transcript(): OciCommandTranscriptEntry[] {
    return this.transcriptEntries.map((entry) => ({ ...entry, args: [...entry.args] }));
  }

  contract(): OciSandboxContract {
    return { provider: "docker-compatible", imageRef: this.options.image, policyHash: this.policyHash() };
  }

  async preflight(): Promise<OciPreflightResult> {
    if (!this.enabled) {
      return { enabled: false, available: false, engine: "docker-compatible", reason: "disabled" };
    }
    try {
      const result = await this.invoke(
        "preflight",
        ["version", "--format", "{{.Client.Version}}"],
        this.timeouts.preflightMs,
        this.maxEngineOutputBytes,
      );
      return {
        enabled: true,
        available: true,
        engine: "docker-compatible",
        version: normalizeVersion(result.stdout),
      };
    } catch {
      return { enabled: true, available: false, engine: "docker-compatible", reason: "engine-unavailable" };
    }
  }

  async reconcileOrphans(expectations: readonly OciReconciliationExpectation[]): Promise<OciReconciliationResult[]> {
    this.assertEnabled();
    const preflight = await this.preflight();
    if (!preflight.available) throw new Error("OCI engine is unavailable for restart reconciliation");
    const runIds = new Set<string>();
    for (const expected of expectations) {
      if (runIds.has(expected.runId)) throw new Error("Duplicate sandbox reconciliation run ID");
      runIds.add(expected.runId);
      this.validateReconciliationExpectation(expected);
    }
    const inventory = await this.invoke(
      "inventory",
      ["ps", "--all", "--filter", "label=valkyrie.managed=true", "--format", "{{.ID}}"],
      this.timeouts.inspectMs,
      this.maxEngineOutputBytes,
    );
    const ids = inventory.stdout.split("\n").filter(Boolean);
    if (ids.length > 1_000 || new Set(ids).size !== ids.length || ids.some((id) => !CONTAINER_ID.test(id))) {
      throw new Error("OCI managed-container inventory is malformed or exceeds its bound");
    }
    const inspected = new Map<string, DockerInspect>();
    for (const id of ids) inspected.set(id, await this.inspectRaw(id));
    const consumed = new Set<string>();
    const results: OciReconciliationResult[] = [];
    for (const expected of expectations) {
      const candidates = [...inspected.entries()].filter(([, item]) => this.matchesReconciliationLabels(item, expected));
      if (expected.engineId && !candidates.some(([id]) => id === expected.engineId)) {
        results.push(this.recordReconciliation(expected, null, "absent", "engine_id_absent", false));
        continue;
      }
      if (candidates.length === 0) {
        results.push(this.recordReconciliation(expected, null, "absent", "engine_object_absent", false));
        continue;
      }
      if (candidates.length !== 1) {
        results.push(this.recordReconciliation(expected, null, "quarantined", "multiple_matching_engine_objects", false));
        continue;
      }
      const [containerId, item] = candidates[0];
      consumed.add(containerId);
      if (expected.cleanupAttempts >= 3) {
        results.push(this.recordReconciliation(expected, containerId, "quarantined", "cleanup_retry_exhausted", false));
        continue;
      }
      try {
        this.assertReconciliationPolicy(item, expected);
      } catch {
        results.push(this.recordReconciliation(expected, containerId, "quarantined", "ownership_or_policy_mismatch", false));
        continue;
      }
      const running = item.State?.Running === true;
      if (running) {
        try {
          await this.invoke(
            "stop",
            ["stop", "--time", String(Math.max(1, Math.ceil(this.timeouts.stopMs / 1_000))), containerId],
            this.timeouts.stopMs,
            this.maxEngineOutputBytes,
          );
        } catch {
          try {
            await this.invoke("kill", ["kill", containerId], this.timeouts.killMs, this.maxEngineOutputBytes);
          } catch {
            results.push(this.recordReconciliation(expected, containerId, "quarantined", "restart_stop_failed", true));
            continue;
          }
        }
      }
      try {
        await this.invoke(
          "cleanup",
          ["rm", "--force", "--volumes", containerId],
          this.timeouts.cleanupMs,
          this.maxEngineOutputBytes,
        );
        results.push(this.recordReconciliation(expected, containerId, "cleaned", "restart_orphan_removed", true));
      } catch {
        results.push(this.recordReconciliation(expected, containerId, "quarantined", "restart_remove_failed", true));
      }
    }
    for (const id of ids) {
      if (!consumed.has(id)) {
        results.push({
          runId: null, workspaceId: null, containerId: id, outcome: "unmatched",
          reason: "managed_engine_object_without_database_instance", cleanupAttempted: false,
        });
      }
    }
    return results;
  }

  async start(input: OciSandboxStartInput): Promise<OciSandboxHandle> {
    this.assertEnabled();
    if (!RUN_ID.test(input.runId)) throw new Error("runId is not valid for an OCI ownership label");
    if (!RUN_ID.test(input.workspaceId)) throw new Error("workspaceId is not valid for an OCI ownership label");
    if (!RUN_ID.test(input.leaseOwnerId)) throw new Error("leaseOwnerId is not valid for an OCI ownership label");
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error("fencingToken must be a positive safe integer");
    }
    if (this.active.has(input.runId)) throw new Error("A writer container already exists for this run");
    if (this.hasPersistedRunState(input.runId)) {
      throw new Error("This run already has persistent OCI container state");
    }

    const workspacePath = resolveExistingDirectory(this.options.workspaceRoot, input.workspacePath, "Workspace");
    const contextPath = resolveExistingDirectory(this.options.contextRoot, input.contextPath, "Context");
    assertDisjoint(workspacePath, contextPath);
    assertDisjoint(workspacePath, resolve(this.options.stateRoot));
    assertDisjoint(contextPath, resolve(this.options.stateRoot));
    assertDisjoint(workspacePath, resolve(this.options.artifactRoot));
    assertDisjoint(contextPath, resolve(this.options.artifactRoot));
    const workingDirectory = resolveWorkingDirectory(workspacePath, input.workingDirectoryRelativePath);
    const stateRoot = mkdirPrivateTree(resolve(this.options.stateRoot), []);
    const artifactRoot = mkdirPrivateTree(resolve(this.options.artifactRoot), []);
    assertDisjoint(workspacePath, stateRoot);
    assertDisjoint(contextPath, stateRoot);
    assertDisjoint(workspacePath, artifactRoot);
    assertDisjoint(contextPath, artifactRoot);

    const runDigest = sha(input.runId);
    const workspaceDigest = sha(workspacePath);
    const contextDigest = sha(contextPath);
    const containerName = `valkyrie-${runDigest.slice(0, 24)}`;
    const activeRoot = mkdirPrivateTree(stateRoot, ["active"]);
    const recordPath = join(activeRoot, `${runDigest}.json`);
    writeJsonExclusive(recordPath, {
      schemaVersion: 1,
      runId: input.runId,
      workspaceId: input.workspaceId,
      leaseOwnerDigest: sha(input.leaseOwnerId),
      fencingToken: input.fencingToken,
      imageRef: this.options.image,
      policyHash: this.policyHash(),
      containerName,
      workspaceDigest,
      contextDigest,
      workingDirectoryDigest: workingDirectory.digest,
      status: "creating",
    });

    let handle: OciSandboxHandle | undefined;
    let reservationFailure: OciCleanupReason = "CREATE_UNCERTAIN";
    try {
      const create = await this.invoke(
        "create",
        this.createArgs(
          input.runId,
          input.workspaceId,
          input.leaseOwnerId,
          input.fencingToken,
          containerName,
          workspacePath,
          contextPath,
          workspaceDigest,
          contextDigest,
          workingDirectory.containerPath,
          workingDirectory.digest,
        ),
        this.timeouts.startMs,
        this.maxEngineOutputBytes,
      );
      const containerId = create.stdout.trim();
      if (!CONTAINER_ID.test(containerId)) {
        reservationFailure = "INVALID_CONTAINER_ID";
        throw new Error("OCI engine returned an invalid container ID");
      }
      handle = {
        runId: input.runId,
        workspaceId: input.workspaceId,
        leaseOwnerId: input.leaseOwnerId,
        fencingToken: input.fencingToken,
        containerId,
        containerName,
        workspacePath,
        contextPath,
        workspaceDigest,
        contextDigest,
        workingDirectoryRelativePath: workingDirectory.relativePath,
        workingDirectoryDigest: workingDirectory.digest,
        status: "stopped",
      };
      this.active.set(input.runId, handle);
      replaceJson(recordPath, {
        schemaVersion: 1,
        runId: input.runId,
        workspaceId: input.workspaceId,
        leaseOwnerDigest: sha(input.leaseOwnerId),
        fencingToken: input.fencingToken,
        imageRef: this.options.image,
        policyHash: this.policyHash(),
        containerId,
        containerName,
        workspaceDigest,
        contextDigest,
        workingDirectoryDigest: workingDirectory.digest,
        status: "created",
      });

      await this.invoke("start", ["start", containerId], this.timeouts.startMs, this.maxEngineOutputBytes);
      await this.waitUntilReady(handle);
      handle.status = "running";
      replaceJson(recordPath, {
        schemaVersion: 1,
        runId: input.runId,
        workspaceId: input.workspaceId,
        leaseOwnerDigest: sha(input.leaseOwnerId),
        fencingToken: input.fencingToken,
        imageRef: this.options.image,
        policyHash: this.policyHash(),
        containerId,
        containerName,
        workspaceDigest,
        contextDigest,
        workingDirectoryDigest: workingDirectory.digest,
        status: "running",
      });
      return handle;
    } catch (error) {
      if (handle) await this.cleanup(handle);
      else this.quarantineReservation(recordPath, input.runId, containerName, workspaceDigest, contextDigest,
        workingDirectory.digest, input.workspaceId, input.leaseOwnerId, input.fencingToken, reservationFailure);
      throw error;
    }
  }

  async execute(handle: OciSandboxHandle, command: readonly string[]): Promise<OciRunResult> {
    return this.withExecutionLock(handle.runId, async () => {
      await this.withLifecycleLock(handle.runId, async () => {
        this.assertOwnedHandle(handle);
        if (handle.status !== "running") throw new Error("OCI sandbox is not running");
        const ownership = await this.safeInspectOwnership(handle);
        if (ownership === "inspect-failed") {
          this.quarantine(handle, "INSPECT_FAILED");
          throw new Error("OCI sandbox inspection failed before command execution");
        }
        if (ownership === "ownership-mismatch") {
          this.quarantine(handle, "OWNERSHIP_MISMATCH");
          throw new Error("OCI sandbox ownership changed before command execution");
        }
        if (!ownership.ready) throw new Error("OCI sandbox is not ready for command execution");
        if (command.length === 0) throw new Error("Container command cannot be empty");
        for (const [index, value] of command.entries()) assertArg(value, `command[${index}]`);
      });
      try {
        return await this.invoke(
          "execute",
          ["exec", handle.containerId, ...command],
          this.timeouts.runMs,
          this.maxRunOutputBytes,
        );
      } catch (error) {
        await this.withLifecycleLock(handle.runId, async () => {
          if (handle.status === "running") await this.emergencyStop(handle);
        });
        throw error;
      }
    });
  }

  async stop(handle: OciSandboxHandle): Promise<OciCleanupResult | { status: "stopped" }> {
    return this.withLifecycleLock(handle.runId, () => {
      if (handle.status === "quarantined") return this.existingQuarantine(handle);
      return this.stopUnlocked(handle);
    });
  }

  private async stopUnlocked(handle: OciSandboxHandle): Promise<OciCleanupResult | { status: "stopped" }> {
    this.assertOwnedHandle(handle);
    const ownership = await this.safeInspectOwnership(handle);
    if (ownership === "inspect-failed") return this.quarantine(handle, "INSPECT_FAILED");
    if (ownership === "ownership-mismatch") return this.quarantine(handle, "OWNERSHIP_MISMATCH");
    if (!ownership.running) {
      handle.status = "stopped";
      this.replaceActiveState(handle, "stopped");
      return { status: "stopped" };
    }
    try {
      await this.invoke(
        "stop",
        ["stop", "--time", String(Math.max(1, Math.ceil(this.timeouts.stopMs / 1_000))), handle.containerId],
        this.timeouts.stopMs,
        this.maxEngineOutputBytes,
      );
      handle.status = "stopped";
      this.replaceActiveState(handle, "stopped");
      return { status: "stopped" };
    } catch {
      try {
        await this.invoke("kill", ["kill", handle.containerId], this.timeouts.killMs, this.maxEngineOutputBytes);
        handle.status = "stopped";
        this.replaceActiveState(handle, "stopped");
        return { status: "stopped" };
      } catch {
        return this.quarantine(handle, "KILL_FAILED");
      }
    }
  }

  async cleanup(handle: OciSandboxHandle): Promise<OciCleanupResult> {
    return this.withLifecycleLock(handle.runId, () => {
      if (handle.status === "quarantined") return this.existingQuarantine(handle);
      return this.cleanupUnlocked(handle);
    });
  }

  private async cleanupUnlocked(handle: OciSandboxHandle): Promise<OciCleanupResult> {
    this.assertOwnedHandle(handle);
    const ownership = await this.safeInspectOwnership(handle);
    if (ownership === "inspect-failed") return this.quarantine(handle, "INSPECT_FAILED");
    if (ownership === "ownership-mismatch") return this.quarantine(handle, "OWNERSHIP_MISMATCH");

    if (ownership.running) {
      const stopped = await this.stopUnlocked(handle);
      if (stopped.status === "quarantined") return stopped;
    }

    const activeRecord = this.activeRecordPath(handle.runId);
    this.replaceActiveState(handle, "removing");
    try {
      await this.invoke(
        "cleanup",
        ["rm", "--force", "--volumes", handle.containerId],
        this.timeouts.cleanupMs,
        this.maxEngineOutputBytes,
      );
    } catch {
      return this.quarantine(handle, "REMOVE_FAILED");
    }

    handle.status = "cleaned";
    this.active.delete(handle.runId);
    this.quarantineReasons.delete(handle.runId);
    replaceJson(activeRecord, {
      schemaVersion: 1,
      runId: handle.runId,
      workspaceId: handle.workspaceId,
      leaseOwnerDigest: sha(handle.leaseOwnerId),
      fencingToken: handle.fencingToken,
      imageRef: this.options.image,
      policyHash: this.policyHash(),
      containerId: handle.containerId,
      containerName: handle.containerName,
      workspaceDigest: handle.workspaceDigest,
      contextDigest: handle.contextDigest,
      workingDirectoryDigest: handle.workingDirectoryDigest,
      status: "cleaned",
    });
    const completedRoot = mkdirPrivateTree(resolve(this.options.stateRoot), ["completed"]);
    renameSync(activeRecord, join(completedRoot, `${sha(handle.runId)}.json`));
    return { status: "cleaned" };
  }

  private validateOptions(): void {
    if (!isAbsolute(this.options.engineCommand)) throw new Error("engineCommand must be an absolute executable path");
    assertArg(this.options.engineCommand, "engineCommand");
    for (const [index, value] of (this.options.enginePrefixArgs ?? []).entries()) {
      assertArg(value, `enginePrefixArgs[${index}]`);
    }
    if (this.options.engineSocket !== undefined) {
      assertArg(this.options.engineSocket, "engineSocket");
      let socket: URL;
      try {
        socket = new URL(this.options.engineSocket);
      } catch {
        throw new Error("engineSocket must be an absolute unix:/// URL");
      }
      if (socket.protocol !== "unix:" || socket.hostname || !socket.pathname.startsWith("/") || socket.search || socket.hash) {
        throw new Error("engineSocket must be a local absolute unix:/// URL; remote engines are not allowed");
      }
    }
    if (!SHA256_IMAGE.test(this.options.image)) throw new Error("OCI image must use an immutable sha256 digest reference");
    if (this.network.mode === "named" && !NETWORK_NAME.test(this.network.name)) {
      throw new Error("Named OCI network is invalid");
    }
    assertFiniteInteger("memoryBytes", this.resources.memoryBytes, 64 * 1024 * 1024, 32 * 1024 * 1024 * 1024);
    assertFiniteNumber("cpus", this.resources.cpus, 0.1, 32);
    assertFiniteInteger("pidsLimit", this.resources.pidsLimit, 16, 4_096);
    assertFiniteInteger("tmpfsBytes", this.resources.tmpfsBytes, 1024 * 1024, 4 * 1024 * 1024 * 1024);
    for (const [name, value] of Object.entries(this.timeouts)) {
      assertFiniteInteger(name, value, 25, 10 * 60 * 1000);
    }
    assertFiniteInteger("maxEngineOutputBytes", this.maxEngineOutputBytes, 1024, 16 * 1024 * 1024);
    assertFiniteInteger("maxRunOutputBytes", this.maxRunOutputBytes, 1024, 64 * 1024 * 1024);
    if (!/^[0-9]{1,10}:[0-9]{1,10}$/.test(this.user)) throw new Error("OCI user must be an explicit numeric uid:gid");
    const [uid, gid] = this.user.split(":").map(Number);
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
      throw new Error("OCI user must be an explicit non-root numeric uid:gid");
    }
    if (this.idleCommand.length === 0) throw new Error("idleCommand cannot be empty");
    for (const [index, value] of this.idleCommand.entries()) assertArg(value, `idleCommand[${index}]`);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("OCI sandbox provider is disabled");
  }

  private assertOwnedHandle(handle: OciSandboxHandle): void {
    this.assertEnabled();
    const active = this.active.get(handle.runId);
    if (!active || active !== handle || active.containerId !== handle.containerId) {
      throw new Error("OCI sandbox handle is not owned by this provider instance");
    }
  }

  private createArgs(
    runId: string,
    workspaceId: string,
    leaseOwnerId: string,
    fencingToken: number,
    containerName: string,
    workspacePath: string,
    contextPath: string,
    workspaceDigest: string,
    contextDigest: string,
    containerWorkingDirectory: string,
    workingDirectoryDigest: string,
  ): string[] {
    const network = this.network.mode === "none" ? "none" : this.network.name;
    return [
      "create",
      "--name", containerName,
      "--hostname", "valkyrie-sandbox",
      "--label", "valkyrie.managed=true",
      "--label", `valkyrie.run-id=${runId}`,
      "--label", `valkyrie.workspace-id=${workspaceId}`,
      "--label", `valkyrie.lease-owner-sha256=${sha(leaseOwnerId)}`,
      "--label", `valkyrie.lease-fencing-token=${fencingToken}`,
      "--label", `valkyrie.policy-sha256=${this.policyHash()}`,
      "--label", `valkyrie.workspace-sha256=${workspaceDigest}`,
      "--label", `valkyrie.context-sha256=${contextDigest}`,
      "--label", `valkyrie.workdir-sha256=${workingDirectoryDigest}`,
      "--pull", "never",
      "--network", network,
      "--ipc", "none",
      "--restart", "no",
      "--memory", String(this.resources.memoryBytes),
      "--cpus", String(this.resources.cpus),
      "--pids-limit", String(this.resources.pidsLimit),
      "--read-only",
      "--init",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--security-opt", "seccomp=builtin",
      "--user", this.user,
      "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${this.resources.tmpfsBytes}`,
      "--mount", `type=bind,src=${workspacePath},dst=/workspace`,
      "--mount", `type=bind,src=${contextPath},dst=/run-context,readonly`,
      "--workdir", containerWorkingDirectory,
      "--entrypoint", this.idleCommand[0],
      this.options.image,
      ...this.idleCommand.slice(1),
    ];
  }

  private async waitUntilReady(handle: OciSandboxHandle): Promise<void> {
    const deadline = Date.now() + this.timeouts.readinessMs;
    while (Date.now() <= deadline) {
      const ownership = await this.inspectOwnership(handle);
      if (ownership.ready) return;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, this.timeouts.readinessPollMs));
    }
    throw new Error("OCI sandbox did not become ready within its bound");
  }

  private async safeInspectOwnership(
    handle: OciSandboxHandle,
  ): Promise<OwnershipInspection | "inspect-failed" | "ownership-mismatch"> {
    try {
      return await this.inspectOwnership(handle);
    } catch (error) {
      return error instanceof OciEngineCommandError ? "inspect-failed" : "ownership-mismatch";
    }
  }

  private async inspectOwnership(handle: OciSandboxHandle): Promise<OwnershipInspection> {
    const item = await this.inspectRaw(handle.containerId);
    const labels = item.Config?.Labels;
    if (
      item.Id !== handle.containerId
      || item.Config?.Image !== this.options.image
      || !labels
      || labels["valkyrie.managed"] !== "true"
      || labels["valkyrie.run-id"] !== handle.runId
      || labels["valkyrie.workspace-id"] !== handle.workspaceId
      || labels["valkyrie.lease-owner-sha256"] !== sha(handle.leaseOwnerId)
      || labels["valkyrie.lease-fencing-token"] !== String(handle.fencingToken)
      || labels["valkyrie.policy-sha256"] !== this.policyHash()
      || labels["valkyrie.workspace-sha256"] !== handle.workspaceDigest
      || labels["valkyrie.context-sha256"] !== handle.contextDigest
      || labels["valkyrie.workdir-sha256"] !== handle.workingDirectoryDigest
      || item.Config?.WorkingDir !== (handle.workingDirectoryRelativePath === "."
        ? "/workspace"
        : `/workspace/${handle.workingDirectoryRelativePath}`)
      || item.Config?.User !== this.user
    ) {
      throw new Error("OCI ownership labels or stable ID do not match the run contract");
    }
    const expectedNetwork = this.network.mode === "none" ? "none" : this.network.name;
    if (item.HostConfig?.NetworkMode !== expectedNetwork) throw new Error("OCI network policy changed after create");
    const effectiveNetworks = item.NetworkSettings?.Networks;
    if (!effectiveNetworks || Object.keys(effectiveNetworks).length !== 1 || !(expectedNetwork in effectiveNetworks)) {
      throw new Error("OCI effective network attachments changed after create");
    }
    const expectedTmpfs = `/tmp:rw,nosuid,nodev,noexec,size=${this.resources.tmpfsBytes}`;
    const capDrop = item.HostConfig?.CapDrop;
    const securityOpt = item.HostConfig?.SecurityOpt;
    const tmpfs = item.HostConfig?.Tmpfs;
    if (
      item.HostConfig?.IpcMode !== "none"
      || item.HostConfig?.Privileged !== false
      || item.HostConfig?.RestartPolicy?.Name !== "no"
      || item.HostConfig?.RestartPolicy?.MaximumRetryCount !== 0
      || item.HostConfig?.ReadonlyRootfs !== true
      || item.HostConfig?.Memory !== this.resources.memoryBytes
      || item.HostConfig?.NanoCpus !== Math.round(this.resources.cpus * 1_000_000_000)
      || item.HostConfig?.PidsLimit !== this.resources.pidsLimit
      || !Array.isArray(capDrop)
      || capDrop.length !== 1
      || capDrop[0] !== "ALL"
      || !Array.isArray(securityOpt)
      || securityOpt.length !== 2
      || !securityOpt.includes("no-new-privileges:true")
      || !securityOpt.includes("seccomp=builtin")
      || !tmpfs
      || typeof tmpfs !== "object"
      || Object.keys(tmpfs as Record<string, unknown>).length !== 1
      || (tmpfs as Record<string, unknown>)["/tmp"] !== expectedTmpfs.slice("/tmp:".length)
      || item.HostConfig?.Init !== true
    ) {
      throw new Error("OCI resource or privilege policy changed after create");
    }

    const hostMounts = (item.Mounts ?? []).filter((mount) => mount.Type !== "tmpfs");
    if (hostMounts.length !== 2) throw new Error("OCI container has an unexpected host mount");
    const workspaceMount = hostMounts.find((mount) => mount.Destination === "/workspace");
    const contextMount = hostMounts.find((mount) => mount.Destination === "/run-context");
    if (
      workspaceMount?.Type !== "bind"
      || workspaceMount.Source !== handle.workspacePath
      || workspaceMount.RW !== true
      || contextMount?.Type !== "bind"
      || contextMount.Source !== handle.contextPath
      || contextMount.RW !== false
    ) {
      throw new Error("OCI mount contract changed after create");
    }

    const running = item.State?.Running === true;
    const health = item.State?.Health?.Status;
    if (health !== undefined && health !== "healthy" && health !== "starting") {
      throw new Error("OCI sandbox reported an unhealthy state");
    }
    return { running, ready: running && (health === undefined || health === "healthy") };
  }

  private async inspectRaw(containerId: string): Promise<DockerInspect> {
    const result = await this.invoke(
      "inspect",
      ["inspect", "--type", "container", containerId],
      this.timeouts.inspectMs,
      this.maxEngineOutputBytes,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("OCI inspect returned malformed JSON");
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
      throw new Error("OCI inspect must return exactly one container");
    }
    return parsed[0] as DockerInspect;
  }

  private validateReconciliationExpectation(expected: OciReconciliationExpectation): void {
    if (!RUN_ID.test(expected.runId) || !RUN_ID.test(expected.workspaceId) || !RUN_ID.test(expected.leaseOwnerId)) {
      throw new Error("Sandbox reconciliation identity is invalid");
    }
    if (!Number.isSafeInteger(expected.fencingToken) || expected.fencingToken < 1) {
      throw new Error("Sandbox reconciliation fence is invalid");
    }
    if (expected.engineId !== null && !CONTAINER_ID.test(expected.engineId)) {
      throw new Error("Sandbox reconciliation engine ID is invalid");
    }
    if (expected.imageRef !== this.options.image || expected.policyHash !== this.policyHash()) {
      throw new Error("Sandbox reconciliation provider contract does not match this provider");
    }
    if ([expected.workspaceDigest, expected.contextDigest, expected.workdirDigest].some((value) => !CONTAINER_ID.test(value))) {
      throw new Error("Sandbox reconciliation path digest is invalid");
    }
    if (!Number.isSafeInteger(expected.cleanupAttempts) || expected.cleanupAttempts < 0 || expected.cleanupAttempts > 1_000) {
      throw new Error("Sandbox reconciliation cleanup attempts are invalid");
    }
  }

  private matchesReconciliationLabels(item: DockerInspect, expected: OciReconciliationExpectation): boolean {
    const labels = item.Config?.Labels;
    return typeof item.Id === "string"
      && !!labels
      && labels["valkyrie.managed"] === "true"
      && labels["valkyrie.run-id"] === expected.runId
      && labels["valkyrie.workspace-id"] === expected.workspaceId
      && labels["valkyrie.lease-owner-sha256"] === sha(expected.leaseOwnerId)
      && labels["valkyrie.lease-fencing-token"] === String(expected.fencingToken)
      && labels["valkyrie.policy-sha256"] === expected.policyHash;
  }

  private assertReconciliationPolicy(item: DockerInspect, expected: OciReconciliationExpectation): void {
    const labels = item.Config?.Labels;
    if (!this.matchesReconciliationLabels(item, expected)
        || item.Config?.Image !== expected.imageRef
        || labels?.["valkyrie.workspace-sha256"] !== expected.workspaceDigest
        || labels?.["valkyrie.context-sha256"] !== expected.contextDigest
        || labels?.["valkyrie.workdir-sha256"] !== expected.workdirDigest
        || item.Config?.User !== this.user) {
      throw new Error("OCI restart ownership labels do not match durable state");
    }
    const expectedNetwork = this.network.mode === "none" ? "none" : this.network.name;
    const effectiveNetworks = item.NetworkSettings?.Networks;
    const expectedTmpfs = `rw,nosuid,nodev,noexec,size=${this.resources.tmpfsBytes}`;
    if (item.HostConfig?.NetworkMode !== expectedNetwork
        || !effectiveNetworks || Object.keys(effectiveNetworks).length !== 1 || !(expectedNetwork in effectiveNetworks)
        || item.HostConfig?.IpcMode !== "none" || item.HostConfig?.Privileged !== false
        || item.HostConfig?.RestartPolicy?.Name !== "no" || item.HostConfig?.RestartPolicy?.MaximumRetryCount !== 0
        || item.HostConfig?.ReadonlyRootfs !== true || item.HostConfig?.Memory !== this.resources.memoryBytes
        || item.HostConfig?.NanoCpus !== Math.round(this.resources.cpus * 1_000_000_000)
        || item.HostConfig?.PidsLimit !== this.resources.pidsLimit
        || !Array.isArray(item.HostConfig?.CapDrop) || item.HostConfig?.CapDrop.length !== 1
        || item.HostConfig.CapDrop[0] !== "ALL"
        || !Array.isArray(item.HostConfig?.SecurityOpt) || item.HostConfig?.SecurityOpt.length !== 2
        || !item.HostConfig.SecurityOpt.includes("no-new-privileges:true")
        || !item.HostConfig.SecurityOpt.includes("seccomp=builtin")
        || !item.HostConfig?.Tmpfs || Object.keys(item.HostConfig.Tmpfs as Record<string, unknown>).length !== 1
        || (item.HostConfig.Tmpfs as Record<string, unknown>)["/tmp"] !== expectedTmpfs
        || item.HostConfig?.Init !== true) {
      throw new Error("OCI restart resource or privilege policy does not match durable state");
    }
    const mounts = (item.Mounts ?? []).filter((mount) => mount.Type !== "tmpfs");
    const workspace = mounts.find((mount) => mount.Destination === "/workspace");
    const context = mounts.find((mount) => mount.Destination === "/run-context");
    if (mounts.length !== 2 || workspace?.Type !== "bind" || workspace.RW !== true
        || context?.Type !== "bind" || context.RW !== false
        || typeof workspace.Source !== "string" || typeof context.Source !== "string"
        || sha(workspace.Source) !== expected.workspaceDigest || sha(context.Source) !== expected.contextDigest) {
      throw new Error("OCI restart mount policy does not match durable state");
    }
    const workspaceRoot = realpathSync(resolve(this.options.workspaceRoot));
    const contextRoot = realpathSync(resolve(this.options.contextRoot));
    if (!isContained(workspaceRoot, resolve(workspace.Source)) || !isContained(contextRoot, resolve(context.Source))) {
      throw new Error("OCI restart mount escaped its configured root");
    }
    const workingDir = item.Config?.WorkingDir;
    const relativeWorkdir = workingDir === "/workspace"
      ? "."
      : typeof workingDir === "string" && workingDir.startsWith("/workspace/")
        ? workingDir.slice("/workspace/".length)
        : null;
    if (!relativeWorkdir || sha(relativeWorkdir) !== expected.workdirDigest) {
      throw new Error("OCI restart working directory does not match durable state");
    }
  }

  private recordReconciliation(
    expected: OciReconciliationExpectation,
    containerId: string | null,
    outcome: "cleaned" | "absent" | "quarantined",
    reason: string,
    cleanupAttempted: boolean,
  ): OciReconciliationResult {
    const root = mkdirPrivateTree(resolve(this.options.stateRoot), []);
    const destination = mkdirPrivateTree(root, [outcome === "quarantined" ? "quarantine" : "completed"]);
    const name = `${sha(expected.runId)}.json`;
    const activeRecord = join(root, "active", name);
    const destinationRecord = join(destination, name);
    const value = {
      schemaVersion: 1,
      runId: expected.runId,
      workspaceId: expected.workspaceId,
      leaseOwnerDigest: sha(expected.leaseOwnerId),
      fencingToken: expected.fencingToken,
      imageRef: expected.imageRef,
      policyHash: expected.policyHash,
      ...(containerId ? { containerId } : {}),
      workspaceDigest: expected.workspaceDigest,
      contextDigest: expected.contextDigest,
      workingDirectoryDigest: expected.workdirDigest,
      status: `restart_${outcome}`,
      reason,
      cleanupAttempted,
    };
    if (existsSync(activeRecord)) {
      replaceJson(activeRecord, value);
      if (existsSync(destinationRecord)) rmSync(destinationRecord, { force: true });
      renameSync(activeRecord, destinationRecord);
    } else if (existsSync(destinationRecord)) replaceJson(destinationRecord, value);
    else writeJsonExclusive(destinationRecord, value);
    return {
      runId: expected.runId,
      workspaceId: expected.workspaceId,
      containerId,
      outcome,
      reason,
      cleanupAttempted,
    };
  }

  private async emergencyStop(handle: OciSandboxHandle): Promise<void> {
    try {
      await this.invoke(
        "stop",
        ["stop", "--time", String(Math.max(1, Math.ceil(this.timeouts.stopMs / 1_000))), handle.containerId],
        this.timeouts.stopMs,
        this.maxEngineOutputBytes,
      );
      handle.status = "stopped";
      this.replaceActiveState(handle, "stopped");
    } catch {
      try {
        await this.invoke("kill", ["kill", handle.containerId], this.timeouts.killMs, this.maxEngineOutputBytes);
        handle.status = "stopped";
        this.replaceActiveState(handle, "stopped");
      } catch {
        this.quarantine(handle, "KILL_FAILED");
      }
    }
  }

  private defaultLocalUser(): string {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
    if (Number.isSafeInteger(uid) && Number(uid) > 0 && Number.isSafeInteger(gid) && Number(gid) > 0) {
      return `${uid}:${gid}`;
    }
    throw new Error("OCI user must be configured explicitly when a non-root host uid:gid cannot be derived");
  }

  private quarantine(handle: OciSandboxHandle, reason: OciCleanupReason): OciCleanupResult {
    handle.status = "quarantined";
    this.active.delete(handle.runId);
    this.quarantineReasons.set(handle.runId, reason);
    const quarantineRoot = mkdirPrivateTree(resolve(this.options.stateRoot), ["quarantine"]);
    const record = join(quarantineRoot, `${sha(handle.runId)}.json`);
    const value = {
      schemaVersion: 1,
      runId: handle.runId,
      workspaceId: handle.workspaceId,
      leaseOwnerDigest: sha(handle.leaseOwnerId),
      fencingToken: handle.fencingToken,
      imageRef: this.options.image,
      policyHash: this.policyHash(),
      containerId: handle.containerId,
      containerName: handle.containerName,
      workspaceDigest: handle.workspaceDigest,
      contextDigest: handle.contextDigest,
      workingDirectoryDigest: handle.workingDirectoryDigest,
      status: "quarantined",
      reason,
    };
    const activeRecord = this.activeRecordPath(handle.runId);
    if (existsSync(activeRecord)) {
      replaceJson(activeRecord, value);
      if (existsSync(record)) rmSync(record, { force: true });
      renameSync(activeRecord, record);
    } else if (existsSync(record)) replaceJson(record, value);
    else writeJsonExclusive(record, value);
    return { status: "quarantined", reason, quarantineRecord: record };
  }

  private existingQuarantine(handle: OciSandboxHandle): OciCleanupResult {
    const reason = this.quarantineReasons.get(handle.runId) ?? "OWNERSHIP_MISMATCH";
    return {
      status: "quarantined",
      reason,
      quarantineRecord: join(resolve(this.options.stateRoot), "quarantine", `${sha(handle.runId)}.json`),
    };
  }

  private quarantineReservation(
    activeRecord: string,
    runId: string,
    containerName: string,
    workspaceDigest: string,
    contextDigest: string,
    workingDirectoryDigest: string,
    workspaceId: string,
    leaseOwnerId: string,
    fencingToken: number,
    reason: OciCleanupReason,
  ): void {
    const quarantineRoot = mkdirPrivateTree(resolve(this.options.stateRoot), ["quarantine"]);
    const record = join(quarantineRoot, `${sha(runId)}.json`);
    const value = {
      schemaVersion: 1,
      runId,
      workspaceId,
      leaseOwnerDigest: sha(leaseOwnerId),
      fencingToken,
      imageRef: this.options.image,
      policyHash: this.policyHash(),
      containerName,
      workspaceDigest,
      contextDigest,
      workingDirectoryDigest,
      status: "quarantined",
      reason,
    };
    replaceJson(activeRecord, value);
    if (existsSync(record)) rmSync(record, { force: true });
    renameSync(activeRecord, record);
  }

  private activeRecordPath(runId: string): string {
    return join(resolve(this.options.stateRoot), "active", `${sha(runId)}.json`);
  }

  private replaceActiveState(handle: OciSandboxHandle, status: "running" | "stopped" | "removing"): void {
    replaceJson(this.activeRecordPath(handle.runId), {
      schemaVersion: 1,
      runId: handle.runId,
      workspaceId: handle.workspaceId,
      leaseOwnerDigest: sha(handle.leaseOwnerId),
      fencingToken: handle.fencingToken,
      imageRef: this.options.image,
      policyHash: this.policyHash(),
      containerId: handle.containerId,
      containerName: handle.containerName,
      workspaceDigest: handle.workspaceDigest,
      contextDigest: handle.contextDigest,
      workingDirectoryDigest: handle.workingDirectoryDigest,
      status,
    });
  }

  private hasPersistedRunState(runId: string): boolean {
    const name = `${sha(runId)}.json`;
    const root = resolve(this.options.stateRoot);
    return ["active", "quarantine", "completed"].some((kind) => existsSync(join(root, kind, name)));
  }

  private policyHash(): string {
    return sha(JSON.stringify({
      schemaVersion: 1,
      imageRef: this.options.image,
      user: this.user,
      network: this.network,
      resources: this.resources,
      idleCommand: this.idleCommand,
      rootReadonly: true,
      ipc: "none",
      init: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true", "seccomp=builtin"],
      tmpfs: { destination: "/tmp", options: "rw,nosuid,nodev,noexec", bytes: this.resources.tmpfsBytes },
    }));
  }

  private withLifecycleLock<T>(runId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.lifecycleTails.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.lifecycleTails.set(runId, tail);
    return result.finally(() => {
      if (this.lifecycleTails.get(runId) === tail) this.lifecycleTails.delete(runId);
    });
  }

  private withExecutionLock<T>(runId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.executionTails.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.executionTails.set(runId, tail);
    return result.finally(() => {
      if (this.executionTails.get(runId) === tail) this.executionTails.delete(runId);
    });
  }

  private redactArgs(operation: OciCommandTranscriptEntry["operation"], args: readonly string[]): string[] {
    if (operation === "execute") {
      const command = args.slice(2);
      return ["exec", args[1]?.slice(0, 12) ?? "<container>", `<argv:${command.length}:sha256:${sha(command.join("\0"))}>`];
    }
    return args.map((arg) => {
      if (/^valkyrie\.[A-Za-z0-9_.-]+=/.test(arg)) {
        return `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>`;
      }
      if (arg.startsWith("type=bind,") && arg.includes("dst=/workspace")) {
        return "type=bind,src=<workspace>,dst=/workspace";
      }
      if (arg.startsWith("type=bind,") && arg.includes("dst=/run-context")) {
        return "type=bind,src=<context>,dst=/run-context,readonly";
      }
      return arg;
    });
  }

  private invoke(
    operation: OciCommandTranscriptEntry["operation"],
    args: string[],
    timeoutMs: number,
    outputLimit: number,
  ): Promise<CommandResult> {
    for (const [index, value] of args.entries()) assertArg(value, `${operation} argv[${index}]`);
    const started = Date.now();
    return new Promise<CommandResult>((resolveCommand, rejectCommand) => {
      let child;
      try {
        child = spawn(
          this.options.engineCommand,
          [...(this.options.enginePrefixArgs ?? []), ...args],
          {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              LANG: "C",
              LC_ALL: "C",
              ...(this.options.engineSocket ? { DOCKER_HOST: this.options.engineSocket } : {}),
            },
          },
        );
      } catch {
        rejectCommand(new OciEngineCommandError(operation, "SPAWN_FAILED"));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: OciEngineCommandError["code"] | undefined;
      let settled = false;
      let timedOut = false;
      let outputLimitExceeded = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), this.timeouts.terminationGraceMs);
        killTimer.unref();
      };
      const onData = (target: Buffer[], chunkValue: Buffer | string, isStdout: boolean): void => {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        if (isStdout) stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > outputLimit) {
          if (!failure) {
            failure = "OUTPUT_LIMIT";
            outputLimitExceeded = true;
            terminate();
          }
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk) => onData(stdout, chunk, true));
      child.stderr.on("data", (chunk) => onData(stderr, chunk, false));

      const timeout = setTimeout(() => {
        if (failure) return;
        failure = "TIMEOUT";
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref();

      const finish = (exitCode: number | null, spawnFailed = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const transcript: OciCommandTranscriptEntry = {
          sequence: ++this.sequence,
          operation,
          command: basename(this.options.engineCommand),
          args: this.redactArgs(operation, args),
          exitCode,
          timedOut,
          outputLimitExceeded,
          stdoutBytes,
          stderrBytes,
          durationMs: Date.now() - started,
        };
        this.transcriptEntries.push(transcript);
        if (spawnFailed) {
          rejectCommand(new OciEngineCommandError(operation, "SPAWN_FAILED"));
        } else if (failure) {
          rejectCommand(new OciEngineCommandError(operation, failure, exitCode));
        } else if (exitCode !== 0) {
          rejectCommand(new OciEngineCommandError(operation, "EXIT_NONZERO", exitCode));
        } else {
          resolveCommand({
            exitCode: 0,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdoutBytes,
            stderrBytes,
          });
        }
      };

      child.once("error", () => finish(null, true));
      child.once("close", (code) => finish(code));
    });
  }
}
