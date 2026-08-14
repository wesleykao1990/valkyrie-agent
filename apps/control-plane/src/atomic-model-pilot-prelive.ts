import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildAtomicModelAgentFiles, buildAtomicModelLaunchManifest } from "./atomic-model-pilot-contract.ts";
import {
  issueScopedInferenceCapability,
  type IssuedInferenceCapability,
  type ScopedInferencePolicy,
} from "./scoped-inference-gateway.ts";
import { canonicalJson, type ControlPlaneStore } from "./store.ts";
import type { WriterSandboxWorkloadBinding } from "./writer-sandbox-boundary.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Atomic model context path escaped its private root");
  }
}

function privateDirectory(path: string): string {
  const resolved = resolve(path);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const item = lstatSync(resolved);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error("Atomic model context must be a canonical non-symlink directory");
  }
  return realpathSync(resolved);
}

function writeExclusive(root: string, relativePath: string, value: string): { path: string; sha256: string } {
  const destination = resolve(root, ...relativePath.split("/"));
  contained(root, destination);
  privateDirectory(resolve(destination, ".."));
  const fd = openSync(destination, "wx", 0o600);
  try { writeFileSync(fd, value, { encoding: "utf8" }); }
  finally { closeSync(fd); }
  return { path: relativePath, sha256: hash(value) };
}

export interface AtomicModelPilotContextInput {
  store: ControlPlaneStore;
  contextPath: string;
  binding: Readonly<WriterSandboxWorkloadBinding>;
  taskId: string;
  request: string;
  policy: ScopedInferencePolicy;
  gatewayBaseUrl: string;
  packageSha256: string;
  workflowVersion: string;
  workflowSha256: string;
  coreSha256: string;
  imageDigest: string;
  acceptedPackageSha256: string;
  acceptedImageDigest: string;
  leaseExpiresAt: string;
  maxCostUsd: number;
  approvalEffect: string;
  liveProviderExpected: boolean;
  contextPack: Record<string, unknown>;
  now?: () => Date;
}

export interface PreparedAtomicModelPilotContext {
  capability: IssuedInferenceCapability["capability"];
  runContractSha256: string;
  launchManifestSha256: string;
  contextPackSha256: string;
  agentModelsSha256: string;
  agentSettingsSha256: string;
}

/**
 * Builds the only secret-bearing model-pilot context. The plaintext value is a
 * run-scoped gateway capability, never a provider credential. This function is
 * called only from WriterSandboxBoundary.prepareContext after the exact writer
 * fence exists; all resulting files are mounted read-only in the container.
 */
export async function prepareAtomicModelPilotContext(
  input: AtomicModelPilotContextInput,
): Promise<PreparedAtomicModelPilotContext> {
  if (!SAFE_ID.test(input.binding.runId) || !SAFE_ID.test(input.taskId)
      || input.binding.workflow !== "atomic-fixture-model-pilot") {
    throw new Error("Atomic model pilot context is outside the fixed workflow identity");
  }
  if (![input.packageSha256, input.workflowSha256, input.coreSha256, input.acceptedPackageSha256].every((value) => SHA.test(value))) {
    throw new Error("Atomic model pilot requires exact lowercase package/workflow/core digests");
  }
  if (input.packageSha256 !== input.acceptedPackageSha256 || input.imageDigest !== input.acceptedImageDigest) {
    throw new Error("Atomic model pilot package or runner image is not on the accepted deployment allowlist");
  }
  const contextRoot = privateDirectory(input.contextPath);
  const issued = await issueScopedInferenceCapability({
    store: input.store,
    runId: input.binding.runId,
    projectId: input.binding.projectId,
    workflow: input.binding.workflow,
    policy: input.policy,
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    const agent = buildAtomicModelAgentFiles({ gatewayBaseUrl: input.gatewayBaseUrl, policy: input.policy });
    let normalizedContextPack: Record<string, unknown>;
    try {
      normalizedContextPack = JSON.parse(JSON.stringify(input.contextPack)) as Record<string, unknown>;
    } catch {
      throw new Error("Atomic model context pack must be JSON-serializable");
    }
    const contextPack = `${canonicalJson(normalizedContextPack)}\n`;
    const contextPackFile = writeExclusive(contextRoot, "context-pack.json", contextPack);
    const runContractValue = {
      schemaVersion: "1.1.0-model",
      runId: input.binding.runId,
      projectId: input.binding.projectId,
      taskId: input.taskId,
      request: input.request,
      rootRuntime: "atomic",
      workflow: input.binding.workflow,
      finalAction: "stop_before_external_action",
      crossProcessResume: false,
      contextPack: { ref: "context-pack.json", checksum: contextPackFile.sha256 },
      atomicPackage: {
        packageSha256: input.packageSha256,
        workflowSha256: input.workflowSha256,
        coreSha256: input.coreSha256,
      },
      inference: {
        policySha256: issued.capability.policyHash,
        capabilityId: issued.capability.id,
        capabilityTokenSha256: issued.capability.tokenHash,
        credentialInWriter: false,
        fakeProvider: false,
        liveProviderExpected: input.liveProviderExpected,
        liveProviderVerified: false,
      },
      approval: { action: "accept_atomic_fixture_model_result", exactEffect: input.approvalEffect },
    };
    const runContract = `${canonicalJson(runContractValue)}\n`;
    const runContractFile = writeExclusive(contextRoot, "run-contract.json", runContract);
    const manifest = buildAtomicModelLaunchManifest({
      runId: input.binding.runId,
      projectId: input.binding.projectId,
      taskId: input.taskId,
      request: input.request,
      workflowVersion: input.workflowVersion,
      workflowSha256: input.workflowSha256,
      coreSha256: input.coreSha256,
      packageSha256: input.packageSha256,
      contextPackRef: "context-pack.json",
      contractRef: "run-contract.json",
      workspaceId: input.binding.workspaceId,
      ownerId: input.binding.leaseOwnerId,
      fencingToken: input.binding.fencingToken,
      leaseExpiresAt: input.leaseExpiresAt,
      imageDigest: input.imageDigest,
      sandboxPolicySha256: input.binding.sandboxContract.policyHash,
      capability: issued.capability,
      roleModels: input.policy.roleModels,
      maxCostUsd: input.maxCostUsd,
      approvalEffect: input.approvalEffect,
      liveProviderExpected: input.liveProviderExpected,
    });
    const launchFile = writeExclusive(contextRoot, "atomic-model-launch-manifest.json", `${canonicalJson(manifest)}\n`);
    const modelsFile = writeExclusive(contextRoot, "atomic-agent/models.json", `${agent.modelsJson}\n`);
    const settingsFile = writeExclusive(contextRoot, "atomic-agent/settings.json", `${agent.settingsJson}\n`);
    writeExclusive(contextRoot, "inference-capability", `${issued.token}\n`);
    return {
      capability: issued.capability,
      runContractSha256: runContractFile.sha256,
      launchManifestSha256: launchFile.sha256,
      contextPackSha256: contextPackFile.sha256,
      agentModelsSha256: modelsFile.sha256,
      agentSettingsSha256: settingsFile.sha256,
    };
  } catch (error) {
    await input.store.revokeInferenceCapability(issued.capability.id, (input.now ?? (() => new Date()))().toISOString()).catch(() => undefined);
    throw error;
  }
}

export async function revokeAtomicModelPilotCapability(
  store: ControlPlaneStore,
  capabilityId: string,
  at = new Date().toISOString(),
): Promise<void> {
  if (!SAFE_ID.test(capabilityId)) throw new Error("Atomic model capability ID is invalid");
  await store.revokeInferenceCapability(capabilityId, at);
}
