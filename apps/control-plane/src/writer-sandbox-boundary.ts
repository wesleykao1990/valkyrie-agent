import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Artifact, Project, Run } from "./types.ts";
import type { ControlPlaneStore, SandboxInstanceState, WorkspaceLease } from "./store.ts";
import {
  ArtifactSecretDetectedError,
  exportGovernedArtifacts,
  readGovernedArtifactExport,
  verifyGovernedArtifactExports,
  type ArtifactManifestEntry,
  type GovernedArtifactExport,
  type GovernedArtifactVerificationEntry,
} from "./governed-artifact-export.ts";
import type {
  OciCleanupResult,
  OciPreflightResult,
  OciReconciliationExpectation,
  OciReconciliationResult,
  OciRunResult,
  OciSandboxContract,
  OciSandboxHandle,
  OciSandboxStartInput,
} from "./oci-sandbox-provider.ts";
import { WriterLeaseSupervisor } from "./writer-lease-supervisor.ts";
import {
  WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON,
  WriterWorkspaceManager,
  type PreparedWriterWorkspace,
} from "./writer-workspace.ts";

export interface WriterSandboxProvider {
  contract(): OciSandboxContract;
  preflight(): Promise<OciPreflightResult>;
  start(input: OciSandboxStartInput): Promise<OciSandboxHandle>;
  execute(handle: OciSandboxHandle, command: readonly string[]): Promise<OciRunResult>;
  stop(handle: OciSandboxHandle): Promise<OciCleanupResult | { status: "stopped" }>;
  cleanup(handle: OciSandboxHandle): Promise<OciCleanupResult>;
  reconcileOrphans(expectations: readonly OciReconciliationExpectation[]): Promise<OciReconciliationResult[]>;
}

export interface WriterSandboxReconciliationSummary {
  instancesExamined: number;
  engineObjectsCleaned: number;
  engineObjectsAbsent: number;
  instancesQuarantined: number;
  runsFailed: number;
}

export interface WriterSandboxBoundaryOptions {
  store: ControlPlaneStore;
  workspaces: WriterWorkspaceManager;
  provider: WriterSandboxProvider;
  artifactRoot: string;
  ownerId: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

export interface WriterSandboxFixtureInput {
  run: Run;
  project: Project;
  repositoryPath: string;
  contextPath: string;
  command: readonly string[];
  artifacts: readonly ArtifactManifestEntry[];
  baseRef?: string;
}

export interface WriterSandboxFixtureResult {
  runId: string;
  workspaceId: string;
  fencingToken: number;
  baseCommit: string;
  branchName: string;
  command: OciRunResult;
  exports: GovernedArtifactExport[];
  artifacts: Artifact[];
}

export type WriterSandboxWorkloadCompletion = "completed" | "evidence_ready";

/**
 * Path-free digest of one frozen governed export. Trusted workload validators
 * receive only these immutable facts, never artifact-root host paths.
 */
export interface WriterSandboxValidatedExport {
  relativePath: string;
  kind: string;
  mediaType: string;
  checksum: string;
  sizeBytes: number;
}

/**
 * Immutable ownership and policy facts supplied to trusted in-process hooks.
 * Host paths and commands are intentionally absent: the M5 coordinator owns
 * those fixed configuration values rather than accepting them from HTTP/MCP.
 */
export interface WriterSandboxWorkloadBinding {
  runId: string;
  projectId: string;
  workflow: string;
  workspaceId: string;
  leaseOwnerId: string;
  fencingToken: number;
  baseCommit: string;
  branchName: string;
  workspaceProvider: string;
  sandboxContract: OciSandboxContract;
}

/**
 * Trusted, internal-only writer workload. `allowedWorkflow`, repositoryPath,
 * contextPath, hooks, and artifact manifest must come from reviewed host
 * configuration; this type is deliberately not an API/MCP request contract.
 */
export interface WriterSandboxWorkloadInput {
  allowedWorkflow: string;
  run: Run;
  project: Project;
  repositoryPath: string;
  contextPath: string;
  artifacts: readonly ArtifactManifestEntry[];
  prepareContext: (binding: Readonly<WriterSandboxWorkloadBinding>) => Promise<void>;
  execute: (
    handle: OciSandboxHandle,
    binding: Readonly<WriterSandboxWorkloadBinding>,
  ) => Promise<OciRunResult>;
  /** Rebind the stopped/frozen export to bytes validated during execution. */
  validateExports?: (exports: readonly Readonly<WriterSandboxValidatedExport>[]) => Promise<void> | void;
  completion: WriterSandboxWorkloadCompletion;
  baseRef?: string;
}

export interface WriterSandboxWorkloadResult {
  runId: string;
  workspaceId: string;
  fencingToken: number;
  baseCommit: string;
  branchName: string;
  execution: OciRunResult;
  exports: GovernedArtifactExport[];
  artifacts: Artifact[];
  completion: WriterSandboxWorkloadCompletion;
}

interface WriterSandboxLifecycleLabels {
  boundary: "contract-fixture-only" | "trusted-internal-workload";
  runningStage: string;
  failedStage: string;
  completedStage: string;
  completedMetadataKey: "sandboxFixtureCompleted" | "writerWorkloadCompleted";
}

export class WriterSandboxQuarantinedError extends Error {
  readonly code = "WRITER_SANDBOX_QUARANTINED";
  readonly reason: string;

