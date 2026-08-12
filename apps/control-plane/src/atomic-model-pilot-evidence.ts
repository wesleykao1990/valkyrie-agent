import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readContainedWorkspaceFile } from "./atomic-fixture-pilot.ts";
import type { AtomicModelWorkflowExecution } from "./atomic-model-workflow-executor.ts";
import { canonicalJson, type ControlPlaneStore, type InferenceRole } from "./store.ts";
import type { OciSandboxHandle } from "./oci-sandbox-provider.ts";
import type { WriterSandboxValidatedExport } from "./writer-sandbox-boundary.ts";
import {
  ATOMIC_FIXTURE_IMPLEMENTATION,
  ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
  ATOMIC_FIXTURE_TARGET,
  ATOMIC_FIXTURE_TEST,
  ATOMIC_FIXTURE_TEST_SHA256,
} from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";
import {
  ATOMIC_FIXTURE_MODEL_PATHS,
  ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME,
} from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";

const SHA = /^[a-f0-9]{64}$/;

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, any>;
}

function parse(body: Buffer, label: string): Record<string, any> {
  try { return object(JSON.parse(body.toString("utf8")), label); }
  catch { throw new Error(`${label} is not valid bounded JSON`); }
}

function exactKeys(value: Record<string, any>, names: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...names].sort())) {
    throw new Error(`${label} keys do not match the reviewed contract`);
  }
}

