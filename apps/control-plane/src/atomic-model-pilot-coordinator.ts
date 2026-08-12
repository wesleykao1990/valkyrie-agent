import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AtomicRpcClient } from "./atomic-rpc-client.ts";
import { copyReviewedAtomicPackage } from "./atomic-fixture-pilot.ts";
import {
  prepareAtomicModelPilotContext,
  revokeAtomicModelPilotCapability,
  type PreparedAtomicModelPilotContext,
} from "./atomic-model-pilot-prelive.ts";
import { executeAtomicFixtureModelWorkflow, type AtomicModelWorkflowExecution } from "./atomic-model-workflow-executor.ts";
import {
  assertAtomicModelFrozenExports,
  validateAtomicModelPilotEvidence,
  type AtomicModelEvidenceSnapshot,
} from "./atomic-model-pilot-evidence.ts";
import type { ScopedInferencePolicy } from "./scoped-inference-gateway.ts";
import type { ControlPlaneStore } from "./store.ts";
import type { ArtifactManifestEntry } from "./governed-artifact-export.ts";
import type { OciRunResult, OciSandboxHandle } from "./oci-sandbox-provider.ts";
import type { Project, Run } from "./types.ts";
import type { ScopedInferenceBridge, ScopedInferenceBridgeHandle } from "./scoped-inference-bridge.ts";
import {
  WriterSandboxBoundary,
  type WriterSandboxProvider,
  type WriterSandboxWorkloadBinding,
  type WriterSandboxWorkloadResult,
} from "./writer-sandbox-boundary.ts";
import {
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
} from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";
import {
  ATOMIC_FIXTURE_MODEL_REQUEST,
  ATOMIC_FIXTURE_MODEL_WORKFLOW_VERSION,
} from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

export const ATOMIC_MODEL_PILOT_WORKFLOW = "atomic-fixture-model-pilot";
export const ATOMIC_MODEL_PILOT_APPROVAL_ACTION = "accept_atomic_fixture_model_result";
export const ATOMIC_MODEL_PILOT_APPROVAL_EFFECT =
  "Record an evidence-bound safe mock receipt in the control-plane ledger only. Do not create a PR, access GitHub, merge, deploy, change an external or product database, expand credential access, or promote memory.";

export const ATOMIC_MODEL_PILOT_ARTIFACTS: readonly ArtifactManifestEntry[] = Object.freeze([
  ["evidence.json", "atomic-model-pilot-evidence", "application/json"],
  ["candidate.patch", "candidate-patch", "text/x-diff"],
  ["checks-initial.json", "deterministic-checks-initial", "application/json"],
  ["verifier-initial.json", "fresh-model-verifier-initial", "application/json"],
  ["checks-final.json", "deterministic-checks-final", "application/json"],
  ["verifier-final.json", "fresh-model-verifier-final", "application/json"],
  ["memory-proposal.json", "memory-proposal-draft", "application/json"],
  ["draft-pr-mock.json", "draft-pr-mock", "application/json"],
  ["context-pack.json", "project-brain-context-pack", "application/json"],
  ["run-contract.json", "run-contract", "application/json"],
  ["atomic-model-launch-manifest.json", "atomic-model-launch-manifest", "application/json"],
].map(([name, kind, mediaType]) => ({ relativePath: `.valkyrie-model-output/${name}`, kind, mediaType })));

interface ModelRpcProvider extends WriterSandboxProvider {
  preflightAtomicRunner?(): Promise<{
    enabled: boolean;
    available: boolean;
    atomicVersion?: string;
    imageRef?: string;
    imageDigest?: string;
    provenanceDigest?: string;
    provenanceLabels?: Readonly<Record<string, string>>;
    reason?: string;
  }>;
  openAtomicRpc(handle: OciSandboxHandle): Promise<AtomicRpcClient>;
}

export interface AtomicModelPilotCoordinatorOptions {
  store: ControlPlaneStore;
  boundary: WriterSandboxBoundary;
  provider: ModelRpcProvider;
  packageDir: string;
  repositoryPath: string;
  repositoryCommit: string;
  contextRoot: string;
  policy: ScopedInferencePolicy;
  gatewayBaseUrl: string;
  acceptedPackageSha256: string;
  acceptedImageDigest: string;
  maxCostUsd: number;
  liveProviderExpected?: boolean;
  bridge: Pick<ScopedInferenceBridge, "start" | "stop">;
  now?: () => Date;
}

export interface AtomicModelPilotResult {
  boundary: WriterSandboxWorkloadResult;
  native: AtomicModelWorkflowExecution;
  capabilityId: string;
  liveProviderVerified: boolean;
}