  constructor(reason: string) {
    super(`Writer sandbox was quarantined: ${reason}`);
    this.name = "WriterSandboxQuarantinedError";
    this.reason = reason;
  }
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fence(lease: WorkspaceLease) {
  return {
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ArtifactSecretDetectedError) return error.code;
  if (error instanceof WriterSandboxQuarantinedError) return error.code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(String((error as any).code ?? ""))
    ? String((error as any).code)
    : "WRITER_SANDBOX_FAILED";
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function resolveProspectivePath(input: string, label: string): string {
  const requested = resolve(input);
  let existing = requested;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`${label} has no existing filesystem ancestor`);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const stat = lstatSync(existing);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must resolve beneath a regular non-symlink directory`);
  }
  return resolve(realpathSync(existing), ...suffix);
}

function assertArtifactRootDisjoint(artifactRoot: string, runRoot: string, contextPath: string): void {
  const candidate = resolveProspectivePath(artifactRoot, "Writer artifact root");
  const workspace = realpathSync(runRoot);
  const context = realpathSync(contextPath);
  if (pathsOverlap(candidate, workspace) || pathsOverlap(candidate, context)) {
    throw new Error("Writer artifact root must be disjoint from the run root and staged context");
  }
}

function checksumContextDirectory(input: string): string {
  const requested = resolve(input);
  const rootStat = lstatSync(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Writer context must be a regular non-symlink directory");
  }
  const root = realpathSync(requested);
  const files: Array<{ relativePath: string; path: string; size: number }> = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Writer context cannot contain symbolic links");
      const real = realpathSync(path);
      if (!real.startsWith(`${root}${sep}`)) throw new Error("Writer context escaped its staging root");
      if (stat.isDirectory()) {
        visit(real);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Writer context must contain only single-link regular files");
      totalBytes += stat.size;
      if (files.length >= 128 || stat.size > 1024 * 1024 || totalBytes > 4 * 1024 * 1024) {
        throw new Error("Writer context exceeds its file or byte bound");
      }
      files.push({ relativePath: relative(root, real).split(sep).join("/"), path: real, size: stat.size });
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath).update("\0").update(String(file.size)).update("\0").update(readFileSync(file.path));
  }
  return hash.digest("hex");
}

/**
 * Internal Milestone 4 fixture coordinator. It is deliberately not registered as
 * a runtime or exposed through HTTP/MCP. A live provider must pass separately
 * before a real model writer can use the same boundary in Milestone 5.
 */
export class WriterSandboxBoundary {
  private readonly options: WriterSandboxBoundaryOptions;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly clock: () => Date;

  constructor(options: WriterSandboxBoundaryOptions) {
    this.options = options;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.clock = options.now ?? (() => new Date());
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.ownerId)) {
      throw new Error("Writer sandbox owner ID is invalid");
    }
  }

  async reconcileStartup(): Promise<WriterSandboxReconciliationSummary> {
    const states: SandboxInstanceState[] = ["provisioning", "ready", "running", "freezing", "exporting"];
    const instances = await this.options.store.listSandboxInstances(states);
    const results = await this.options.provider.reconcileOrphans(instances.map((instance) => ({
      runId: instance.runId,
      workspaceId: instance.workspaceId,
      leaseOwnerId: instance.leaseOwnerId,
      fencingToken: instance.fencingToken,
      engineId: instance.engineId,
      imageRef: instance.imageRef,
      policyHash: instance.policyHash,
      workspaceDigest: instance.workspaceDigest,
      contextDigest: instance.contextDigest,
      workdirDigest: instance.workdirDigest,
      cleanupAttempts: instance.cleanupAttempts,
    })));
    const unmatched = results.filter((result) => result.outcome === "unmatched");
    if (unmatched.length > 0) {
      throw new Error("Restart reconciliation found a managed engine object without durable sandbox ownership");
    }
    const byRun = new Map(results.filter((result) => result.runId).map((result) => [result.runId!, result]));
    if (byRun.size !== instances.length) throw new Error("Restart reconciliation did not return exactly one result per sandbox instance");
    let engineObjectsCleaned = 0;
    let engineObjectsAbsent = 0;
    let instancesQuarantined = 0;
    let runsFailed = 0;
    for (const instance of instances) {
      const result = byRun.get(instance.runId)!;
      if (result.workspaceId !== instance.workspaceId) throw new Error("Restart reconciliation workspace ownership changed");
      if (result.outcome === "cleaned") engineObjectsCleaned += 1;
      if (result.outcome === "absent") engineObjectsAbsent += 1;
      const currentLease = await this.options.store.getWorkspaceLease(instance.workspaceId);
      if (currentLease) {
        if (currentLease.runId !== instance.runId || currentLease.ownerId !== instance.leaseOwnerId
            || currentLease.fencingToken !== instance.fencingToken) {
          throw new Error("Restart reconciliation found a successor or mismatched writer lease");
        }
        if (currentLease.state === "active") {
          const quarantined = await this.options.store.quarantineWorkspaceLease({
            ...fence(currentLease),
            quarantinedAt: this.clock().toISOString(),
            reason: `provider_restart_${result.reason}`,
          });
          if (!quarantined) throw new Error("Restart reconciliation lost the exact lease quarantine race");
        }
      }
      const transitionAt = this.clock().toISOString();
      const transitioned = await this.options.store.transitionSandboxInstance({
        workspaceId: instance.workspaceId,
        runId: instance.runId,
        ownerId: instance.leaseOwnerId,
        fencingToken: instance.fencingToken,
        expectedState: instance.state,
        state: "quarantined",
        updatedAt: transitionAt,
        ...(result.cleanupAttempted ? { cleanupAttemptedAt: transitionAt } : {}),
        quarantineReason: `provider_restart_${result.reason}`,
      });
      if (!transitioned) throw new Error("Restart reconciliation lost the sandbox lifecycle transition");
      instancesQuarantined += 1;
      const run = await this.options.store.getRun(instance.runId);
      if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
        await this.options.store.updateRun(run.id, {
          status: "failed",
          stage: "workspace_quarantined",
          completedAt: transitionAt,
          nextActionAt: null,
          metadata: {
            ...run.metadata,
            reconciliationReason: `provider_restart_${result.reason}`,
            sandboxEngineCleanupProven: result.outcome === "cleaned" || result.outcome === "absent",
          },
        });
        runsFailed += 1;
      }
    }
    return { instancesExamined: instances.length, engineObjectsCleaned, engineObjectsAbsent, instancesQuarantined, runsFailed };
  }

  async runFixture(input: WriterSandboxFixtureInput): Promise<WriterSandboxFixtureResult> {
    if (input.run.workflow !== "sandbox-fixture") {
      throw new Error("Writer sandbox boundary accepts only the explicit sandbox-fixture workflow");
    }
    if (input.run.status !== "queued") throw new Error("Writer sandbox fixture run must be queued");
    const result = await this.runInternalWorkload({
      allowedWorkflow: "sandbox-fixture",
      run: input.run,
      project: input.project,
      repositoryPath: input.repositoryPath,
      contextPath: input.contextPath,
      artifacts: input.artifacts,
      prepareContext: async () => undefined,
      execute: (handle) => this.options.provider.execute(handle, input.command),
      completion: "completed",
      baseRef: input.baseRef,
    }, {
      boundary: "contract-fixture-only",
      runningStage: "sandbox_fixture_running",
      failedStage: "sandbox_fixture_failed",
      completedStage: "sandbox_fixture_completed",
      completedMetadataKey: "sandboxFixtureCompleted",
    });
    return {
      runId: result.runId,
      workspaceId: result.workspaceId,
      fencingToken: result.fencingToken,
      baseCommit: result.baseCommit,
      branchName: result.branchName,
      command: result.execution,
      exports: result.exports,
      artifacts: result.artifacts,
    };
  }

  /**
   * Runs one host-allowlisted workload through the same fenced M4 boundary.
   * This is an in-process composition seam, not an HTTP/MCP or arbitrary exec
   * contract. Its hooks must be closed over reviewed host configuration only.
   */
  async runWorkload(input: WriterSandboxWorkloadInput): Promise<WriterSandboxWorkloadResult> {
    return this.runInternalWorkload(input, {
      boundary: "trusted-internal-workload",
      runningStage: "writer_workload_running",
      failedStage: "writer_workload_failed",
      completedStage: "writer_workload_completed",
      completedMetadataKey: "writerWorkloadCompleted",
    });
  }

  /**
   * Re-opens the control-plane-owned governed exports without exposing their
   * host paths to the runtime coordinator. Used immediately before a bound
   * approval and during restart reconciliation.
   */
  verifyGovernedArtifacts(
    runId: string,
    expected: readonly Readonly<GovernedArtifactVerificationEntry>[],
  ): WriterSandboxValidatedExport[] {
    return verifyGovernedArtifactExports(expected, {
      artifactRoot: this.options.artifactRoot,
      runId,
    });
  }

  /** Returns only approval-bound UTF-8 bytes, never a host filesystem path. */
  readGovernedArtifact(
    runId: string,
    expected: Readonly<GovernedArtifactVerificationEntry>,
  ) {
    return readGovernedArtifactExport(expected, {
      artifactRoot: this.options.artifactRoot,
      runId,
    });
  }

  private async runInternalWorkload(
    input: WriterSandboxWorkloadInput,
    lifecycle: WriterSandboxLifecycleLabels,
  ): Promise<WriterSandboxWorkloadResult> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.allowedWorkflow)) {
      throw new Error("Writer sandbox workload allowlist entry is invalid");
    }
    if (input.run.workflow !== input.allowedWorkflow) {
      throw new Error("Writer sandbox boundary rejected a run outside the exact workload allowlist");
    }
    if (input.run.status !== "queued") throw new Error("Writer sandbox workload run must be queued");
    if (input.run.projectId !== input.project.id) throw new Error("Writer sandbox project/run ownership mismatch");
    const persistedRun = await this.options.store.getRun(input.run.id);
    if (!persistedRun || persistedRun.workspaceId) throw new Error("Writer sandbox run must be persisted without a workspace");
    if (
      persistedRun.status !== "queued"
      || persistedRun.workflow !== input.allowedWorkflow
      || persistedRun.projectId !== input.project.id
      || persistedRun.rootRuntime !== input.run.rootRuntime
    ) {
      throw new Error("Persisted writer sandbox run does not match the queued workload contract");
    }
    const preflight = await this.options.provider.preflight();
    if (!preflight.enabled || !preflight.available) {
      throw new Error(`Writer sandbox provider is unavailable: ${preflight.reason ?? "preflight failed"}`);
    }

    let prepared: (PreparedWriterWorkspace & { persistedLease: WorkspaceLease }) | undefined;
    let handle: OciSandboxHandle | undefined;
    let supervisor: WriterLeaseSupervisor | undefined;
    let leaseLostReason: string | null = null;
    let cleanupProven = false;
    let filesystemRemoved = false;
    let leaseReleased = false;
    let startAttempted = false;
    let quarantinePersisted = false;
    let cleanupFreezePersisted = false;
    let sandboxInstanceCreated = false;

    try {
      prepared = await this.options.workspaces.create({
        runId: persistedRun.id,
        project: input.project,
        repositoryPath: input.repositoryPath,
        ownerId: this.options.ownerId,
        baseRef: input.baseRef,
      });
      const lease = prepared.persistedLease;
      const sandboxContract = this.options.provider.contract();
      const binding: Readonly<WriterSandboxWorkloadBinding> = Object.freeze({
        runId: input.run.id,
        projectId: input.project.id,
        workflow: input.allowedWorkflow,
        workspaceId: prepared.workspaceId,
        leaseOwnerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        baseCommit: prepared.baseCommit,
        branchName: prepared.branchName,
        workspaceProvider: prepared.workspace.provider,
        sandboxContract: Object.freeze({ ...sandboxContract }),
      });
      // Supervision begins as soon as the durable lease and immutable provider
      // policy are available. Context preparation is therefore fenced too; a
      // slow hook cannot silently outlive its writer ownership.
      supervisor = new WriterLeaseSupervisor({
        store: this.options.store,
        lease,
        leaseTtlMs: this.leaseTtlMs,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        now: this.clock,
        onLeaseLost: async (reason) => {
          leaseLostReason ??= reason;
          if (handle && handle.status !== "cleaned" && handle.status !== "quarantined") {
            const stopped = await this.options.provider.stop(handle);
            if (stopped.status === "quarantined") leaseLostReason = `lease_lost_${stopped.reason.toLowerCase()}`;
          }
          quarantinePersisted = await this.quarantine(lease, `lease_supervisor_${leaseLostReason}`);
        },
      });
      supervisor.start();
      await supervisor.pulse();
      supervisor.assertHealthy();
      assertArtifactRootDisjoint(this.options.artifactRoot, prepared.runRoot, input.contextPath);
      // The trusted hook receives ownership/policy facts but no host paths. Its
      // caller owns the fixed context root and may bind a launch manifest to the
      // real workspace/fence only at this point in the lifecycle.
      await input.prepareContext(binding);
      await supervisor.pulse();
      supervisor.assertHealthy();
      assertArtifactRootDisjoint(this.options.artifactRoot, prepared.runRoot, input.contextPath);
      const sandboxCreatedAt = this.clock().toISOString();
      const contextContentHash = checksumContextDirectory(input.contextPath);
      await this.options.store.createSandboxInstance({
        runId: input.run.id,
        workspaceId: prepared.workspaceId,
        leaseOwnerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        provider: sandboxContract.provider,
        imageRef: sandboxContract.imageRef,
        policyHash: sandboxContract.policyHash,
        workspaceDigest: sha(realpathSync(prepared.runRoot)),
        contextDigest: sha(realpathSync(input.contextPath)),
        contextContentHash,
        workdirDigest: sha("worktree"),
        createdAt: sandboxCreatedAt,
        updatedAt: sandboxCreatedAt,
      });
      sandboxInstanceCreated = true;
      await this.options.store.updateRun(input.run.id, {
        status: "running",
        stage: "sandbox_starting",
        startedAt: this.clock().toISOString(),
        metadata: {
          ...persistedRun.metadata,
          sandboxBoundary: lifecycle.boundary,
          sandboxLiveVerified: false,
          workspaceProvider: prepared.workspace.provider,
          workspaceBaseCommit: prepared.baseCommit,
          workspaceBranch: prepared.branchName,
          writerLeaseOwnerId: lease.ownerId,
          writerLeaseFencingToken: lease.fencingToken,
        },
      });

      startAttempted = true;
      handle = await this.options.provider.start({
        runId: input.run.id,
        workspaceId: prepared.workspaceId,
        leaseOwnerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        workspacePath: prepared.runRoot,
        contextPath: input.contextPath,
        workingDirectoryRelativePath: "worktree",
      });
      await this.transitionSandbox(lease, "provisioning", "ready", handle.containerId);
      await this.transitionSandbox(lease, "ready", "running");
      // A lease can be lost while provider.start() is in flight. The returned
      // handle remains non-executable until this post-start fence check. The
      // shared catch path then stops/cleans a late handle when ownership is
      // still provable, while never releasing or mutating a successor fence.
      await supervisor.pulse();
      supervisor.assertHealthy();
      await this.options.store.updateRun(input.run.id, { stage: lifecycle.runningStage });

      const execution = await input.execute(handle, binding);
      await supervisor.pulse();
      supervisor.assertHealthy();
      if (checksumContextDirectory(input.contextPath) !== contextContentHash) {
        throw new WriterSandboxQuarantinedError("context_integrity_changed");
      }
      await this.transitionSandbox(lease, "running", "freezing");

      const stopped = await this.options.provider.stop(handle);
      if (stopped.status === "quarantined") {
        throw new WriterSandboxQuarantinedError(`container_${stopped.reason.toLowerCase()}`);
      }
      await supervisor.stop();
      cleanupFreezePersisted = await this.claimFilesystemCleanup(lease);
      if (!cleanupFreezePersisted) throw new Error("Writer lease changed before export could be frozen");
      await this.transitionSandbox(lease, "freezing", "exporting");
      const exports = exportGovernedArtifacts(input.artifacts, {
        workspacePath: prepared.worktreePath,
        artifactRoot: this.options.artifactRoot,
        runId: input.run.id,
      });
      if (input.validateExports) {
        const validationView = Object.freeze(exports.map((item) => Object.freeze({
          relativePath: item.sourceRelativePath,
          kind: item.kind,
          mediaType: item.mediaType,
          checksum: item.checksum,
          sizeBytes: item.sizeBytes,
        })));
        try {
          await input.validateExports(validationView);
        } catch {
          // A stopped workspace differing from the bytes accepted during native
          // execution is an integrity event. Preserve its exact lease/worktree
          // under quarantine; never persist or approve the divergent exports.
          throw new WriterSandboxQuarantinedError("export_validation_failed");
        }
      }
      const createdAt = lease.acquiredAt;
      const artifacts: Artifact[] = exports.map((item) => ({
        id: `artifact_sandbox_${sha(`${input.run.id}\0${item.sourceRelativePath}\0${item.checksum}`).slice(0, 32)}`,
        runId: input.run.id,
        kind: item.kind,
        uri: `artifact://runs/${encodeURIComponent(input.run.id)}/${item.sourceRelativePath.split("/").map(encodeURIComponent).join("/")}`,
        checksum: item.checksum,
        mediaType: item.mediaType,
        createdAt,
      }));
      try {
        await this.options.store.createArtifactBatch(artifacts);
      } catch {
        throw new WriterSandboxQuarantinedError("artifact_persistence_uncertain");
      }

      const cleanup = await this.options.provider.cleanup(handle);
      if (cleanup.status === "quarantined") {
        throw new WriterSandboxQuarantinedError(`container_${cleanup.reason.toLowerCase()}`);
      }
      cleanupProven = true;
      await this.options.workspaces.removeFilesystem(prepared, fence(lease));
      filesystemRemoved = true;
      leaseReleased = await this.options.store.releaseWorkspaceLease(fence(lease));
      if (!leaseReleased) throw new Error("Writer lease changed before terminal release");
      cleanupFreezePersisted = false;
      await this.transitionSandbox(lease, "exporting", "cleaned");

      const refreshed = await this.options.store.getRun(input.run.id) ?? input.run;
      const successMetadata = lifecycle.boundary === "contract-fixture-only"
        ? {
            ...refreshed.metadata,
            sandboxFixtureCompleted: true,
            artifactCount: artifacts.length,
            containerCleaned: true,
            writerWorkspaceRemoved: true,
          }
        : {
            ...refreshed.metadata,
            [lifecycle.completedMetadataKey]: input.completion === "completed",
            sandboxEvidenceReady: input.completion === "evidence_ready",
            artifactCount: artifacts.length,
            containerCleaned: true,
            writerWorkspaceRemoved: true,
            writerLeaseReleased: true,
          };
      if (input.completion === "evidence_ready") {
        await this.options.store.updateRun(input.run.id, {
          status: "running",
          stage: "evidence_ready",
          completedAt: null,
          nextActionAt: null,
          metadata: successMetadata,
        });
      } else {
        await this.options.store.updateRun(input.run.id, {
          status: "completed",
          stage: lifecycle.completedStage,
          completedAt: this.clock().toISOString(),
          nextActionAt: null,
          metadata: successMetadata,
        });
      }
      return {
        runId: input.run.id,
        workspaceId: prepared.workspaceId,
        fencingToken: lease.fencingToken,
        baseCommit: prepared.baseCommit,
        branchName: prepared.branchName,
        execution,
        exports,
        artifacts,
        completion: input.completion,
      };
    } catch (error) {
      if (supervisor) await supervisor.stop().catch(() => undefined);
      if (prepared && !startAttempted) cleanupProven = true;
      let quarantineReason: string | null = leaseLostReason;
      if (error instanceof ArtifactSecretDetectedError) quarantineReason ??= "artifact_secret_detected";
      if (error instanceof WriterSandboxQuarantinedError) quarantineReason ??= error.reason;
      if (prepared && startAttempted && !handle) quarantineReason ??= "container_start_ownership_uncertain";

      if (handle && !cleanupProven && handle.status !== "quarantined" && handle.status !== "cleaned") {
        try {
          const stopped = await this.options.provider.stop(handle);
          if (stopped.status === "quarantined") quarantineReason ??= `container_${stopped.reason.toLowerCase()}`;
          else {
            const cleanup = await this.options.provider.cleanup(handle);
            if (cleanup.status === "cleaned") cleanupProven = true;
            else quarantineReason ??= `container_${cleanup.reason.toLowerCase()}`;
          }
        } catch {
          quarantineReason ??= "container_cleanup_error";
        }
      }

      if (prepared) {
        const lease = prepared.persistedLease;
        if (quarantineReason) {
          if (cleanupFreezePersisted || quarantinePersisted) quarantinePersisted = true;
          else quarantinePersisted = await this.quarantine(lease, quarantineReason).catch(() => false);
        } else if (cleanupProven && !filesystemRemoved) {
          if (!cleanupFreezePersisted) {
            cleanupFreezePersisted = await this.claimFilesystemCleanup(lease).catch(() => false);
          }
          if (!cleanupFreezePersisted) {
            quarantineReason = "workspace_cleanup_claim_error";
          } else {
            try {
              await this.options.workspaces.removeFilesystem(prepared, fence(lease));
              filesystemRemoved = true;
            } catch {
              quarantineReason = "workspace_cleanup_error";
              quarantinePersisted = true;
            }
          }
        }
        if (!quarantineReason && filesystemRemoved && !leaseReleased) {
          leaseReleased = await this.options.store.releaseWorkspaceLease(fence(lease)).catch(() => false);
          if (leaseReleased) cleanupFreezePersisted = false;
          if (!leaseReleased) {
            quarantineReason = "lease_release_error_after_cleanup";
            quarantinePersisted = cleanupFreezePersisted
              || await this.quarantine(lease, quarantineReason).catch(() => false);
          }
        }
        if (cleanupFreezePersisted && quarantineReason) quarantinePersisted = true;
        if (sandboxInstanceCreated) {
          const instance = await this.options.store.getSandboxInstance(input.run.id);
          if (instance && !["cleaned", "quarantined"].includes(instance.state)) {
            const transitionAt = this.clock().toISOString();
            const transitioned = await this.options.store.transitionSandboxInstance({
              ...fence(lease),
              expectedState: instance.state,
              state: "quarantined",
              updatedAt: transitionAt,
              ...(startAttempted ? { cleanupAttemptedAt: transitionAt } : {}),
              quarantineReason: quarantineReason ?? safeFailureCode(error).toLowerCase(),
            });
            if (!transitioned) throw new Error("Sandbox instance changed before failure quarantine");
          }
        }
      }

      const current = await this.options.store.getRun(input.run.id);
      if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
        await this.options.store.updateRun(input.run.id, {
          status: "failed",
          stage: quarantinePersisted ? "workspace_quarantined" : lifecycle.failedStage,
          completedAt: this.clock().toISOString(),
          nextActionAt: null,
          metadata: {
            ...current.metadata,
            sandboxFailureCode: safeFailureCode(error),
            sandboxQuarantineReason: quarantinePersisted ? quarantineReason : null,
            sandboxIsolationReason: quarantineReason,
            containerCleanupProven: cleanupProven,
            writerWorkspaceRemoved: filesystemRemoved,
          },
        });
      }
      if (quarantinePersisted && !(error instanceof WriterSandboxQuarantinedError)) {
        throw new WriterSandboxQuarantinedError(quarantineReason ?? "writer_sandbox_quarantined");
      }
      if (!quarantinePersisted && error instanceof WriterSandboxQuarantinedError) {
        throw new Error("Writer sandbox failed but its current lease fence could not be quarantined");
      }
      throw error;
    }
  }

  private async quarantine(lease: WorkspaceLease, reason: string): Promise<boolean> {
    const quarantined = await this.options.store.quarantineWorkspaceLease({
      ...fence(lease),
      quarantinedAt: this.clock().toISOString(),
      reason,
    });
    return quarantined !== null;
  }

  private claimFilesystemCleanup(lease: WorkspaceLease): Promise<boolean> {
    return this.quarantine(lease, WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON);
  }

  private async transitionSandbox(
    lease: WorkspaceLease,
    expectedState: SandboxInstanceState,
    state: SandboxInstanceState,
    engineId?: string,
  ): Promise<void> {
    const transitioned = await this.options.store.transitionSandboxInstance({
      ...fence(lease),
      expectedState,
      state,
      updatedAt: this.clock().toISOString(),
      ...(engineId ? { engineId } : {}),
    });
    if (!transitioned) throw new Error(`Sandbox instance lost its ${expectedState} -> ${state} transition`);
  }
}
