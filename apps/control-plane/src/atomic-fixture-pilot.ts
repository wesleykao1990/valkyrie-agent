import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AtomicRpcClient,
  AtomicRpcNativeEvent,
  AtomicRpcResponse,
} from "./atomic-rpc-client.ts";
import { validateAtomicLaunchManifest } from "./atomic-runtime-adapter.ts";
import {
  ATOMIC_FIXTURE_WORKFLOW_NAME,
  buildAtomicFixtureWorkflowDispatchCommand,
  buildAtomicWorkflowStatusCommand,
  isTerminalAtomicWorkflowStatus,
  parseAtomicFixtureWorkflowOutput,
  parseAtomicWorkflowLifecycleEvent,
  parseAtomicWorkflowListEvent,
  type AtomicFixtureWorkflowOutput,
  type AtomicWorkflowLifecycleDetail,
} from "./atomic-workflow-protocol.ts";
import { id } from "./ids.ts";
import { contextPackChecksum, type LocalProjectBrain } from "./project-brain.ts";
import {
  approvalBindingOf,
  canonicalJson,
  type ControlPlaneStore,
  type SandboxInstance,
  type WorkspaceRecord,
} from "./store.ts";
import type { Approval, Artifact, MemoryProposal, Project, Run, Task } from "./types.ts";
import type {
  OciAtomicRunnerPreflightResult,
  OciRunResult,
  OciSandboxHandle,
  OciSandboxProvider,
} from "./oci-sandbox-provider.ts";
import {
  WriterSandboxBoundary,
  type WriterSandboxProvider,
  type WriterSandboxValidatedExport,
  type WriterSandboxWorkloadBinding,
  type WriterSandboxWorkloadResult,
} from "./writer-sandbox-boundary.ts";
import {
  ATOMIC_FIXTURE_BOUNDS,
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  ATOMIC_FIXTURE_IMPLEMENTATION,
  ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
  ATOMIC_FIXTURE_PACKAGE_NAME,
  ATOMIC_FIXTURE_PACKAGE_VERSION,
  ATOMIC_FIXTURE_REQUEST,
  ATOMIC_FIXTURE_TEST_SHA256,
  ATOMIC_FIXTURE_WORKFLOW_VERSION,
} from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";

export { ATOMIC_FIXTURE_WORKFLOW_NAME };

export const ATOMIC_FIXTURE_PROJECT_ID = "atomic-pilot";
export const ATOMIC_FIXTURE_TASK_ID = "task_atomic_fixture_m5";
export const ATOMIC_FIXTURE_RUNTIME_VERSION = "0.9.12";
export const ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS = Object.freeze({
  "io.valkyrie.atomic.version": ATOMIC_FIXTURE_RUNTIME_VERSION,
  "io.valkyrie.git.version": "2.50.1",
  "io.valkyrie.git.source": "https://www.kernel.org/pub/software/scm/git/git-2.50.1.tar.xz",
  "io.valkyrie.git.source.sha256": "7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4",
});
export const ATOMIC_FIXTURE_APPROVAL_ACTION = "accept_atomic_fixture_result";
export const ATOMIC_FIXTURE_APPROVAL_EFFECT =
  "Record the safe mock acceptance receipt in the control-plane ledger and complete this disposable fixture run only. Do not create a PR, access GitHub, merge, deploy, change an external or product database, expand credential access, or promote memory.";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_FILES = 96;
const MAX_PACKAGE_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 3 * 1024 * 1024;
const MAX_NATIVE_RECORDS = 2_048;
const MAX_NATIVE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024;

