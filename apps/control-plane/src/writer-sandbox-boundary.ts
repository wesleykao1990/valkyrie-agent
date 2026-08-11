import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { Artifact, Project, Run } from "./types.ts";
import type { ControlPlaneStore, WorkspaceLease } from "./store.ts";
import {
  ArtifactSecretDetectedError,
  exportGovernedArtifacts,
  type ArtifactManifestEntry,
  type GovernedArtifactExport,
} from "./governed-artifact-export.ts";
import type {
  OciCleanupResult,
  OciPreflightResult,
  OciRunResult,
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
  preflight(): Promise<OciPreflightResult>;
  start(input: OciSandboxStartInput): Promise<OciSandboxHandle>;
  execute(handle: OciSandboxHandle, command: readonly string[]): Promise<OciRunResult>;
  stop(handle: OciSandboxHandle): Promise<OciCleanupResult | { status: "stopped" }>;
  cleanup(handle: OciSandboxHandle): Promise<OciCleanupResult>;
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

  async runFixture(input: WriterSandboxFixtureInput): Promise<WriterSandboxFixtureResult> {
    if (input.run.workflow !== "sandbox-fixture") {
      throw new Error("Writer sandbox boundary accepts only the explicit sandbox-fixture workflow");
    }
    if (input.run.status !== "queued") throw new Error("Writer sandbox fixture run must be queued");
    if (input.run.projectId !== input.project.id) throw new Error("Writer sandbox project/run ownership mismatch");
    const persistedRun = await this.options.store.getRun(input.run.id);
    if (!persistedRun || persistedRun.workspaceId) throw new Error("Writer sandbox run must be persisted without a workspace");
    if (
      persistedRun.status !== "queued"
      || persistedRun.workflow !== "sandbox-fixture"
      || persistedRun.projectId !== input.project.id
      || persistedRun.rootRuntime !== input.run.rootRuntime
    ) {
      throw new Error("Persisted writer sandbox run does not match the queued fixture contract");
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

    try {
      prepared = await this.options.workspaces.create({
        runId: persistedRun.id,
        project: input.project,
        repositoryPath: input.repositoryPath,
        ownerId: this.options.ownerId,
        baseRef: input.baseRef,
      });
      const lease = prepared.persistedLease;
      // Supervision begins at the durable lease boundary, before any other
      // storage or provider operation. Provider startup is bounded but may be
      // slower than the lease TTL; a late handle is checked against this same
      // original fence before it can ever execute a writer command.
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
      await this.options.store.updateRun(input.run.id, {
        status: "running",
        stage: "sandbox_starting",
        startedAt: this.clock().toISOString(),
        metadata: {
          ...persistedRun.metadata,
          sandboxBoundary: "contract-fixture-only",
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
      // A lease can be lost while provider.start() is in flight. The returned
      // handle remains non-executable until this post-start fence check. The
      // shared catch path then stops/cleans a late handle when ownership is
      // still provable, while never releasing or mutating a successor fence.
      await supervisor.pulse();
      supervisor.assertHealthy();
      await this.options.store.updateRun(input.run.id, { stage: "sandbox_fixture_running" });

      const command = await this.options.provider.execute(handle, input.command);
      await supervisor.pulse();
      supervisor.assertHealthy();

      const stopped = await this.options.provider.stop(handle);
      if (stopped.status === "quarantined") {
        throw new WriterSandboxQuarantinedError(`container_${stopped.reason.toLowerCase()}`);
      }
      await supervisor.stop();
      cleanupFreezePersisted = await this.claimFilesystemCleanup(lease);
      if (!cleanupFreezePersisted) throw new Error("Writer lease changed before export could be frozen");
      const exports = exportGovernedArtifacts(input.artifacts, {
        workspacePath: prepared.worktreePath,
        artifactRoot: this.options.artifactRoot,
        runId: input.run.id,
      });
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

      const completedAt = this.clock().toISOString();
      const refreshed = await this.options.store.getRun(input.run.id) ?? input.run;
      await this.options.store.updateRun(input.run.id, {
        status: "completed",
        stage: "sandbox_fixture_completed",
        completedAt,
        nextActionAt: null,
        metadata: {
          ...refreshed.metadata,
          sandboxFixtureCompleted: true,
          artifactCount: artifacts.length,
          containerCleaned: true,
          writerWorkspaceRemoved: true,
        },
      });
      return {
        runId: input.run.id,
        workspaceId: prepared.workspaceId,
        fencingToken: lease.fencingToken,
        baseCommit: prepared.baseCommit,
        branchName: prepared.branchName,
        command,
        exports,
        artifacts,
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
      }

      const current = await this.options.store.getRun(input.run.id);
      if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
        await this.options.store.updateRun(input.run.id, {
          status: "failed",
          stage: quarantinePersisted ? "workspace_quarantined" : "sandbox_fixture_failed",
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
}