export interface AtomicModelPilotPreflight {
  enabled: true;
  available: boolean;
  workflow: typeof ATOMIC_MODEL_PILOT_WORKFLOW;
  executionMode: "isolated-writer";
  modelExecutionAttempted: false;
  liveProviderExpected: boolean;
  reason?: string;
  runner?: Awaited<ReturnType<NonNullable<ModelRpcProvider["preflightAtomicRunner"]>>>;
}

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

/** Coordinates the literal disposable model fixture through scoped inference. */
export class AtomicModelPilotCoordinator {
  private active = false;
  private readonly clock: () => Date;
  private readonly options: AtomicModelPilotCoordinatorOptions;

  constructor(options: AtomicModelPilotCoordinatorOptions) {
    this.clock = options.now ?? (() => new Date());
    if (!resolve(options.packageDir).startsWith("/") || !resolve(options.repositoryPath).startsWith("/")
        || !resolve(options.contextRoot).startsWith("/")) throw new Error("Atomic model coordinator paths must be absolute");
    if (!/^[a-f0-9]{40,64}$/.test(options.repositoryCommit)) throw new Error("Atomic model coordinator requires an exact fixture commit");
    const contextRoot = resolve(options.contextRoot);
    const contextStat = lstatSync(contextRoot);
    if (!contextStat.isDirectory() || contextStat.isSymbolicLink()
        || (process.platform !== "win32" && (contextStat.mode & 0o077) !== 0)) {
      throw new Error("Atomic model coordinator context root must be canonical, private, and non-symlinked");
    }
    this.options = { ...options, liveProviderExpected: options.liveProviderExpected ?? false, contextRoot: realpathSync(contextRoot) };
  }