const ARTIFACTS = Object.freeze([
  { relativePath: ".valkyrie-output/evidence.json", kind: "atomic-pilot-evidence", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/candidate.patch", kind: "candidate-patch", mediaType: "text/x-diff" },
  { relativePath: ".valkyrie-output/checks.json", kind: "deterministic-checks", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/verifier.json", kind: "fresh-deterministic-verifier", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/memory-proposal.json", kind: "memory-proposal-draft", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/draft-pr-mock.json", kind: "draft-pr-mock", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/context-pack.json", kind: "project-brain-context-pack", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/run-contract.json", kind: "run-contract", mediaType: "application/json" },
  { relativePath: ".valkyrie-output/atomic-launch-manifest.json", kind: "atomic-launch-manifest", mediaType: "application/json" },
]);

interface AtomicRpcSandboxProvider extends WriterSandboxProvider {
  preflightAtomicRunner(): Promise<OciAtomicRunnerPreflightResult>;
  openAtomicRpc(handle: OciSandboxHandle): Promise<AtomicRpcClient>;
}

export interface AtomicFixturePilotOptions {
  store: ControlPlaneStore;
  brain: LocalProjectBrain;
  boundary: WriterSandboxBoundary;
  provider: AtomicRpcSandboxProvider;
  packageDir: string;
  repositoryPath: string;
  repositoryCommit: string;
  contextRoot: string;
  maxCostUsd: number;
  now?: () => Date;
  workflowTimeoutMs?: number;
  statusPollMs?: number;
  approvalTtlMs?: number;
}

export interface AtomicFixturePilotPreflight {
  enabled: true;
  available: boolean;
  workflow: typeof ATOMIC_FIXTURE_WORKFLOW_NAME;
  executionMode: "isolated-writer";
  modelExecutionAttempted: false;
  reason?: string;
  provider?: Awaited<ReturnType<WriterSandboxProvider["preflight"]>>;
  runner?: OciAtomicRunnerPreflightResult;
}

interface StagedContext {
  path: string;
  markerPath: string;
  contractSha256?: string;
}

interface AtomicFixtureValidatedArtifact {
  relativePath: string;
  kind: string;
  mediaType: string;
  checksum: string;
  sizeBytes: number;
}

interface AtomicFixtureValidationState {
  artifacts?: readonly Readonly<AtomicFixtureValidatedArtifact>[];
}

interface NativeWaiter<T> {
  predicate: (value: T) => boolean;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function exactJson(value: unknown): string {
  return canonicalJson(value);
}

function assertPrivateDirectory(path: string, label: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other permissions`);
  }
  return realpathSync(path);
}

function ensurePrivateDirectory(path: string, label: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return assertPrivateDirectory(path, label);
}

function writeExclusive(path: string, body: string | Buffer): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeFileSync(descriptor, body);
  } finally {
    closeSync(descriptor);
  }
}

export function copyReviewedAtomicPackage(sourceInput: string, destinationInput: string): { files: number; bytes: number; digest: string } {
  const sourceStat = lstatSync(sourceInput);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Atomic package source must be a regular directory");
  const source = realpathSync(sourceInput);
  const destination = resolve(destinationInput);
  mkdirSync(destination, { mode: 0o700 });
  const digest = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (sourceDirectory: string, destinationDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = join(sourceDirectory, entry.name);
      const sourceInfo = lstatSync(sourcePath);
      if (sourceInfo.isSymbolicLink()) throw new Error("Atomic package staging rejects symbolic links");
      const sourceReal = realpathSync(sourcePath);
      if (!sourceReal.startsWith(`${source}${sep}`)) throw new Error("Atomic package source escaped its reviewed root");
      const destinationPath = join(destinationDirectory, entry.name);
      if (sourceInfo.isDirectory()) {
        mkdirSync(destinationPath, { mode: 0o700 });
        visit(sourceReal, destinationPath);
        continue;
      }
      if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) throw new Error("Atomic package staging accepts only single-link regular files");
      if (++files > MAX_PACKAGE_FILES || sourceInfo.size > MAX_PACKAGE_FILE_BYTES) throw new Error("Atomic package staging exceeded its file bound");
      bytes += sourceInfo.size;
      if (bytes > MAX_PACKAGE_BYTES) throw new Error("Atomic package staging exceeded its byte bound");
      const body = readFileSync(sourceReal);
      const relativePath = relative(source, sourceReal).split(sep).join("/");
      digest.update(relativePath).update("\0").update(String(body.byteLength)).update("\0").update(body);
      writeExclusive(destinationPath, body);
    }
  };
  visit(source, destination);
  return { files, bytes, digest: digest.digest("hex") };
}

export function readContainedWorkspaceFile(handle: OciSandboxHandle, relativePath: string): Buffer {
  const worktree = realpathSync(join(handle.workspacePath, handle.workingDirectoryRelativePath));
  const candidate = resolve(worktree, ...relativePath.split("/"));
  if (candidate === worktree || !candidate.startsWith(`${worktree}${sep}`)) throw new Error("Atomic evidence path escaped the worktree");
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error("Atomic evidence must be a bounded single-link regular file");
  }
  const real = realpathSync(candidate);
  if (!real.startsWith(`${worktree}${sep}`)) throw new Error("Atomic evidence resolved outside the worktree");
  const body = readFileSync(real);
  if (body.byteLength !== stat.size) throw new Error("Atomic evidence changed while it was read");
  return body;
}

function artifactDigest(artifacts: readonly Artifact[]): string {
  return sha(canonicalJson(artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    checksum: artifact.checksum,
    mediaType: artifact.mediaType,
  })).sort((left, right) => left.kind.localeCompare(right.kind)
    || left.uri.localeCompare(right.uri)
    || left.id.localeCompare(right.id))));
}

function safeRunId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error("Atomic fixture run ID is not safe");
  return value;
}

function remainingDeadlineMs(deadlineMs: number, capMs = Number.MAX_SAFE_INTEGER): number {
  const remaining = Math.floor(deadlineMs - Date.now());
  if (remaining < 1) throw new Error("Atomic fixture workflow exceeded its elapsed-time bound");
  return Math.max(1, Math.min(remaining, capMs));
}

class AtomicFixtureShutdownClaimWaitError extends Error {
  constructor() {
    super("Atomic fixture queued-claim wait stopped for control-plane shutdown");
    this.name = "AtomicFixtureShutdownClaimWaitError";
  }
}

class AtomicFixtureArtifactReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicFixtureArtifactReviewError";
  }
}

class AtomicNativeEvidenceCollector {
  private chain: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private index = 0;
  private bytes = 0;
  private readonly lifecycleWaiters: NativeWaiter<AtomicWorkflowLifecycleDetail>[] = [];
  private readonly listWaiters: NativeWaiter<{ workflows: string[] }>[] = [];
  private readonly store: ControlPlaneStore;
  private readonly runId: string;

  constructor(store: ControlPlaneStore, runId: string, client: AtomicRpcClient) {
    this.store = store;
    this.runId = runId;
    client.subscribeRecords((record) => this.consume(record));
    client.on("protocol_error", (issue) => this.fail(errorOf(issue.error)));
    client.on("spawn_error", (error) => this.fail(errorOf(error)));
    client.on("transport_error", (details) => this.fail(errorOf(details.error)));
  }

  nextLifecycle(predicate: (value: AtomicWorkflowLifecycleDetail) => boolean, timeoutMs: number): Promise<AtomicWorkflowLifecycleDetail> {
    return this.wait(this.lifecycleWaiters, predicate, timeoutMs, "Atomic workflow lifecycle event timed out");
  }

  nextList(timeoutMs: number): Promise<{ workflows: string[] }> {
    return this.wait(this.listWaiters, () => true, timeoutMs, "Atomic workflow list event timed out");
  }

  async drain(): Promise<void> {
    await this.chain;
    if (this.failure) throw this.failure;
  }

  close(error = new Error("Atomic native evidence collector closed")): void {
    for (const waiter of [...this.lifecycleWaiters]) this.rejectWaiter(this.lifecycleWaiters, waiter, error);
    for (const waiter of [...this.listWaiters]) this.rejectWaiter(this.listWaiters, waiter, error);
  }

  private wait<T>(waiters: NativeWaiter<T>[], predicate: (value: T) => boolean, timeoutMs: number, message: string): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const waiter = {} as NativeWaiter<T>;
      waiter.predicate = predicate;
      waiter.resolve = resolvePromise;
      waiter.reject = rejectPromise;
      waiter.timer = setTimeout(() => this.rejectWaiter(waiters, waiter, new Error(message)), timeoutMs);
      waiter.timer.unref();
      waiters.push(waiter);
    });
  }

  private consume(record: AtomicRpcResponse | AtomicRpcNativeEvent): void {
    if (this.failure) return;
    const encoded = canonicalJson(record);
    this.index += 1;
    this.bytes += Buffer.byteLength(encoded);
    if (this.index > MAX_NATIVE_RECORDS || this.bytes > MAX_NATIVE_BYTES) {
      this.fail(new Error("Atomic native evidence exceeded its record or byte bound"));
      return;
    }
    const index = this.index;
    this.chain = this.chain.then(async () => {
      await this.store.appendEvent({
        id: `event_atomic_raw_${sha(`${this.runId}\0${index}\0${encoded}`).slice(0, 32)}`,
        runId: this.runId,
        type: "runtime.native",
        message: "Atomic emitted a bounded native JSONL record",
        payload: { runtime: "atomic", nativeRecordIndex: index, rawNative: record },
        createdAt: new Date().toISOString(),
      });
      const lifecycle = parseAtomicWorkflowLifecycleEvent(record);
      if (lifecycle) {
        await this.store.appendEvent({
          id: `event_atomic_normalized_${sha(`${this.runId}\0${index}\0${lifecycle.action}\0${lifecycle.status}`).slice(0, 32)}`,
          runId: this.runId,
          type: `atomic.workflow.${lifecycle.status}`,
          message: `Atomic workflow reported ${lifecycle.status}`,
          payload: {
            nativeRecordIndex: index,
            nativeWorkflowRunId: lifecycle.runId,
            workflow: lifecycle.workflow ?? null,
            action: lifecycle.action,
            status: lifecycle.status,
          },
          createdAt: new Date().toISOString(),
        });
        this.resolveWaiter(this.lifecycleWaiters, lifecycle);
      }
      const list = parseAtomicWorkflowListEvent(record);
      if (list) this.resolveWaiter(this.listWaiters, { workflows: list.workflows });
    }).catch((error) => this.fail(errorOf(error)));
  }

  private resolveWaiter<T>(waiters: NativeWaiter<T>[], value: T): void {
    const waiter = waiters.find((candidate) => candidate.predicate(value));
    if (!waiter) return;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  private rejectWaiter<T>(waiters: NativeWaiter<T>[], waiter: NativeWaiter<T>, error: Error): void {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.close(error);
  }
}

export class AtomicFixturePilotCoordinator {
  private readonly store: ControlPlaneStore;
  private readonly brain: LocalProjectBrain;
  private readonly boundary: WriterSandboxBoundary;
  private readonly provider: AtomicRpcSandboxProvider;
  private readonly packageDir: string;
  private readonly repositoryPath: string;
  private readonly repositoryCommit: string;
  private readonly contextRoot: string;
  private readonly maxCostUsd: number;
  private readonly clock: () => Date;
  private readonly workflowTimeoutMs: number;
  private readonly statusPollMs: number;
  private readonly approvalTtlMs: number;
  private readonly workerId = `atomic_fixture_${sha(id("worker")).slice(0, 24)}`;
  private readonly active = new Map<string, { operation: Promise<void>; abort: AbortController }>();
  private readonly failures = new Map<string, Error>();
  private shuttingDown = false;

  constructor(options: AtomicFixturePilotOptions) {
    this.store = options.store;
    this.brain = options.brain;
    this.boundary = options.boundary;
    this.provider = options.provider;
    this.packageDir = resolve(options.packageDir);
    this.repositoryPath = resolve(options.repositoryPath);
    this.repositoryCommit = options.repositoryCommit;
    this.contextRoot = resolve(options.contextRoot);
    this.maxCostUsd = options.maxCostUsd;
    this.clock = options.now ?? (() => new Date());
    const maximumWorkflowTimeoutMs = ATOMIC_FIXTURE_BOUNDS.max_elapsed_seconds * 1_000;
    this.workflowTimeoutMs = options.workflowTimeoutMs ?? maximumWorkflowTimeoutMs;
    this.statusPollMs = options.statusPollMs ?? 250;
    this.approvalTtlMs = options.approvalTtlMs ?? 15 * 60 * 1_000;
    if (!isAbsolute(options.packageDir) || !isAbsolute(options.repositoryPath) || !isAbsolute(options.contextRoot)) {
      throw new Error("Atomic fixture pilot paths must be absolute");
    }
    if (!/^[a-f0-9]{40,64}$/.test(this.repositoryCommit)) {
      throw new Error("Atomic fixture pilot requires the exact reviewed repository commit");
    }
    if (!Number.isFinite(this.maxCostUsd) || this.maxCostUsd <= 0 || this.maxCostUsd > 5) {
      throw new Error("Atomic fixture pilot budget cap must be greater than zero and at most $5");
    }
    if (!Number.isSafeInteger(this.workflowTimeoutMs)
      || this.workflowTimeoutMs < 1_000
      || this.workflowTimeoutMs > maximumWorkflowTimeoutMs) {
      throw new Error(`Atomic fixture workflow timeout must be between 1000 and ${maximumWorkflowTimeoutMs} milliseconds`);
    }
    if (this.statusPollMs < 10 || this.statusPollMs > 5_000) throw new Error("Atomic fixture status poll interval is invalid");
    if (this.approvalTtlMs < 60_000 || this.approvalTtlMs > 24 * 60 * 60 * 1_000) throw new Error("Atomic fixture approval TTL is invalid");
  }

  isPilotRun(run: Run): boolean {
    return run.rootRuntime === "atomic" && run.workflow === ATOMIC_FIXTURE_WORKFLOW_NAME;
  }

  validateStart(input: { projectId: string; taskId?: string; objective: string; runtime?: string; workflow?: string; maxCostUsd?: number }): number {
    if (input.projectId !== ATOMIC_FIXTURE_PROJECT_ID || input.taskId !== ATOMIC_FIXTURE_TASK_ID) {
      throw new Error("Atomic fixture pilot requires the fixed disposable project and task");
    }
    if (input.runtime !== "atomic" || input.workflow !== ATOMIC_FIXTURE_WORKFLOW_NAME) {
      throw new Error("Atomic fixture pilot requires runtime=atomic and workflow=atomic-fixture-pilot");
    }
    if (input.objective !== ATOMIC_FIXTURE_REQUEST) throw new Error("Atomic fixture pilot objective must match the reviewed literal contract");
    const budgetUsd = input.maxCostUsd ?? this.maxCostUsd;
    if (budgetUsd > this.maxCostUsd) throw new Error("Atomic fixture pilot budget exceeds the configured cap");
    return budgetUsd;
  }

  async bootstrap(): Promise<{ project: Project; task: Task }> {
    const preflight = await this.preflight();
    if (!preflight.available) {
      throw new Error(`Atomic fixture bootstrap requires a verified runner: ${preflight.reason ?? "runner preflight failed"}`);
    }
    const createdAt = this.clock().toISOString();
    const expectedProject: Project = {
      id: ATOMIC_FIXTURE_PROJECT_ID,
      name: "Atomic Pilot",
      objective: "Prove one governed Atomic fixture lifecycle without production access",
      currentMilestone: "M5",
      health: "exploring",
      linearTeam: "FIX",
      repository: "disposable/atomic-pilot-fixture",
      vaultPath: "Projects/Atomic Pilot",
      memoryNamespace: "projects/atomic-pilot",
      createdAt,
    };
    await this.store.seedProjects([{ ...expectedProject }]);
    const project = await this.store.getProject(expectedProject.id);
    if (!project || canonicalJson({ ...project, createdAt: null }) !== canonicalJson({ ...expectedProject, createdAt: null })) {
      throw new Error("Atomic fixture project seed conflicts with the reviewed contract");
    }
    const expectedTask: Task = {
      id: ATOMIC_FIXTURE_TASK_ID,
      projectId: project.id,
      source: "isolated-fake-linear-gateway",
      sourceId: "FIX-M5-1",
      title: "Implement normalizeProjectSlug in disposable Atomic fixture",
      objective: ATOMIC_FIXTURE_REQUEST,
      status: "planned",
      priority: "normal",
      createdAt,
    };
    let task = await this.store.getTask(expectedTask.id);
    if (!task) {
      await this.store.createTask(expectedTask);
      task = expectedTask;
    }
    if (canonicalJson({ ...task, createdAt: null }) !== canonicalJson({ ...expectedTask, createdAt: null })) {
      throw new Error("Atomic fixture task seed conflicts with the reviewed contract");
    }
    return { project, task };
  }

  async preflight(): Promise<AtomicFixturePilotPreflight> {
    try {
      const packageStat = lstatSync(this.packageDir);
      if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error("reviewed Atomic package is unavailable");
      const workflowPath = join(this.packageDir, "workflows", "atomic-fixture-pilot.ts");
      const workflowStat = lstatSync(workflowPath);
      if (!workflowStat.isFile() || workflowStat.isSymbolicLink() || workflowStat.nlink !== 1) throw new Error("reviewed Atomic fixture workflow is unavailable");
      const runner = await this.provider.preflightAtomicRunner();
      const provider = runner.provider;
      if (!runner.enabled || !runner.available) {
        return {
          enabled: true,
          available: false,
          workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
          executionMode: "isolated-writer",
          modelExecutionAttempted: false,
          provider,
          runner,
          reason: `isolated Atomic runner unavailable: ${runner.reason ?? provider.reason ?? "preflight failed"}`,
        };
      }
      if (runner.atomicVersion !== ATOMIC_FIXTURE_RUNTIME_VERSION
          || !runner.imageDigest || !runner.provenanceDigest || !runner.provenanceLabels) {
        throw new Error("isolated Atomic runner preflight returned incomplete version/provenance evidence");
      }
      return {
        enabled: true,
        available: true,
        workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
        executionMode: "isolated-writer",
        modelExecutionAttempted: false,
        provider,
        runner,
        reason: `Verified Atomic ${runner.atomicVersion} in exact offline OCI image ${runner.imageRef} (${runner.imageDigest}; provenance sha256:${runner.provenanceDigest}); no model, product repository, or external final action`,
      };
    } catch (error) {
      return {
        enabled: true,
        available: false,
        workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
        executionMode: "isolated-writer",
        modelExecutionAttempted: false,
        reason: errorOf(error).message,
      };
    }
  }

  schedule(runId: string): void {
    safeRunId(runId);
    if (this.shuttingDown) return;
    if (this.active.has(runId)) return;
    const abort = new AbortController();
    this.failures.delete(runId);
    const operation = this.runQueued(runId, abort.signal)
      .catch(async (error) => {
        const failure = errorOf(error);
        if (this.shuttingDown && failure instanceof AtomicFixtureShutdownClaimWaitError) return;
        this.failures.set(runId, failure);
        try {
          await this.recordFailure(runId, failure);
        } catch (recordError) {
          this.failures.set(runId, new AggregateError([failure, recordError], "Atomic fixture failure persistence was incomplete"));
        }
      })
      .finally(async () => {
        try {
          await this.store.releaseRunClaim(runId, this.workerId);
        } catch (error) {
          const releaseFailure = errorOf(error);
          const existing = this.failures.get(runId);
          this.failures.set(
            runId,
            existing
              ? new AggregateError([existing, releaseFailure], "Atomic fixture run and queued-claim release both failed")
              : releaseFailure,
          );
        } finally {
          this.active.delete(runId);
        }
      });
    this.active.set(runId, { operation, abort });
  }

  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.operation;
    const failure = this.failures.get(runId);
    if (failure) throw failure;
  }

  async cancel(run: Run): Promise<void> {
    if (!this.isPilotRun(run)) throw new Error("Run is not an Atomic fixture pilot");
    const active = this.active.get(run.id);
    active?.abort.abort(new Error("Atomic fixture pilot cancelled by an authorized control-plane client"));
    if (active) await active.operation;
    const current = await this.store.getRun(run.id);
    if (current?.status === "awaiting_approval") {
      const pending = (await this.store.listApprovals("pending")).filter((approval) =>
        approval.runId === run.id && approval.action === ATOMIC_FIXTURE_APPROVAL_ACTION);
      if (pending.length !== 1) {
        throw new Error("Atomic fixture cancellation requires exactly one pending bound approval");
      }
      const binding = approvalBindingOf(pending[0]);
      if (!binding) throw new Error("Atomic fixture cancellation approval lost its evidence binding");
      const at = this.clock().toISOString();
      await this.store.resolveApprovalTransaction({
        approvalId: pending[0].id,
        state: "denied",
        decision: "cancelled",
        resolvedBy: "authenticated-control-plane-client",
        resolvedAt: at,
        expectedBinding: binding,
        runPatch: {
          status: "cancelled",
          stage: "cancelled",
          completedAt: at,
          nextActionAt: null,
          metadata: {
            ...current.metadata,
            cancelledBy: "authenticated-control-plane-client",
            approvalDecision: "cancelled",
            safeMockAcceptanceReceipt: false,
            externalActionPerformed: false,
            memoryPromoted: false,
          },
        },
        event: {
          id: `event_atomic_cancel_${sha(run.id).slice(0, 32)}`,
          runId: run.id,
          type: "run.cancelled",
          message: "Atomic fixture pilot and its bound approval were cancelled after bounded sandbox cleanup",
          payload: {
            approvalId: pending[0].id,
            evidenceDigest: binding.evidenceDigest,
            policyHash: binding.policyHash,
            externalActionPerformed: false,
            memoryPromoted: false,
          },
          createdAt: at,
        },
      });
      return;
    }
    let cancellationCleanupProven = current?.status !== "failed";
    if (current?.status === "failed") {
      const instance = await this.store.getSandboxInstance(run.id);
      const workspace = await this.store.getWorkspaceForRun(run.id);
      const lease = workspace ? await this.store.getWorkspaceLease(workspace.id) : null;
      cancellationCleanupProven = current.metadata.containerCleanupProven === true
        && current.metadata.writerWorkspaceRemoved === true
        && Boolean(instance)
        && Boolean(workspace)
        && !lease
        && !existsSync(workspace!.path);
    }
    if (current && !["completed", "cancelled"].includes(current.status) && cancellationCleanupProven) {
      const at = this.clock().toISOString();
      await this.store.updateRun(run.id, {
        status: "cancelled",
        stage: "cancelled",
        completedAt: at,
        nextActionAt: null,
        metadata: {
          ...current.metadata,
          cancelledBy: "authenticated-control-plane-client",
          externalActionPerformed: false,
        },
      });
      await this.store.appendEvent({
        id: `event_atomic_cancel_${sha(run.id).slice(0, 32)}`,
        runId: run.id,
        type: "run.cancelled",
        message: "Atomic fixture pilot was cancelled after bounded sandbox cleanup",
        payload: { externalActionPerformed: false },
        createdAt: at,
      });
    }
  }

  async resolveApproval(approval: Approval, decision: "approve" | "deny" | "request_changes", resolvedBy: string): Promise<void> {
    const currentApproval = await this.store.getApproval(approval.id);
    if (!currentApproval) throw new Error("Atomic fixture approval was not found");
    if (canonicalJson({
      id: approval.id,
      runId: approval.runId,
      action: approval.action,
      exactEffect: approval.exactEffect,
      projectId: approval.projectId ?? null,
      workflow: approval.workflow ?? null,
      evidenceDigest: approval.evidenceDigest ?? null,
      policyHash: approval.policyHash ?? null,
      expiresAt: approval.expiresAt ?? null,
    }) !== canonicalJson({
      id: currentApproval.id,
      runId: currentApproval.runId,
      action: currentApproval.action,
      exactEffect: currentApproval.exactEffect,
      projectId: currentApproval.projectId ?? null,
      workflow: currentApproval.workflow ?? null,
      evidenceDigest: currentApproval.evidenceDigest ?? null,
      policyHash: currentApproval.policyHash ?? null,
      expiresAt: currentApproval.expiresAt ?? null,
    })) {
      throw new Error("Atomic fixture approval binding does not match authoritative storage");
    }
    if (currentApproval.action !== ATOMIC_FIXTURE_APPROVAL_ACTION
      || currentApproval.exactEffect !== ATOMIC_FIXTURE_APPROVAL_EFFECT) {
      throw new Error("Approval is not the exact Atomic fixture final gate");
    }
    const run = await this.store.getRun(currentApproval.runId);
    if (!run || !this.isPilotRun(run)) throw new Error("Atomic fixture approval does not own a pilot run");
    const binding = approvalBindingOf(currentApproval);
    if (!binding) throw new Error("Atomic fixture approval is missing its evidence binding");
    if (currentApproval.state === "pending") {
      await this.validatePendingApproval(run, currentApproval);
    }
    const resolvedAt = this.clock().toISOString();
    const approved = decision === "approve";
    const state = approved ? "approved" : decision === "request_changes" ? "changes_requested" : "denied";
    await this.store.resolveApprovalTransaction({
      approvalId: currentApproval.id,
      state,
      decision,
      resolvedBy,
      resolvedAt,
      expectedBinding: binding,
      runPatch: {
        status: approved ? "completed" : "failed",
        stage: approved ? "accepted_mock_final_action" : decision === "request_changes" ? "changes_requested" : "approval_denied",
        completedAt: resolvedAt,
        nextActionAt: null,
        metadata: {
          ...run.metadata,
          approvalDecision: decision,
          safeMockAcceptanceReceipt: approved,
          externalActionPerformed: false,
          memoryPromoted: false,
        },
      },
      event: {
        id: `event_atomic_approval_${sha(`${currentApproval.id}\0${decision}`).slice(0, 32)}`,
        runId: run.id,
        type: approved ? "atomic.fixture.accepted" : "atomic.fixture.rejected",
        message: approved
          ? "Authorized approval client accepted the fixture evidence; the control plane recorded a safe mock receipt only"
          : "Authorized approval client did not accept the fixture evidence; no external action was performed",
        payload: {
          approvalId: currentApproval.id,
          decision,
          resolvedBy,
          evidenceDigest: binding.evidenceDigest,
          policyHash: binding.policyHash,
          externalActionPerformed: false,
          memoryPromoted: false,
        },
        createdAt: resolvedAt,
      },
    });
  }

  /**
   * Bounded human-review surface for the exact pending pilot gate. It returns
   * approval-bound UTF-8 content and never exposes the artifact-root path.
   */
  async readApprovalArtifact(runId: string, artifactId: string) {
    safeRunId(runId);
    if (!SAFE_ID.test(artifactId)) {
      throw new Error("Atomic fixture artifact ID is invalid");
    }
    try {
      const run = await this.store.getRun(runId);
      if (!run || !this.isPilotRun(run)) {
        throw new AtomicFixtureArtifactReviewError("Run is not an Atomic fixture pilot");
      }
      const pending = (await this.store.listApprovals("pending")).filter((approval) =>
        approval.runId === run.id && approval.action === ATOMIC_FIXTURE_APPROVAL_ACTION);
      if (pending.length !== 1) {
        throw new AtomicFixtureArtifactReviewError(
          "Atomic fixture artifact review requires exactly one pending final gate",
        );
      }
      const validated = await this.validatePendingApproval(run, pending[0]);
      const artifact = validated.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) {
        throw new AtomicFixtureArtifactReviewError(
          "Artifact is not part of the approval-bound Atomic fixture evidence",
        );
      }
      const snapshot = validated.snapshot.find((candidate) => candidate.kind === artifact.kind);
      if (!snapshot || snapshot.mediaType !== artifact.mediaType || snapshot.checksum !== artifact.checksum) {
        throw new AtomicFixtureArtifactReviewError("Artifact no longer matches the frozen approval snapshot");
      }
      const read = this.boundary.readGovernedArtifact(run.id, snapshot);
      return {
        runId: run.id,
        approvalId: pending[0].id,
        artifactId: artifact.id,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        checksum: artifact.checksum,
        sizeBytes: read.sizeBytes,
        evidenceDigest: pending[0].evidenceDigest,
        content: read.content,
      };
    } catch (error) {
      if (error instanceof AtomicFixtureArtifactReviewError) throw error;
      // Storage and filesystem exceptions can contain absolute local paths.
      // This method is the HTTP/MCP trust boundary, so retain no cause.
      throw new AtomicFixtureArtifactReviewError(
        "Atomic fixture artifact evidence is unavailable or no longer matches the pending approval",
      );
    }
  }

  /**
   * Re-open and revalidate a completed pilot's governed bytes before a later,
   * separately approved external action is even planned.
   */
  async validateExternalActionEvidence(runId: string) {
    const run = await this.store.getRun(runId);
    if (!run || !this.isPilotRun(run) || run.status !== "completed") {
      throw new Error("Atomic fixture external action requires a completed pilot run");
    }
    const approvals = (await this.store.listApprovals())
      .filter((item) => item.runId === run.id && item.action === ATOMIC_FIXTURE_APPROVAL_ACTION && item.state === "approved");
    if (approvals.length !== 1) throw new Error("Atomic fixture external action requires one accepted evidence gate");
    const binding = approvalBindingOf(approvals[0]!);
    if (!binding || binding.projectId !== run.projectId || binding.workflow !== ATOMIC_FIXTURE_WORKFLOW_NAME) {
      throw new Error("Atomic fixture accepted evidence binding is incomplete");
    }
    const validated = await this.validateEvidenceSnapshot(run);
    const evidenceDigest = artifactDigest(validated.artifacts);
    if (binding.evidenceDigest !== evidenceDigest || binding.policyHash !== validated.instance.policyHash) {
      throw new Error("Atomic fixture accepted evidence changed before external-action planning");
    }
    return {
      runId: run.id,
      projectId: run.projectId,
      workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
      evidenceDigest,
      policyHash: validated.instance.policyHash,
      artifacts: validated.artifacts,
    };
  }

  async reconcileStartup(): Promise<{ sandbox: Awaited<ReturnType<WriterSandboxBoundary["reconcileStartup"]>>; queuedScheduled: number; approvalsRecovered: number; expiredApprovals: number }> {
    const sandbox = await this.boundary.reconcileStartup();
    const observedAt = this.clock().toISOString();
    const [candidates, cleanedInstances, pendingApprovals] = await Promise.all([
      this.store.listReconciliationCandidates(observedAt),
      this.store.listSandboxInstances(["cleaned"]),
      this.store.listApprovals("pending"),
    ]);
    const cleanedByRun = new Map(cleanedInstances.map((instance) => [instance.runId, instance]));
    let queuedScheduled = 0;
    let approvalsRecovered = 0;

    for (const candidate of candidates.queuedRuns) {
      if (!this.isPilotRun(candidate)) continue;
      const [run, workspace, instance] = await Promise.all([
        this.store.getRun(candidate.id),
        this.store.getWorkspaceForRun(candidate.id),
        this.store.getSandboxInstance(candidate.id),
      ]);
      if (!run || run.status !== "queued" || !this.isPilotRun(run)) continue;
      if (workspace || instance) {
        await this.failQueuedOwnedState(run, workspace, instance);
        continue;
      }
      this.schedule(run.id);
      queuedScheduled += 1;
    }

    for (const instance of cleanedByRun.values()) {
      const run = await this.store.getRun(instance.runId);
      if (!run || !this.isPilotRun(run)) continue;
      if (run.status === "awaiting_approval") {
        const approvals = pendingApprovals.filter((approval) => approval.runId === run.id);
        if (approvals.length !== 1) {
          throw new Error("Atomic fixture awaiting-approval restart requires exactly one pending bound approval");
        }
        await this.validatePendingApproval(run, approvals[0]);
        this.removeExistingStagedContext(run.id);
        continue;
      }
      if (run.status !== "running") {
        this.removeExistingStagedContext(run.id);
        continue;
      }
      const { artifacts } = await this.validateEvidenceSnapshot(run);
      this.removeExistingStagedContext(run.id);
      if (run.stage !== "evidence_ready") {
        await this.store.updateRun(run.id, {
          status: "running",
          stage: "evidence_ready",
          completedAt: null,
          nextActionAt: null,
          metadata: {
            ...run.metadata,
            sandboxEvidenceReady: true,
            artifactCount: artifacts.length,
            containerCleaned: true,
            writerWorkspaceRemoved: true,
            writerLeaseReleased: true,
            atomicFixtureCleanedRecovery: true,
          },
        });
      }
      await this.ensureEvidenceApproval(await this.requireRun(run.id), { artifacts });
      approvalsRecovered += 1;
    }

    const expiredApprovals = await this.expireApprovals();
    return { sandbox, queuedScheduled, approvalsRecovered, expiredApprovals };
  }

  async tick(): Promise<{ expiredApprovals: number }> {
    return { expiredApprovals: await this.expireApprovals() };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.active.values()];
    for (const item of active) item.abort.abort(new Error("Control plane is shutting down"));
    await Promise.allSettled(active.map((item) => item.operation));
  }

  private async runQueued(runId: string, signal: AbortSignal): Promise<void> {
    let backoffMs = 100;
    let run: Run | null = null;
    while (!run) {
      if (signal.aborted) {
        if (this.shuttingDown) throw new AtomicFixtureShutdownClaimWaitError();
        throw errorOf(signal.reason ?? new Error("Atomic fixture queued-claim wait was aborted"));
      }
      const claimUntil = new Date(this.clock().getTime() + Math.max(this.workflowTimeoutMs + 60_000, 5 * 60_000)).toISOString();
      run = await this.store.claimQueuedRunForStart(runId, this.workerId, claimUntil);
      if (run) break;
      const observed = await this.store.getRun(runId);
      if (!observed || observed.status !== "queued") return;
      if (!this.isPilotRun(observed)) throw new Error("Queued claim wait observed a non-pilot run");
      try {
        await delay(backoffMs, undefined, { signal });
      } catch (error) {
        if (signal.aborted && this.shuttingDown) throw new AtomicFixtureShutdownClaimWaitError();
        throw errorOf(signal.reason ?? error);
      }
      backoffMs = Math.min(backoffMs * 2, 1_000);
    }
    if (!this.isPilotRun(run)) throw new Error("Queued claim did not return an Atomic fixture pilot");
    if (signal.aborted) throw errorOf(signal.reason ?? new Error("Atomic fixture pilot was aborted after claiming its run"));
    await this.removeStaleUnownedContext(run.id);
    const [project, task] = await Promise.all([this.store.getProject(run.projectId), run.taskId ? this.store.getTask(run.taskId) : null]);
    if (!project || !task || task.id !== ATOMIC_FIXTURE_TASK_ID) throw new Error("Atomic fixture run lost its fixed project/task contract");
    const staged = this.createStagedContext(run.id);
    const validationState: AtomicFixtureValidationState = {};
    let result: WriterSandboxWorkloadResult | undefined;
    let boundaryCompleted = false;
    try {
      result = await this.boundary.runWorkload({
        allowedWorkflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
        run,
        project,
        repositoryPath: this.repositoryPath,
        baseRef: this.repositoryCommit,
        contextPath: staged.path,
        artifacts: ARTIFACTS,
        completion: "evidence_ready",
        prepareContext: (binding) => this.prepareContext(staged, binding, project, task, run),
        execute: (handle, binding) => this.executeAtomic(handle, binding, run, staged, validationState, signal),
        validateExports: (exports) => this.validateFrozenExports(run.id, validationState, exports),
      });
      boundaryCompleted = true;
      const instance = await this.store.getSandboxInstance(run.id);
      if (!instance || instance.state !== "cleaned") throw new Error("Atomic fixture boundary returned before durable sandbox cleanup");
      this.removeStagedContext(staged, run.id);
      await this.ensureEvidenceApproval(await this.requireRun(result.runId), result);
    } catch (error) {
      if (!boundaryCompleted) {
        const instance = await this.store.getSandboxInstance(run.id).catch(() => null);
        if ((!instance || instance.state === "cleaned") && existsSync(staged.path)) {
          try {
            this.removeStagedContext(staged, run.id);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Atomic fixture workload and staged-context cleanup both failed");
          }
        }
      }
      throw error;
    }
  }

  private createStagedContext(runId: string): StagedContext {
    const root = ensurePrivateDirectory(this.contextRoot, "Atomic fixture context root");
    const path = join(root, safeRunId(runId));
    mkdirSync(path, { mode: 0o700 });
    const real = assertPrivateDirectory(path, "Atomic fixture run context");
    const markerPath = join(real, ".valkyrie-context.json");
    writeExclusive(markerPath, exactJson({ schemaVersion: 1, runId }));
    return { path: real, markerPath };
  }

  private removeStagedContext(staged: StagedContext, runId: string): void {
    if (!existsSync(staged.path)) return;
    const root = assertPrivateDirectory(this.contextRoot, "Atomic fixture context root");
    const real = realpathSync(staged.path);
    if (dirname(real) !== root || basename(real) !== runId) throw new Error("Atomic fixture context cleanup escaped its run root");
    const marker = plainObject(JSON.parse(readFileSync(staged.markerPath, "utf8")), "Atomic fixture context marker");
    if (marker.schemaVersion !== 1 || marker.runId !== runId) throw new Error("Atomic fixture context marker does not match cleanup target");
    rmSync(real, { recursive: true });
  }

  private removeExistingStagedContext(runId: string): void {
    const path = join(this.contextRoot, safeRunId(runId));
    if (!existsSync(path)) return;
    this.removeStagedContext({ path, markerPath: join(path, ".valkyrie-context.json") }, runId);
  }

  private async removeStaleUnownedContext(runId: string): Promise<void> {
    const path = join(this.contextRoot, safeRunId(runId));
    if (!existsSync(path)) return;
    const [workspace, instance] = await Promise.all([
      this.store.getWorkspaceForRun(runId),
      this.store.getSandboxInstance(runId),
    ]);
    if (workspace || instance) {
      throw new Error("Atomic fixture stale context still has durable workspace or sandbox ownership");
    }
    this.removeStagedContext({ path, markerPath: join(path, ".valkyrie-context.json") }, runId);
  }

  private async prepareContext(staged: StagedContext, binding: Readonly<WriterSandboxWorkloadBinding>, project: Project, task: Task, run: Run): Promise<void> {
    if (binding.runId !== run.id || binding.projectId !== project.id || binding.workflow !== ATOMIC_FIXTURE_WORKFLOW_NAME) {
      throw new Error("Atomic fixture context binding changed before launch");
    }
    if (binding.baseCommit !== this.repositoryCommit) {
      throw new Error("Atomic fixture writer did not use the exact reviewed repository commit");
    }
    const packageCopy = copyReviewedAtomicPackage(this.packageDir, join(staged.path, "atomic-package"));
    const pack = this.brain.buildContextPack(project, ATOMIC_FIXTURE_REQUEST, { runId: run.id, taskId: task.id });
    const packBody = canonicalJson(pack);
    const packChecksum = contextPackChecksum(pack);
    if (sha(packBody) !== packChecksum) throw new Error("Project Brain context checksum is not canonical");
    writeExclusive(join(staged.path, "context-pack.json"), packBody);

    const lease = await this.store.getWorkspaceLease(binding.workspaceId);
    if (!lease || lease.runId !== run.id || lease.ownerId !== binding.leaseOwnerId || lease.fencingToken !== binding.fencingToken || lease.state !== "active") {
      throw new Error("Atomic fixture writer lease changed during context preparation");
    }
    const runnerLabels = plainObject(run.metadata.atomicRunnerProvenanceLabels, "Atomic runner provenance labels");
    const expectedImageDigest = binding.sandboxContract.imageRef.slice(binding.sandboxContract.imageRef.lastIndexOf("@") + 1);
    if (run.metadata.atomicVersion !== ATOMIC_FIXTURE_RUNTIME_VERSION
        || run.metadata.atomicRunnerImageRef !== binding.sandboxContract.imageRef
        || run.metadata.atomicRunnerImageDigest !== expectedImageDigest
        || run.metadata.atomicRunnerProvenanceDigest !== sha(exactJson(ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS))
        || exactJson(runnerLabels) !== exactJson(ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS)
        || run.metadata.atomicRunnerPreflightNetwork !== "none") {
      throw new Error("Atomic fixture run lost its exact preflighted runner evidence");
    }
    const contract = {
      schemaVersion: "1.0.0",
      runId: run.id,
      projectId: project.id,
      taskId: task.id,
      request: ATOMIC_FIXTURE_REQUEST,
      rootRuntime: "atomic",
      workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
      finalAction: "stop_before_external_action",
      automaticEpisodicCapture: false,
      contextPack: { ref: "/run-context/context-pack.json", checksum: packChecksum },
      atomicPackage: {
        name: ATOMIC_FIXTURE_PACKAGE_NAME,
        version: ATOMIC_FIXTURE_PACKAGE_VERSION,
        workflowSha256: sha(readFileSync(join(staged.path, "atomic-package", "workflows", "atomic-fixture-pilot.ts"))),
        coreSha256: sha(readFileSync(join(staged.path, "atomic-package", "lib", "atomic-fixture-pilot-core.mjs"))),
        packageJsonSha256: sha(readFileSync(join(staged.path, "atomic-package", "package.json"))),
      },
      source: { kind: "isolated-fake-linear-gateway", id: task.sourceId, expectedBeforeSha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256 },
      budget: { currency: "USD", maxCostUsd: run.budgetUsd },
      bounds: ATOMIC_FIXTURE_BOUNDS,
      workspace: {
        owner: "control-plane",
        workspaceId: binding.workspaceId,
        leaseOwnerId: binding.leaseOwnerId,
        fencingToken: binding.fencingToken,
        provider: binding.workspaceProvider,
        baseCommit: binding.baseCommit,
        branchName: binding.branchName,
      },
      sandbox: {
        provider: binding.sandboxContract.provider,
        imageRef: binding.sandboxContract.imageRef,
        imageDigest: expectedImageDigest,
        atomicVersion: ATOMIC_FIXTURE_RUNTIME_VERSION,
        provenanceDigest: run.metadata.atomicRunnerProvenanceDigest,
        provenanceLabels: runnerLabels,
        policyHash: binding.sandboxContract.policyHash,
        network: "none",
      },
      approvals: { finalAcceptance: "human", memoryPromotion: "separate-human-action" },
    };
    const contractBody = canonicalJson(contract);
    staged.contractSha256 = sha(contractBody);
    writeExclusive(join(staged.path, "run-contract.json"), contractBody);

    const workflowSource = readFileSync(join(staged.path, "atomic-package", "workflows", "atomic-fixture-pilot.ts"));
    const manifest = {
      schema_version: "1.1.0",
      run_id: run.id,
      project_id: project.id,
      task_id: task.id,
      request: ATOMIC_FIXTURE_REQUEST,
      request_class: "feature",
      intent: "implement",
      root_runtime: "atomic",
      context_pack_ref: "/run-context/context-pack.json",
      contract_ref: "/run-context/run-contract.json",
      workflow: {
        name: ATOMIC_FIXTURE_WORKFLOW_NAME,
        path: "/run-context/atomic-package/workflows/atomic-fixture-pilot.ts",
        version: ATOMIC_FIXTURE_WORKFLOW_VERSION,
        content_hash: `sha256:${sha(workflowSource)}`,
        trust_state: "package-reviewed",
      },
      workspace_owner: "control-plane",
      workspace_id: binding.workspaceId,
      workspace_ref: `workspace://${binding.workspaceId}`,
      writer_lease: {
        lease_id: `lease_${sha(`${binding.workspaceId}\0${binding.leaseOwnerId}\0${binding.fencingToken}`).slice(0, 32)}`,
        holder_run_id: run.id,
        workspace_id: binding.workspaceId,
        owner_id: binding.leaseOwnerId,
        fencing_token: binding.fencingToken,
        mode: "exclusive-writer",
        expires_at: lease.expiresAt,
      },
      sandbox_policy_id: `policy_${binding.sandboxContract.policyHash}`,
      durability_required: false,
      crossProcessResume: false,
      final_action: "stop_before_pr",
      budget: { currency: "USD", max_cost_usd: run.budgetUsd },
      bounds: {
        max_duration_minutes: Math.ceil(ATOMIC_FIXTURE_BOUNDS.max_elapsed_seconds / 60),
        max_turns: 1,
        max_repairs: 0,
        max_child_depth: 0,
        max_concurrency: 1,
      },
      model_policy: { planner: "none:tool-only", worker: "none:tool-only", reviewers: ["fresh-deterministic-process"], fallbacks: [] },
      approvals: [{ action: ATOMIC_FIXTURE_APPROVAL_ACTION, exact_effect: ATOMIC_FIXTURE_APPROVAL_EFFECT, required: true }],
      idempotency_key: `atomic-fixture:${run.id}`,
      correlation_id: run.id,
    };
    const validation = validateAtomicLaunchManifest(manifest, staged.path + "/atomic-package");
    if (validation.length > 0) throw new Error(`Atomic fixture launch manifest is invalid: ${validation.join("; ")}`);
    const manifestBody = canonicalJson(manifest);
    writeExclusive(join(staged.path, "atomic-launch-manifest.json"), manifestBody);
    const current = await this.requireRun(run.id);
    await this.store.updateRun(run.id, {
      metadata: {
        ...current.metadata,
        atomicFixtureContractSha256: staged.contractSha256,
        atomicFixtureContextPackSha256: packChecksum,
        atomicFixturePackageDigest: packageCopy.digest,
        atomicFixturePackageFiles: packageCopy.files,
        atomicFixturePackageBytes: packageCopy.bytes,
        atomicFixtureLaunchManifestSha256: sha(manifestBody),
        atomicFixtureExpectedBeforeSha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
        atomicFixtureModelExecutionAttempted: false,
        crossProcessResume: false,
      },
    });
  }

  private async executeAtomic(
    handle: OciSandboxHandle,
    binding: Readonly<WriterSandboxWorkloadBinding>,
    run: Run,
    staged: StagedContext,
    validationState: AtomicFixtureValidationState,
    signal: AbortSignal,
  ): Promise<OciRunResult> {
    if (!staged.contractSha256 || !SHA256.test(staged.contractSha256)) throw new Error("Atomic fixture contract was not staged");
    const deadline = Date.now() + this.workflowTimeoutMs;
    const client = await this.provider.openAtomicRpc(handle);
    const collector = new AtomicNativeEvidenceCollector(this.store, run.id, client);
    try {
      const state = await client.getState<Record<string, unknown>>({
        signal,
        timeoutMs: remainingDeadlineMs(deadline),
      });
      const stateData = plainObject(state.data, "Atomic get_state response");
      const nativeSessionId = stateData.sessionId;
      if (typeof nativeSessionId !== "string" || !nativeSessionId) throw new Error("Atomic did not expose its native main session ID");
      const commands = await client.getCommands<Record<string, unknown>>({
        signal,
        timeoutMs: remainingDeadlineMs(deadline),
      });
      if (!JSON.stringify(commands.data).includes("workflow") || !JSON.stringify(commands.data).includes("atomic-routing")) {
        throw new Error("Atomic package commands were not discovered inside the isolated writer");
      }
      const listTimeoutMs = remainingDeadlineMs(deadline, 10_000);
      const listPromise = collector.nextList(listTimeoutMs);
      const [listed] = await Promise.all([
        listPromise,
        client.prompt("/workflow list", { signal, timeoutMs: listTimeoutMs }),
      ]);
      if (!listed.workflows.includes(ATOMIC_FIXTURE_WORKFLOW_NAME)) throw new Error("Atomic fixture workflow was not discovered in the isolated writer");

      const dispatch = buildAtomicFixtureWorkflowDispatchCommand({
        control_plane_run_id: run.id,
        contract_sha256: staged.contractSha256,
        expected_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
      });
      const dispatchTimeoutMs = remainingDeadlineMs(deadline, 15_000);
      const admittedPromise = collector.nextLifecycle((event) =>
        event.action === "run" && event.workflow === ATOMIC_FIXTURE_WORKFLOW_NAME, dispatchTimeoutMs);
      const [admitted] = await Promise.all([
        admittedPromise,
        client.prompt(dispatch, { signal, timeoutMs: dispatchTimeoutMs }),
      ]);
      if (admitted.status !== "running" && admitted.status !== "pending") throw new Error(`Atomic fixture dispatch was not admitted: ${admitted.status}`);
      const current = await this.requireRun(run.id);
      await this.store.updateRun(run.id, {
        nativeRunId: admitted.runId,
        stage: "atomic_workflow_running",
        metadata: {
          ...current.metadata,
          nativeSessionId,
          nativeWorkflowRunId: admitted.runId,
          atomicFixtureModelExecutionAttempted: false,
          writerLeaseOwnerId: binding.leaseOwnerId,
          writerLeaseFencingToken: binding.fencingToken,
        },
      });

      let terminal: AtomicWorkflowLifecycleDetail | undefined;
      while (Date.now() < deadline) {
        if (signal.aborted) throw errorOf(signal.reason ?? new Error("Atomic fixture pilot cancelled"));
        const statusTimeoutMs = remainingDeadlineMs(deadline, 15_000);
        const statusPromise = collector.nextLifecycle(
          (event) => event.action === "status" && event.runId === admitted.runId,
          statusTimeoutMs,
        );
        const [status] = await Promise.all([
          statusPromise,
          client.prompt(buildAtomicWorkflowStatusCommand(admitted.runId), {
            signal,
            timeoutMs: statusTimeoutMs,
          }),
        ]);
        if (isTerminalAtomicWorkflowStatus(status.status)) {
          terminal = status;
          break;
        }
        await delay(Math.min(this.statusPollMs, remainingDeadlineMs(deadline)), undefined, { signal });
      }
      if (!terminal) throw new Error("Atomic fixture workflow exceeded its elapsed-time bound");
      if (terminal.status !== "completed") {
        throw new Error(`Atomic fixture workflow ended ${terminal.status}: ${terminal.error ?? terminal.message ?? "no native detail"}`);
      }
      const output = parseAtomicFixtureWorkflowOutput(terminal.output);
      const validatedArtifacts = this.validateWorkflowEvidence(handle, run, terminal.runId, output, staged);
      validationState.artifacts = Object.freeze(validatedArtifacts.map((artifact) => Object.freeze({ ...artifact })));
      const entries = await client.getEntries<Record<string, unknown>>(undefined, {
        signal,
        timeoutMs: remainingDeadlineMs(deadline),
      });
      const entryData = plainObject(entries.data, "Atomic get_entries response");
      const nativeCursor = typeof entryData.leafId === "string" ? entryData.leafId : null;
      const stats = await client.getSessionStats<Record<string, unknown>>({
        signal,
        timeoutMs: remainingDeadlineMs(deadline),
      });
      const statData = plainObject(stats.data, "Atomic get_session_stats response");
      const tokens = plainObject(statData.tokens, "Atomic session token statistics");
      if (statData.cost !== 0 || tokens.total !== 0) throw new Error("Credential-free Atomic fixture unexpectedly reported model usage or cost");
      await collector.drain();
      const refreshed = await this.requireRun(run.id);
      await this.store.updateRun(run.id, {
        costUsd: 0,
        metadata: {
          ...refreshed.metadata,
          nativeCursor,
          nativeSessionCostUsd: 0,
          nativeSessionTokens: 0,
          atomicFixtureChecksPassed: true,
          atomicFixtureVerifierPassed: true,
          atomicFixtureRepairCount: 0,
          atomicFixtureSourceAfterSha256: output.source_after_sha256,
          atomicFixtureValidatedWorkspaceArtifacts: validationState.artifacts,
        },
      });
      const summary = canonicalJson({ nativeSessionId, nativeWorkflowRunId: terminal.runId, status: terminal.status, evidence: output.evidence_manifest_path });
      return { exitCode: 0, stdout: summary, stderr: "", stdoutBytes: Buffer.byteLength(summary), stderrBytes: 0 };
    } finally {
      collector.close();
      await collector.drain();
    }
  }

  private validateWorkflowEvidence(
    handle: OciSandboxHandle,
    run: Run,
    nativeRunId: string,
    output: AtomicFixtureWorkflowOutput,
    staged: StagedContext,
  ): AtomicFixtureValidatedArtifact[] {
    if (output.source_after_sha256 !== ATOMIC_FIXTURE_IMPLEMENTATION_SHA256) {
      throw new Error("Atomic fixture output source hash is not the reviewed implementation");
    }
    const bodies = new Map<string, Buffer>();
    for (const artifact of ARTIFACTS) {
      bodies.set(artifact.relativePath, readContainedWorkspaceFile(handle, artifact.relativePath));
    }
    const validated = ARTIFACTS.map((artifact) => {
      const body = bodies.get(artifact.relativePath)!;
      return {
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        checksum: sha(body),
        sizeBytes: body.byteLength,
      };
    });
    const byPath = new Map(validated.map((artifact) => [artifact.relativePath, artifact]));
    const parseArtifact = (path: string, label: string): Record<string, unknown> => {
      try {
        return plainObject(JSON.parse(bodies.get(path)!.toString("utf8")), label);
      } catch (error) {
        throw new Error(`${label} is not valid JSON`, { cause: error });
      }
    };
    const assertExact = (actual: unknown, expected: unknown, label: string): void => {
      if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} does not match the reviewed deterministic contract`);
    };
    const binding = (path: string) => {
      const artifact = byPath.get(path);
      if (!artifact) throw new Error(`Atomic fixture artifact binding references unknown path ${path}`);
      return { path, sha256: artifact.checksum, size_bytes: artifact.sizeBytes };
    };

    const sourceBody = readContainedWorkspaceFile(handle, "src/normalize-project-slug.js");
    const testBody = readContainedWorkspaceFile(handle, "test/normalize-project-slug.test.js");
    if (sha(sourceBody) !== ATOMIC_FIXTURE_IMPLEMENTATION_SHA256 || sourceBody.toString("utf8") !== ATOMIC_FIXTURE_IMPLEMENTATION) {
      throw new Error("Atomic fixture workspace source is not the exact reviewed implementation");
    }
    if (sha(testBody) !== ATOMIC_FIXTURE_TEST_SHA256) throw new Error("Atomic fixture workspace tests changed after launch");

    const patchText = bodies.get(output.patch_path)!.toString("utf8");
    const expectedHeader = `diff --git a/src/normalize-project-slug.js b/src/normalize-project-slug.js\n`;
    if (!patchText.startsWith(expectedHeader)
      || (patchText.match(/^diff --git /gm) ?? []).length !== 1
      || !patchText.includes("--- a/src/normalize-project-slug.js\n+++ b/src/normalize-project-slug.js\n")
      || !patchText.includes('-  throw new Error("TODO: implement the fixed Atomic pilot fixture");\n')) {
      throw new Error("Atomic fixture patch is not the exact single-source-file candidate diff");
    }
    for (const line of ATOMIC_FIXTURE_IMPLEMENTATION.trimEnd().split("\n").filter(Boolean)) {
      if (!patchText.includes(`+${line}\n`) && !patchText.includes(` ${line}\n`)) {
        throw new Error("Atomic fixture patch omitted reviewed implementation content");
      }
    }

    const checksArtifact = byPath.get(output.check_path)!;
    const expectedChecks = {
      schema_version: "1.0.0",
      passed: true,
      source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      changed_paths: ["src/normalize-project-slug.js"],
      commands: [
        { argv: ["/usr/local/bin/node", "--test"], exit_code: 0, passed: true },
        { argv: ["/usr/bin/git", "diff", "--check"], exit_code: 0, passed: true },
      ],
      change_gate: { exact_allowlist: ["src/normalize-project-slug.js"], passed: true },
    };
    assertExact(parseArtifact(output.check_path, "Atomic fixture checks"), expectedChecks, "Atomic fixture checks");

    if (!staged.contractSha256 || !SHA256.test(staged.contractSha256)) throw new Error("Atomic fixture staged contract hash is unavailable");
    const expectedVerifier = {
      schema_version: "1.0.0",
      context_mode: "fresh-deterministic-process",
      passed: true,
      inputs: {
        contract_sha256: staged.contractSha256,
        checks_sha256: checksArtifact.checksum,
        source_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
        tests_sha256: ATOMIC_FIXTURE_TEST_SHA256,
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
    assertExact(parseArtifact(output.verifier_path, "Atomic fixture verifier"), expectedVerifier, "Atomic fixture verifier");

    const expectedMemoryProposal = {
      schema_version: "1.0.0",
      status: "proposed",
      namespace: `projects/${run.projectId}`,
      proposition: "The disposable Atomic pilot candidate satisfied its fixed normalization contract and deterministic verifier.",
      evidence_ref: output.evidence_manifest_path,
      evidence_binding: {
        control_plane_run_id: run.id,
        contract_sha256: staged.contractSha256,
        source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      },
      automatic_capture: false,
      canonical_promotion: false,
      promotion_requires_separate_human_action: true,
    };
    assertExact(
      parseArtifact(output.memory_proposal_path, "Atomic fixture memory proposal"),
      expectedMemoryProposal,
      "Atomic fixture memory proposal",
    );
    const expectedDraftPrMock = {
      schema_version: "1.0.0",
      mock: true,
      title: "Implement normalizeProjectSlug in disposable Atomic pilot fixture",
      body: "Deterministic integration evidence only. No GitHub request was made.",
      changed_paths: ["src/normalize-project-slug.js"],
      external_request_performed: false,
      requires_separate_control_plane_approval: true,
    };
    assertExact(
      parseArtifact(output.draft_pr_mock_path, "Atomic fixture draft PR mock"),
      expectedDraftPrMock,
      "Atomic fixture draft PR mock",
    );

    const contractBody = readFileSync(join(staged.path, "run-contract.json"));
    const contextBody = readFileSync(join(staged.path, "context-pack.json"));
    const manifestBody = readFileSync(join(staged.path, "atomic-launch-manifest.json"));
    if (!bodies.get(output.run_contract_path)!.equals(contractBody)
      || !bodies.get(output.context_pack_path)!.equals(contextBody)
      || !bodies.get(output.launch_manifest_path)!.equals(manifestBody)) {
      throw new Error("Atomic fixture context copies do not match their immutable launch inputs");
    }
    const workflowBody = readFileSync(join(staged.path, "atomic-package", "workflows", "atomic-fixture-pilot.ts"));
    const coreBody = readFileSync(join(staged.path, "atomic-package", "lib", "atomic-fixture-pilot-core.mjs"));
    const packageJsonBody = readFileSync(join(staged.path, "atomic-package", "package.json"));
    const contextSha = sha(contextBody);
    const contractSha = sha(contractBody);
    const manifestSha = sha(manifestBody);
    const expectedEvidence = {
      schema_version: "1.0.0",
      workflow: {
        name: ATOMIC_FIXTURE_WORKFLOW_NAME,
        version: ATOMIC_FIXTURE_WORKFLOW_VERSION,
        content_sha256: sha(workflowBody),
        native_run_id: nativeRunId,
        root_runtime: "atomic",
        model_execution_attempted: false,
        network_required: "none",
      },
      atomic_package: {
        name: ATOMIC_FIXTURE_PACKAGE_NAME,
        version: ATOMIC_FIXTURE_PACKAGE_VERSION,
        workflow_sha256: sha(workflowBody),
        core_sha256: sha(coreBody),
        package_json_sha256: sha(packageJsonBody),
      },
      control_plane_run_id: run.id,
      contract_sha256: contractSha,
      source_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
      source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      test_sha256: ATOMIC_FIXTURE_TEST_SHA256,
      changed_paths: ["src/normalize-project-slug.js"],
      checks_passed: true,
      verifier_passed: true,
      repair_count: 0,
      final_action: "stop_before_external_action",
      bounds: ATOMIC_FIXTURE_BOUNDS,
      artifacts: {
        patch: binding(output.patch_path),
        checks: binding(output.check_path),
        verifier: binding(output.verifier_path),
        memory_proposal: binding(output.memory_proposal_path),
        draft_pr_mock: binding(output.draft_pr_mock_path),
        context_pack: binding(output.context_pack_path),
        run_contract: binding(output.run_contract_path),
        atomic_launch_manifest: binding(output.launch_manifest_path),
      },
      context_copies: {
        context_pack: {
          path: output.context_pack_path,
          source_sha256: contextSha,
          copied_sha256: contextSha,
          checksum_equal: true,
        },
        run_contract: {
          path: output.run_contract_path,
          source_sha256: contractSha,
          copied_sha256: contractSha,
          checksum_equal: true,
        },
        atomic_launch_manifest: {
          path: output.launch_manifest_path,
          source_sha256: manifestSha,
          copied_sha256: manifestSha,
          checksum_equal: true,
        },
      },
      external_actions: {
        github_request_performed: false,
        memory_promoted: false,
        deployment_performed: false,
      },
    };
    assertExact(
      parseArtifact(output.evidence_manifest_path, "Atomic fixture evidence"),
      expectedEvidence,
      "Atomic fixture evidence",
    );
    return validated;
  }

  private async validateFrozenExports(
    runId: string,
    validationState: AtomicFixtureValidationState,
    exports: readonly Readonly<WriterSandboxValidatedExport>[],
  ): Promise<void> {
    if (!validationState.artifacts || validationState.artifacts.length !== ARTIFACTS.length) {
      throw new Error("Atomic fixture export validation has no complete workspace snapshot");
    }
    const normalize = (items: readonly Readonly<AtomicFixtureValidatedArtifact | WriterSandboxValidatedExport>[]) =>
      items.map((item) => ({
        relativePath: item.relativePath,
        kind: item.kind,
        mediaType: item.mediaType,
        checksum: item.checksum,
        sizeBytes: item.sizeBytes,
      })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const expected = normalize(validationState.artifacts);
    const actual = normalize(exports);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error("Atomic fixture frozen exports changed after native evidence validation");
    }
    const run = await this.requireRun(runId);
    await this.store.updateRun(runId, {
      metadata: {
        ...run.metadata,
        atomicFixtureFrozenExportsValidated: true,
        atomicFixtureFrozenExportArtifacts: actual,
      },
    });
  }

  private async failQueuedOwnedState(
    run: Run,
    workspace: WorkspaceRecord | null,
    instance: SandboxInstance | null,
  ): Promise<void> {
    if (workspace && workspace.runId !== run.id) {
      throw new Error("Queued Atomic fixture workspace ownership changed during reconciliation");
    }
    if (instance && instance.runId !== run.id) {
      throw new Error("Queued Atomic fixture sandbox ownership changed during reconciliation");
    }
    const workspaceId = workspace?.id ?? instance?.workspaceId;
    let leaseQuarantined = false;
    if (workspaceId) {
      const lease = await this.store.getWorkspaceLease(workspaceId);
      if (lease) {
        if (lease.runId !== run.id || lease.workspaceId !== workspaceId
          || (instance && (lease.ownerId !== instance.leaseOwnerId || lease.fencingToken !== instance.fencingToken))) {
          throw new Error("Queued Atomic fixture reconciliation found a mismatched writer fence");
        }
        if (lease.state === "active") {
          const quarantined = await this.store.quarantineWorkspaceLease({
            workspaceId: lease.workspaceId,
            runId: lease.runId,
            ownerId: lease.ownerId,
            fencingToken: lease.fencingToken,
            quarantinedAt: this.clock().toISOString(),
            reason: "queued_run_has_durable_writer_state",
          });
          if (!quarantined) throw new Error("Queued Atomic fixture lost its exact writer-fence quarantine race");
        }
        leaseQuarantined = true;
      }
    }
    const at = this.clock().toISOString();
    const reason = workspace && !instance
      ? "queued_run_workspace_without_sandbox"
      : instance
        ? `queued_run_with_${instance.state}_sandbox`
        : "queued_run_with_inconsistent_writer_state";
    await this.store.updateRun(run.id, {
      status: "failed",
      stage: leaseQuarantined ? "workspace_quarantined" : "atomic_fixture_failed",
      completedAt: at,
      nextActionAt: null,
      metadata: {
        ...run.metadata,
        reconciliationReason: reason,
        writerLeaseQuarantined: leaseQuarantined,
        externalActionPerformed: false,
      },
    });
    await this.store.appendEvent({
      id: `event_atomic_queued_state_${sha(`${run.id}\0${reason}`).slice(0, 32)}`,
      runId: run.id,
      type: "run.reconciliation_failed",
      message: "Queued Atomic fixture retained durable writer state and was failed closed",
      payload: {
        reason,
        workspaceId: workspaceId ?? null,
        leaseQuarantined,
        externalActionPerformed: false,
      },
      createdAt: at,
    });
    this.removeExistingStagedContext(run.id);
  }

  private async expireApprovals(): Promise<number> {
    let expired = 0;
    const observedAt = this.clock().toISOString();
    for (let batch = 0; batch < 10; batch += 1) {
      const pendingApprovals = await this.store.listExpiredApprovals(
        ATOMIC_FIXTURE_PROJECT_ID,
        ATOMIC_FIXTURE_WORKFLOW_NAME,
        observedAt,
        100,
      );
      for (const approval of pendingApprovals) {
        const run = await this.store.getRun(approval.runId);
        if (!run || !this.isPilotRun(run) || run.status !== "awaiting_approval") continue;
        const binding = approvalBindingOf(approval);
        if (!binding) throw new Error("Expired Atomic fixture approval lost its binding");
        await this.store.expireApprovalTransaction({
          approvalId: approval.id,
          runPatch: {
            status: "failed",
            stage: "approval_expired",
            completedAt: observedAt,
            nextActionAt: null,
            metadata: { ...run.metadata, approvalExpired: true, externalActionPerformed: false },
          },
          event: {
            id: `event_atomic_approval_expired_${sha(approval.id).slice(0, 32)}`,
            runId: run.id,
            type: "approval.expired",
            message: "Atomic fixture approval expired without an external action",
            payload: { approvalId: approval.id, evidenceDigest: binding.evidenceDigest },
            createdAt: observedAt,
          },
        });
        expired += 1;
      }
      if (pendingApprovals.length < 100) break;
      if (batch === 9) throw new Error("Atomic fixture approval expiry backlog exceeded the bounded maintenance pass");
    }
    return expired;
  }

  private async validateEvidenceSnapshot(
    run: Run,
    suppliedArtifacts?: readonly Artifact[],
  ): Promise<{ artifacts: Artifact[]; instance: SandboxInstance; snapshot: AtomicFixtureValidatedArtifact[] }> {
    const artifacts = [...(suppliedArtifacts ?? await this.store.listArtifacts(run.id))]
      .sort((left, right) => left.kind.localeCompare(right.kind)
        || left.uri.localeCompare(right.uri)
        || left.id.localeCompare(right.id));
    if (artifacts.length !== ARTIFACTS.length) throw new Error("Atomic fixture evidence set is incomplete");
    const expectedKinds = [...ARTIFACTS].map((item) => item.kind).sort();
    const actualKinds = artifacts.map((item) => item.kind).sort();
    if (canonicalJson(actualKinds) !== canonicalJson(expectedKinds)) throw new Error("Atomic fixture evidence kinds do not match the governed manifest");
    const parseSnapshot = (value: unknown, label: string): AtomicFixtureValidatedArtifact[] => {
      if (!Array.isArray(value) || value.length !== ARTIFACTS.length) throw new Error(`${label} is incomplete`);
      return value.map((item) => {
        const record = plainObject(item, label);
        if (typeof record.relativePath !== "string" || typeof record.kind !== "string" || typeof record.mediaType !== "string"
          || typeof record.checksum !== "string" || !SHA256.test(record.checksum)
          || !Number.isSafeInteger(record.sizeBytes) || Number(record.sizeBytes) < 1) {
          throw new Error(`${label} contains an invalid artifact record`);
        }
        return {
          relativePath: record.relativePath,
          kind: record.kind,
          mediaType: record.mediaType,
          checksum: record.checksum,
          sizeBytes: Number(record.sizeBytes),
        };
      }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    };
    if (run.metadata.atomicFixtureFrozenExportsValidated !== true) {
      throw new Error("Atomic fixture approval requires a validated stopped export snapshot");
    }
    const workspaceSnapshot = parseSnapshot(
      run.metadata.atomicFixtureValidatedWorkspaceArtifacts,
      "Atomic fixture validated workspace snapshot",
    );
    const frozenSnapshot = parseSnapshot(
      run.metadata.atomicFixtureFrozenExportArtifacts,
      "Atomic fixture frozen export snapshot",
    );
    if (canonicalJson(workspaceSnapshot) !== canonicalJson(frozenSnapshot)) {
      throw new Error("Atomic fixture approval snapshots no longer match");
    }
    const expectedSnapshotPaths = ARTIFACTS.map((item) => item.relativePath).sort();
    if (canonicalJson(frozenSnapshot.map((item) => item.relativePath)) !== canonicalJson(expectedSnapshotPaths)) {
      throw new Error("Atomic fixture approval snapshot paths do not match the governed manifest");
    }
    const governedByPath = new Map(ARTIFACTS.map((item) => [item.relativePath, item]));
    for (const snapshot of frozenSnapshot) {
      const governed = governedByPath.get(snapshot.relativePath);
      if (!governed || snapshot.kind !== governed.kind || snapshot.mediaType !== governed.mediaType) {
        throw new Error("Atomic fixture frozen artifact identity does not match the governed manifest");
      }
      const expectedUri = `artifact://runs/${encodeURIComponent(run.id)}/${snapshot.relativePath.split("/").map(encodeURIComponent).join("/")}`;
      const artifact = artifacts.find((candidate) => candidate.kind === snapshot.kind && candidate.uri === expectedUri);
      if (!artifact || artifact.mediaType !== snapshot.mediaType || artifact.checksum !== snapshot.checksum) {
        throw new Error("Atomic fixture persisted artifact does not match its validated frozen snapshot");
      }
    }
    const verifiedBytes = this.boundary.verifyGovernedArtifacts(run.id, frozenSnapshot);
    if (canonicalJson(verifiedBytes) !== canonicalJson(frozenSnapshot)) {
      throw new Error("Atomic fixture governed artifact bytes no longer match their frozen snapshot");
    }
    const instance = await this.store.getSandboxInstance(run.id);
    if (!instance || instance.state !== "cleaned" || !SHA256.test(instance.policyHash)) throw new Error("Atomic fixture sandbox cleanup/policy evidence is incomplete");
    if (run.workspaceId !== instance.workspaceId) throw new Error("Atomic fixture cleaned sandbox no longer matches the run workspace");
    const [lease, workspace] = await Promise.all([
      this.store.getWorkspaceLease(instance.workspaceId),
      this.store.getWorkspaceForRun(run.id),
    ]);
    if (lease) throw new Error("Atomic fixture cleaned evidence still has a writer lease");
    if (!workspace || workspace.id !== instance.workspaceId || workspace.runId !== run.id || existsSync(workspace.path)) {
      throw new Error("Atomic fixture cleaned evidence does not prove workspace release");
    }
    return { artifacts, instance, snapshot: frozenSnapshot };
  }

  private async validatePendingApproval(
    run: Run,
    approval: Approval,
  ): Promise<{ artifacts: Artifact[]; instance: SandboxInstance; snapshot: AtomicFixtureValidatedArtifact[] }> {
    if (run.status !== "awaiting_approval" || run.stage !== "approval") {
      throw new Error("Atomic fixture final approval requires a run awaiting its exact approval gate");
    }
    if (approval.state !== "pending" || approval.runId !== run.id
      || approval.action !== ATOMIC_FIXTURE_APPROVAL_ACTION
      || approval.exactEffect !== ATOMIC_FIXTURE_APPROVAL_EFFECT) {
      throw new Error("Atomic fixture final approval is not the exact pending gate");
    }
    const binding = approvalBindingOf(approval);
    if (!binding || binding.projectId !== run.projectId
      || binding.workflow !== ATOMIC_FIXTURE_WORKFLOW_NAME) {
      throw new Error("Atomic fixture pending approval lost its project/workflow binding");
    }
    const validated = await this.validateEvidenceSnapshot(run);
    const evidenceDigest = artifactDigest(validated.artifacts);
    const evidence = validated.artifacts.map((artifact) =>
      `${artifact.kind}:${artifact.uri}#sha256=${artifact.checksum}`);
    if (binding.evidenceDigest !== evidenceDigest || binding.policyHash !== validated.instance.policyHash
      || canonicalJson(approval.evidence) !== canonicalJson(evidence)) {
      throw new Error("Atomic fixture pending approval no longer matches its governed evidence bytes");
    }
    return validated;
  }

  private async ensureEvidenceApproval(run: Run, result?: { artifacts: readonly Artifact[] }): Promise<void> {
    const { artifacts, instance } = await this.validateEvidenceSnapshot(run, result?.artifacts);
    if (existsSync(join(this.contextRoot, safeRunId(run.id)))) {
      throw new Error("Atomic fixture approval requires staged-context cleanup");
    }
    const evidenceDigest = artifactDigest(artifacts);
    const evidence = artifacts.map((artifact) => `${artifact.kind}:${artifact.uri}#sha256=${artifact.checksum}`);
    const proposalId = `memory_atomic_${sha(`${run.id}\0${evidenceDigest}`).slice(0, 32)}`;
    const expectedProposal: MemoryProposal = {
      id: proposalId,
      projectId: run.projectId,
      runId: run.id,
      claim: "The disposable Atomic fixture completed its fixed tool-only workflow and deterministic verifier inside the governed isolated writer boundary.",
      evidence,
      state: "proposed",
      createdAt: artifacts[0]!.createdAt,
    };
    const existingProposal = await this.store.getMemoryProposal(proposalId);
    if (!existingProposal) await this.store.createMemoryProposal(expectedProposal);
    else if (canonicalJson({
      id: existingProposal.id,
      projectId: existingProposal.projectId,
      runId: existingProposal.runId ?? null,
      claim: existingProposal.claim,
      evidence: existingProposal.evidence,
      state: existingProposal.state,
      createdAt: existingProposal.createdAt,
    }) !== canonicalJson({ ...expectedProposal, runId: expectedProposal.runId ?? null })) {
      throw new Error("Atomic fixture memory proposal replay changed content");
    }

    const approvalId = `approval_atomic_${sha(`${run.id}\0${evidenceDigest}`).slice(0, 32)}`;
    const existingApproval = await this.store.getApproval(approvalId);
    if (existingApproval) {
      const binding = approvalBindingOf(existingApproval);
      if (!binding || binding.evidenceDigest !== evidenceDigest || binding.policyHash !== instance.policyHash
        || binding.projectId !== run.projectId || binding.workflow !== ATOMIC_FIXTURE_WORKFLOW_NAME
        || existingApproval.action !== ATOMIC_FIXTURE_APPROVAL_ACTION || existingApproval.exactEffect !== ATOMIC_FIXTURE_APPROVAL_EFFECT
        || canonicalJson(existingApproval.evidence) !== canonicalJson(evidence)) {
        throw new Error("Atomic fixture approval replay changed its evidence or policy binding");
      }
      return;
    }
    const requestedAt = this.clock().toISOString();
    const expiresAt = new Date(this.clock().getTime() + this.approvalTtlMs).toISOString();
    const approval: Approval = {
      id: approvalId,
      runId: run.id,
      action: ATOMIC_FIXTURE_APPROVAL_ACTION,
      exactEffect: ATOMIC_FIXTURE_APPROVAL_EFFECT,
      state: "pending",
      evidence,
      requestedAt,
      projectId: run.projectId,
      workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
      evidenceDigest,
      policyHash: instance.policyHash,
      expiresAt,
    };
    await this.store.requestApprovalTransaction({
      approval,
      event: {
        id: `event_atomic_approval_requested_${sha(approval.id).slice(0, 32)}`,
        runId: run.id,
        type: "approval.requested",
        message: "Atomic fixture evidence is cleaned and ready for a bounded human acceptance decision",
        payload: {
          approvalId: approval.id,
          action: approval.action,
          evidenceDigest,
          policyHash: instance.policyHash,
          expiresAt,
          externalActionPerformed: false,
        },
        createdAt: requestedAt,
      },
    });
  }

  private async recordFailure(runId: string, error: unknown): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || ["completed", "cancelled"].includes(run.status)) return;
    if (run.status === "failed") return;
    const at = this.clock().toISOString();
    await this.store.updateRun(run.id, {
      status: "failed",
      stage: "atomic_fixture_failed",
      completedAt: at,
      nextActionAt: null,
      metadata: {
        ...run.metadata,
        atomicFixtureFailure: errorOf(error).message.slice(0, 500),
        externalActionPerformed: false,
      },
    });
    await this.store.appendEvent({
      id: `event_atomic_failure_${sha(`${run.id}\0${at}`).slice(0, 32)}`,
      runId: run.id,
      type: "run.failed",
      message: "Atomic fixture pilot failed closed before any external action",
      payload: { error: errorOf(error).message.slice(0, 500), externalActionPerformed: false },
      createdAt: at,
    });
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Atomic fixture run was not found");
    return run;
  }
}

// Keep the concrete provider structurally checked as its contract evolves.
const _providerCompatibility: Pick<OciSandboxProvider, "openAtomicRpc"> | undefined = undefined;
void _providerCompatibility;