export interface AtomicModelEvidenceSnapshot {
  artifacts: readonly Readonly<WriterSandboxValidatedExport>[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostMicros: number;
}

export async function validateAtomicModelPilotEvidence(input: {
  store: ControlPlaneStore;
  runId: string;
  handle: OciSandboxHandle;
  contextPath: string;
  capabilityId: string;
  native: AtomicModelWorkflowExecution;
}): Promise<AtomicModelEvidenceSnapshot> {
  const output = input.native.output;
  const paths = Object.values(ATOMIC_FIXTURE_MODEL_PATHS);
  const bodies = new Map(paths.map((path) => [path, readContainedWorkspaceFile(input.handle, path)]));
  const artifacts = paths.map((relativePath) => {
    const body = bodies.get(relativePath)!;
    return Object.freeze({ relativePath, checksum: sha(body), sizeBytes: body.byteLength });
  });
  const byPath = new Map(artifacts.map((item) => [item.relativePath, item]));
  const artifact = (path: string) => {
    const item = byPath.get(path);
    if (!item) throw new Error("Atomic model evidence references an unknown artifact");
    return item;
  };

  const source = readContainedWorkspaceFile(input.handle, ATOMIC_FIXTURE_TARGET);
  const test = readContainedWorkspaceFile(input.handle, ATOMIC_FIXTURE_TEST);
  if (sha(source) !== ATOMIC_FIXTURE_IMPLEMENTATION_SHA256 || source.toString("utf8") !== ATOMIC_FIXTURE_IMPLEMENTATION) {
    throw new Error("Atomic model pilot source is not the exact accepted fixture implementation");
  }
  if (sha(test) !== ATOMIC_FIXTURE_TEST_SHA256) throw new Error("Atomic model pilot changed the literal fixture tests");

  const patch = bodies.get(output.patch_path)!.toString("utf8");
  if (!patch.startsWith(`diff --git a/${ATOMIC_FIXTURE_TARGET} b/${ATOMIC_FIXTURE_TARGET}\n`)
      || (patch.match(/^diff --git /gmu) ?? []).length !== 1
      || !patch.includes(`--- a/${ATOMIC_FIXTURE_TARGET}\n+++ b/${ATOMIC_FIXTURE_TARGET}\n`)) {
    throw new Error("Atomic model pilot patch is not the exact one-file fixture change");
  }

  const validateChecks = (path: string, round: "initial" | "final", mustPass: boolean) => {
    const value = parse(bodies.get(path)!, `Atomic model ${round} checks`);
    exactKeys(value, ["schema_version", "round", "passed", "findings", "commands"], `Atomic model ${round} checks`);
    if (value.schema_version !== "1.0.0" || value.round !== round || typeof value.passed !== "boolean"
        || !Array.isArray(value.findings) || !Array.isArray(value.commands) || value.commands.length !== 3) {
      throw new Error(`Atomic model ${round} checks are outside the reviewed schema`);
    }
    const expected = [
      ["/usr/local/bin/node", "--test"],
      ["/usr/bin/git", "diff", "--check"],
      ["/usr/bin/git", "diff", "--name-only"],
    ];
    for (let index = 0; index < expected.length; index += 1) {
      const command = object(value.commands[index], `Atomic model ${round} command`);
      exactKeys(command, ["argv", "exit_code", "stdout", "stderr"], `Atomic model ${round} command`);
      if (canonicalJson(command.argv) !== canonicalJson(expected[index]) || !Number.isSafeInteger(command.exit_code)
          || typeof command.stdout !== "string" || typeof command.stderr !== "string") {
        throw new Error(`Atomic model ${round} command evidence changed`);
      }
    }
    if (mustPass && (value.passed !== true || value.findings.length !== 0
        || value.commands.some((command: any) => command.exit_code !== 0))) {
      throw new Error(`Atomic model ${round} checks did not pass deterministically`);
    }
    return value;
  };
  const initialChecks = validateChecks(output.checks_initial_path, "initial", output.repair_count === 0);
  validateChecks(output.checks_final_path, "final", true);

  const validateReview = (path: string, round: "initial" | "final", mustApprove: boolean) => {
    const value = parse(bodies.get(path)!, `Atomic model ${round} verifier`);
    exactKeys(value, ["schema_version", "round", "context", "approved", "findings"], `Atomic model ${round} verifier`);
    if (value.schema_version !== "1.0.0" || value.round !== round || value.context !== "fresh"
        || typeof value.approved !== "boolean" || !Array.isArray(value.findings)
        || value.findings.some((item: unknown) => typeof item !== "string" || item.length < 1 || item.length > 500)
        || (value.approved && value.findings.length !== 0) || (mustApprove && value.approved !== true)) {
      throw new Error(`Atomic model ${round} verifier evidence is invalid`);
    }
    return value;
  };
  const initialReview = validateReview(output.verifier_initial_path, "initial", output.repair_count === 0);
  validateReview(output.verifier_final_path, "final", true);
  if (output.repair_count === 1 && initialChecks.passed === true && initialReview.approved === true) {
    throw new Error("Atomic model pilot used a repair without an evidence-backed initial finding");
  }

  const memory = parse(bodies.get(output.memory_proposal_path)!, "Atomic model memory proposal");
  if (canonicalJson(memory) !== canonicalJson({
    schema_version: "1.0.0", state: "proposed",
    claim: "The bounded model pilot completed the disposable slug-normalization fixture.",
    promotion: "separate_review_required",
  })) throw new Error("Atomic model memory proposal changed its non-promoting contract");
  const draft = parse(bodies.get(output.draft_pr_mock_path)!, "Atomic model draft PR mock");
  if (canonicalJson(draft) !== canonicalJson({ schema_version: "1.0.0", action: "mock_only", external_action_performed: false })) {
    throw new Error("Atomic model draft PR evidence is not mock-only");
  }

  for (const [path, source] of [
    [output.context_pack_path, "context-pack.json"],
    [output.run_contract_path, "run-contract.json"],
    [output.launch_manifest_path, "atomic-model-launch-manifest.json"],
  ] as const) {
    if (!bodies.get(path)!.equals(readFileSync(join(input.contextPath, source)))) {
      throw new Error("Atomic model immutable context copy changed");
    }
  }

  const evidence = parse(bodies.get(output.evidence_manifest_path)!, "Atomic model evidence manifest");
  const acceptedContract = parse(readFileSync(join(input.contextPath, "run-contract.json")), "Atomic model accepted run contract");
  const acceptedPackage = object(acceptedContract.atomicPackage, "Atomic model accepted package binding");
  const acceptedInference = object(acceptedContract.inference, "Atomic model accepted inference binding");
  exactKeys(evidence, [
    "schema_version", "control_plane_run_id", "native_workflow_run_id", "workflow", "package_sha256",
    "capability_policy_sha256", "repair_count", "checks", "verifier", "patch", "memory_proposal",
    "draft_pr_mock", "context", "model_execution_expected", "live_provider_verified", "final_action",
  ], "Atomic model evidence manifest");
  const binding = (path: string) => {
    const item = artifact(path);
    return { path, sha256: item.checksum, size_bytes: item.sizeBytes };
  };
  if (evidence.schema_version !== "1.0.0-model-prelive" || evidence.control_plane_run_id !== input.runId
      || evidence.native_workflow_run_id !== input.native.nativeWorkflowRunId
      || evidence.workflow !== ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME || evidence.repair_count !== output.repair_count
      || evidence.package_sha256 !== acceptedPackage.packageSha256
      || evidence.capability_policy_sha256 !== acceptedInference.policySha256
      || evidence.model_execution_expected !== true || evidence.live_provider_verified !== false
      || evidence.final_action !== "stop_before_external_action"
      || canonicalJson(evidence.checks) !== canonicalJson(binding(output.checks_final_path))
      || canonicalJson(evidence.verifier) !== canonicalJson(binding(output.verifier_final_path))
      || canonicalJson(evidence.patch) !== canonicalJson(binding(output.patch_path))
      || canonicalJson(evidence.memory_proposal) !== canonicalJson(binding(output.memory_proposal_path))
      || canonicalJson(evidence.draft_pr_mock) !== canonicalJson(binding(output.draft_pr_mock_path))) {
    throw new Error("Atomic model evidence manifest is not bound to the verified artifacts");
  }
  const context = object(evidence.context, "Atomic model context evidence");
  if (canonicalJson(context) !== canonicalJson({
    contextPack: binding(output.context_pack_path),
    runContract: binding(output.run_contract_path),
    launchManifest: binding(output.launch_manifest_path),
  })) throw new Error("Atomic model evidence context bindings changed");

  const capability = await input.store.getInferenceCapability(input.capabilityId);
  const requests = await input.store.listInferenceRequests(input.runId);
  if (!capability || capability.id !== input.capabilityId || capability.runId !== input.runId
      || (capability.state !== "active" && capability.state !== "exhausted")) {
    throw new Error("Atomic model inference capability is not valid for evidence validation");
  }
  const expectedRoles: InferenceRole[] = output.repair_count === 1
    ? ["implementer", "verifier_initial", "repair", "verifier_final"]
    : ["implementer", "verifier_initial", "verifier_final"];
  const actualRoles = requests.map((request) => request.role).sort();
  if (canonicalJson(actualRoles) !== canonicalJson([...expectedRoles].sort())
      || requests.some((request) => request.state !== "completed" || !request.responseHash || !SHA.test(request.responseHash))) {
    throw new Error("Atomic model provider usage does not match the native stage contract");
  }
  const totalInputTokens = requests.reduce((sum, request) => sum + request.inputTokens, 0);
  const totalOutputTokens = requests.reduce((sum, request) => sum + request.outputTokens, 0);
  const totalCostMicros = requests.reduce((sum, request) => sum + request.costMicros, 0);
  if (totalInputTokens > capability.maxInputTokens || totalOutputTokens > capability.maxOutputTokens
      || totalCostMicros > capability.maxCostMicros) {
    throw new Error("Atomic model provider usage exceeded its durable capability bounds");
  }

  const manifest = new Map<string, { kind: string; mediaType: string }>([
    [ATOMIC_FIXTURE_MODEL_PATHS.evidence, { kind: "atomic-model-pilot-evidence", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.patch, { kind: "candidate-patch", mediaType: "text/x-diff" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.checksInitial, { kind: "deterministic-checks-initial", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.verifierInitial, { kind: "fresh-model-verifier-initial", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.checksFinal, { kind: "deterministic-checks-final", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.verifierFinal, { kind: "fresh-model-verifier-final", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.memoryProposal, { kind: "memory-proposal-draft", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.draftPrMock, { kind: "draft-pr-mock", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.contextPack, { kind: "project-brain-context-pack", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.runContract, { kind: "run-contract", mediaType: "application/json" }],
    [ATOMIC_FIXTURE_MODEL_PATHS.launchManifest, { kind: "atomic-model-launch-manifest", mediaType: "application/json" }],
  ]);
  return {
    artifacts: Object.freeze(artifacts.map((item) => Object.freeze({ ...item, ...manifest.get(item.relativePath)! }))),
    totalInputTokens,
    totalOutputTokens,
    totalCostMicros,
  };
}

export function assertAtomicModelFrozenExports(
  snapshot: AtomicModelEvidenceSnapshot,
  exports: readonly Readonly<WriterSandboxValidatedExport>[],
): void {
  const normalize = (items: readonly Readonly<WriterSandboxValidatedExport>[]) => items.map((item) => ({
    relativePath: item.relativePath, kind: item.kind, mediaType: item.mediaType,
    checksum: item.checksum, sizeBytes: item.sizeBytes,
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (canonicalJson(normalize(snapshot.artifacts)) !== canonicalJson(normalize(exports))) {
    throw new Error("Atomic model frozen exports changed after model evidence validation");
  }
}