  async preflight(): Promise<AtomicModelPilotPreflight> {
    try {
      if (!this.options.provider.preflightAtomicRunner) {
        throw new Error("Atomic model runner preflight is unavailable");
      }
      const runner = await this.options.provider.preflightAtomicRunner();
      if (!runner.enabled || !runner.available || runner.imageDigest !== this.options.acceptedImageDigest
          || !runner.atomicVersion || !runner.provenanceDigest || !runner.provenanceLabels) {
        return {
          enabled: true,
          available: false,
          workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
          executionMode: "isolated-writer",
          modelExecutionAttempted: false,
          liveProviderExpected: this.options.liveProviderExpected ?? false,
          runner,
          reason: runner.reason ?? "Atomic model runner evidence did not match the accepted deployment",
        };
      }
      return {
        enabled: true,
        available: true,
        workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
        executionMode: "isolated-writer",
        modelExecutionAttempted: false,
        liveProviderExpected: this.options.liveProviderExpected ?? false,
        runner,
        reason: `Verified credential-isolated Atomic ${runner.atomicVersion} runner ${runner.imageDigest}; preflight made no provider request`,
      };
    } catch (error) {
      return {
        enabled: true,
        available: false,
        workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
        executionMode: "isolated-writer",
        modelExecutionAttempted: false,
        liveProviderExpected: this.options.liveProviderExpected ?? false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  contextExists(runId: string): boolean {
    return existsSync(resolve(this.options.contextRoot, sha(runId)));
  }

  cleanupContext(runId: string): void {
    const contextPath = resolve(this.options.contextRoot, sha(runId));
    if (!existsSync(contextPath)) return;
    const root = realpathSync(this.options.contextRoot);
    const real = realpathSync(contextPath);
    const marker = join(real, ".valkyrie-run-id");
    const item = lstatSync(marker);
    if (!real.startsWith(`${root}/`) || !item.isFile() || item.isSymbolicLink()
        || readFileSync(marker, "utf8") !== `${runId}\n`) {
      throw new Error("Atomic model context cleanup ownership could not be proven");
    }
    rmSync(real, { recursive: true });
  }

  async run(input: { run: Run; project: Project; taskId: string; contextPack: Record<string, unknown>; signal: AbortSignal }): Promise<AtomicModelPilotResult> {
    if (this.active) throw new Error("Atomic model pilot permits exactly one active local coordinator");
    if (input.run.rootRuntime !== "atomic" || input.run.workflow !== ATOMIC_MODEL_PILOT_WORKFLOW
        || input.run.status !== "queued" || input.run.projectId !== input.project.id
        || input.run.taskId !== input.taskId || input.run.budgetUsd > this.options.maxCostUsd) {
      throw new Error("Atomic model pilot run does not match the fixed queued contract");
    }
    this.active = true;
    const contextPath = resolve(this.options.contextRoot, sha(input.run.id));
    let prepared: PreparedAtomicModelPilotContext | undefined;
    let native: AtomicModelWorkflowExecution | undefined;
    let evidenceSnapshot: AtomicModelEvidenceSnapshot | undefined;
    let bridge: ScopedInferenceBridgeHandle | undefined;
    try {
      if (existsSync(contextPath)) throw new Error("Atomic model run context already exists");
      mkdirSync(contextPath, { recursive: true, mode: 0o700 });
      writeFileSync(join(contextPath, ".valkyrie-run-id"), `${input.run.id}\n`, { flag: "wx", mode: 0o600 });
      const result = await this.options.boundary.runWorkload({
        allowedWorkflow: ATOMIC_MODEL_PILOT_WORKFLOW,
        run: input.run,
        project: input.project,
        repositoryPath: this.options.repositoryPath,
        contextPath,
        artifacts: ATOMIC_MODEL_PILOT_ARTIFACTS,
        baseRef: this.options.repositoryCommit,
        completion: "evidence_ready",
        validateExports: async (exports) => {
          if (!evidenceSnapshot) throw new Error("Atomic model frozen export validation has no accepted workspace snapshot");
          assertAtomicModelFrozenExports(evidenceSnapshot, exports);
          if (!prepared || !native) throw new Error("Atomic model export validation lost its native execution binding");
          const current = await this.options.store.getRun(input.run.id);
          if (!current) throw new Error("Atomic model run disappeared before frozen export validation");
          const normalize = (items: readonly {
            relativePath: string;
            kind: string;
            mediaType: string;
            checksum: string;
            sizeBytes: number;
          }[]) => items.map((item) => ({
            relativePath: item.relativePath,
            kind: item.kind,
            mediaType: item.mediaType,
            checksum: item.checksum,
            sizeBytes: item.sizeBytes,
          })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
          await this.options.store.updateRun(current.id, { metadata: {
            ...current.metadata,
            atomicModelFrozenExportsValidated: true,
            atomicModelValidatedWorkspaceArtifacts: normalize(evidenceSnapshot.artifacts),
            atomicModelFrozenExportArtifacts: normalize(exports),
            atomicModelCapabilityId: prepared.capability.id,
            atomicModelPolicySha256: prepared.capability.policyHash,
            nativeSessionId: native.nativeSessionId,
            nativeWorkflowRunId: native.nativeWorkflowRunId,
            nativeCursor: native.nativeCursor,
            repairCount: native.output.repair_count,
            nativeInputTokens: evidenceSnapshot.totalInputTokens,
            nativeOutputTokens: evidenceSnapshot.totalOutputTokens,
            nativeCostMicros: evidenceSnapshot.totalCostMicros,
            liveProviderVerified: this.options.liveProviderExpected,
          } });
        },
        prepareContext: async (binding: Readonly<WriterSandboxWorkloadBinding>) => {
          if (binding.baseCommit !== this.options.repositoryCommit) {
            throw new Error("Atomic model workspace is not pinned to the reviewed fixture commit");
          }
          const boundImageDigest = binding.sandboxContract.imageRef.slice(binding.sandboxContract.imageRef.lastIndexOf("@") + 1);
          if (boundImageDigest !== this.options.acceptedImageDigest) {
            throw new Error("Atomic model sandbox is not using the accepted immutable runner image");
          }
          const packageCopy = copyReviewedAtomicPackage(this.options.packageDir, join(contextPath, "atomic-package"));
          if (packageCopy.digest !== this.options.acceptedPackageSha256) throw new Error("Staged Atomic package does not match the accepted digest");
          const lease = await this.options.store.getWorkspaceLease(binding.workspaceId);
          if (!lease || lease.ownerId !== binding.leaseOwnerId || lease.fencingToken !== binding.fencingToken) {
            throw new Error("Atomic model writer lease changed before capability issuance");
          }
          const workflow = readFileSync(join(contextPath, "atomic-package/workflows/atomic-fixture-model-pilot.ts"));
          const core = readFileSync(join(contextPath, "atomic-package/lib/atomic-fixture-model-pilot-core.mjs"));
          prepared = await prepareAtomicModelPilotContext({
            store: this.options.store, contextPath, binding, taskId: input.taskId,
            request: ATOMIC_FIXTURE_MODEL_REQUEST, policy: this.options.policy,
            gatewayBaseUrl: this.options.gatewayBaseUrl, packageSha256: packageCopy.digest,
            workflowVersion: ATOMIC_FIXTURE_MODEL_WORKFLOW_VERSION, workflowSha256: sha(workflow), coreSha256: sha(core),
            imageDigest: this.options.acceptedImageDigest, acceptedPackageSha256: this.options.acceptedPackageSha256,
            acceptedImageDigest: this.options.acceptedImageDigest, leaseExpiresAt: lease.expiresAt,
            maxCostUsd: this.options.maxCostUsd, approvalEffect: ATOMIC_MODEL_PILOT_APPROVAL_EFFECT,
            liveProviderExpected: this.options.liveProviderExpected ?? false,
            contextPack: input.contextPack, now: this.clock,
          });
          const current = await this.options.store.getRun(input.run.id);
          if (!current) throw new Error("Atomic model run disappeared after capability issuance");
          await this.options.store.updateRun(current.id, { metadata: {
            ...current.metadata,
            atomicModelCapabilityId: prepared.capability.id,
            atomicModelPolicySha256: prepared.capability.policyHash,
            atomicModelContextPrepared: true,
            crossProcessResume: false,
            externalActionPerformed: false,
          } });
          bridge = await this.options.bridge.start(input.run.id);
        },
        execute: async (handle): Promise<OciRunResult> => {
          if (!prepared) throw new Error("Atomic model context was not prepared before execution");
          const client = await this.options.provider.openAtomicRpc(handle);
          try {
            native = await executeAtomicFixtureModelWorkflow({
              client,
              inputs: {
                control_plane_run_id: input.run.id,
                contract_sha256: prepared.runContractSha256,
                expected_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
                capability_policy_sha256: prepared.capability.policyHash,
                package_sha256: this.options.acceptedPackageSha256,
                live_provider_expected: this.options.liveProviderExpected ?? false,
              },
              signal: input.signal,
              onRecord: async (record, ordinal) => {
                const rawJson = JSON.stringify(record);
                if (/vki_[A-Za-z0-9_-]{43}/u.test(rawJson)) {
                  throw new Error("Atomic native record contained forbidden capability material");
                }
                await this.options.store.appendEvent({
                  id: `event_atomic_model_raw_${sha(`${input.run.id}\0${ordinal}\0${rawJson}`).slice(0, 32)}`,
                  runId: input.run.id,
                  type: "atomic.native.raw",
                  message: "Preserved one bounded native Atomic model-workflow record",
                  payload: {
                    ordinal,
                    rawNative: record,
                    providerExecutionMode: this.options.liveProviderExpected ? "live_scoped_gateway" : "credential_free_fixture",
                    liveProviderVerified: false,
                  },
                  createdAt: this.clock().toISOString(),
                });
              },
            });
            evidenceSnapshot = await validateAtomicModelPilotEvidence({
              store: this.options.store,
              runId: input.run.id,
              handle,
              contextPath,
              capabilityId: prepared.capability.id,
              native,
              liveProviderExpected: this.options.liveProviderExpected ?? false,
            });
            const summary = "Atomic model workflow produced bounded provider-backed evidence\n";
            return { exitCode: 0, stdout: summary, stderr: "", stdoutBytes: Buffer.byteLength(summary), stderrBytes: 0 };
          } finally { await client.stop().catch(() => undefined); }
        },
      });
      if (!prepared || !native) throw new Error("Atomic model pilot ended without capability or native evidence");
      if (result.baseCommit !== this.options.repositoryCommit) throw new Error("Atomic model pilot returned an unexpected base commit");
      const refreshed = await this.options.store.getRun(input.run.id);
      if (refreshed) await this.options.store.updateRun(refreshed.id, { metadata: {
        ...refreshed.metadata,
        atomicModelPilotMode: this.options.liveProviderExpected ? "live_scoped_gateway" : "credential_free_fixture",
        modelExecutionAttempted: true,
        atomicModelCapabilityId: prepared.capability.id,
        atomicModelPolicySha256: prepared.capability.policyHash,
        nativeSessionId: native.nativeSessionId,
        nativeWorkflowRunId: native.nativeWorkflowRunId,
        nativeCursor: native.nativeCursor,
        repairCount: native.output.repair_count,
        nativeInputTokens: evidenceSnapshot?.totalInputTokens,
        nativeOutputTokens: evidenceSnapshot?.totalOutputTokens,
        nativeCostMicros: evidenceSnapshot?.totalCostMicros,
        liveProviderVerified: this.options.liveProviderExpected,
      } });
      return { boundary: result, native, capabilityId: prepared.capability.id, liveProviderVerified: this.options.liveProviderExpected ?? false };
    } finally {
      const cleanupErrors: unknown[] = [];
      if (bridge) try { await this.options.bridge.stop(bridge); } catch (error) { cleanupErrors.push(error); }
      if (prepared) try {
        await revokeAtomicModelPilotCapability(this.options.store, prepared.capability.id, this.clock().toISOString());
      } catch (error) { cleanupErrors.push(error); }
      if (existsSync(contextPath)) try { this.cleanupContext(input.run.id); }
        catch (error) { cleanupErrors.push(error); }
      this.active = false;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Atomic model pilot cleanup was not fully proven");
    }
  }
}
