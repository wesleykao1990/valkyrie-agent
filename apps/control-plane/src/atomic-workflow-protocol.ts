export const ATOMIC_FIXTURE_WORKFLOW_NAME = "atomic-fixture-pilot";
export const ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME = "atomic-fixture-model-pilot";
export const ATOMIC_FIXTURE_WORKFLOW_OUTPUT_PATHS = Object.freeze({
  evidence_manifest_path: ".valkyrie-output/evidence.json",
  patch_path: ".valkyrie-output/candidate.patch",
  check_path: ".valkyrie-output/checks.json",
  verifier_path: ".valkyrie-output/verifier.json",
  memory_proposal_path: ".valkyrie-output/memory-proposal.json",
  draft_pr_mock_path: ".valkyrie-output/draft-pr-mock.json",
  context_pack_path: ".valkyrie-output/context-pack.json",
  run_contract_path: ".valkyrie-output/run-contract.json",
  launch_manifest_path: ".valkyrie-output/atomic-launch-manifest.json",
});

const FULL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CONTROL_PLANE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WORKFLOW_STATUSES = new Set([
  "blocked",
  "cancelled",
  "completed",
  "failed",
  "killed",
  "paused",
  "pending",
  "running",
  "skipped",
]);
const TERMINAL_STATUSES = new Set([
  "blocked",
  "cancelled",
  "completed",
  "failed",
  "killed",
  "skipped",
]);

export type AtomicWorkflowStatus =
  | "blocked"
  | "cancelled"
  | "completed"
  | "failed"
  | "killed"
  | "paused"
  | "pending"
  | "running"
  | "skipped";

export interface AtomicWorkflowLifecycleDetail {
  action: "run" | "status";
  mode: string;
  runId: string;
  workflow: string;
  status: AtomicWorkflowStatus;
  output?: Record<string, unknown>;
  error?: string;
  message?: string;
  rawDetails: Record<string, unknown>;
}

export interface AtomicFixtureWorkflowInputs {
  control_plane_run_id: string;
  contract_sha256: string;
  expected_before_sha256: string;
}

export interface AtomicFixtureModelWorkflowInputs {
  control_plane_run_id: string;
  contract_sha256: string;
  expected_before_sha256: string;
  capability_policy_sha256: string;
  package_sha256: string;
  live_provider_expected: boolean;
}

export interface AtomicFixtureModelWorkflowOutput {
  evidence_manifest_path: ".valkyrie-model-output/evidence.json";
  patch_path: ".valkyrie-model-output/candidate.patch";
  checks_initial_path: ".valkyrie-model-output/checks-initial.json";
  verifier_initial_path: ".valkyrie-model-output/verifier-initial.json";
  checks_final_path: ".valkyrie-model-output/checks-final.json";
  verifier_final_path: ".valkyrie-model-output/verifier-final.json";
  memory_proposal_path: ".valkyrie-model-output/memory-proposal.json";
  draft_pr_mock_path: ".valkyrie-model-output/draft-pr-mock.json";
  context_pack_path: ".valkyrie-model-output/context-pack.json";
  run_contract_path: ".valkyrie-model-output/run-contract.json";
  launch_manifest_path: ".valkyrie-model-output/atomic-model-launch-manifest.json";
  source_after_sha256: string;
  repair_count: 0 | 1;
  checks_passed: true;
  verifier_passed: true;
  live_provider_verified: boolean;
}

export interface AtomicWorkflowListDetail {
  workflows: string[];
  rawDetails: Record<string, unknown>;
}

export interface AtomicFixtureWorkflowOutput {
  evidence_manifest_path: string;
  patch_path: string;
  check_path: string;
  verifier_path: string;
  memory_proposal_path: string;
  draft_pr_mock_path: string;
  context_pack_path: string;
  run_contract_path: string;
  launch_manifest_path: string;
  source_after_sha256: string;
  repair_count: 0;
  checks_passed: true;
  verifier_passed: true;
}

export class AtomicWorkflowProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicWorkflowProtocolError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertHash(value: string, field: string): void {
  if (!SHA256.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
}

export function buildAtomicFixtureWorkflowDispatchCommand(input: AtomicFixtureWorkflowInputs): string {
  if (!CONTROL_PLANE_RUN_ID.test(input.control_plane_run_id)) {
    throw new TypeError("control_plane_run_id must be a safe 1-128 character run ID");
  }
  assertHash(input.contract_sha256, "contract_sha256");
  assertHash(input.expected_before_sha256, "expected_before_sha256");
  return [
    `/workflow ${ATOMIC_FIXTURE_WORKFLOW_NAME}`,
    "--no-picker",
    `control_plane_run_id=${JSON.stringify(input.control_plane_run_id)}`,
    `contract_sha256=${JSON.stringify(input.contract_sha256)}`,
    `expected_before_sha256=${JSON.stringify(input.expected_before_sha256)}`,
  ].join(" ");
}

export function buildAtomicFixtureModelWorkflowDispatchCommand(input: AtomicFixtureModelWorkflowInputs): string {
  if (!CONTROL_PLANE_RUN_ID.test(input.control_plane_run_id)) {
    throw new TypeError("control_plane_run_id must be a safe 1-128 character run ID");
  }
  for (const field of ["contract_sha256", "expected_before_sha256", "capability_policy_sha256", "package_sha256"] as const) {
    assertHash(input[field], field);
  }
  if (typeof input.live_provider_expected !== "boolean") throw new TypeError("live_provider_expected must be boolean");
  return [
    `/workflow ${ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME}`,
    "--no-picker",
    ...Object.entries(input).map(([name, value]) => `${name}=${JSON.stringify(value)}`),
  ].join(" ");
}

export function buildAtomicWorkflowStatusCommand(runId: string): string {
  if (!FULL_UUID.test(runId)) throw new TypeError("Atomic workflow run ID must be a full UUID");
  return `/workflow status ${runId}`;
}

export function parseAtomicWorkflowListEvent(value: unknown): AtomicWorkflowListDetail | null {
  const record = objectRecord(value);
  if (!record || record.type !== "message_start") return null;
  const message = objectRecord(record.message);
  if (!message || message.role !== "custom" || message.customType !== "workflows:chat-surface") return null;
  const details = objectRecord(message.details);
  if (!details) throw new AtomicWorkflowProtocolError("Atomic workflow list event is missing details");
  if (details.kind !== "list") return null;
  if (!Array.isArray(details.entries)) throw new AtomicWorkflowProtocolError("Atomic workflow list entries must be an array");
  const workflows: string[] = [];
  const seen = new Set<string>();
  for (const value of details.entries) {
    const entry = objectRecord(value);
    if (!entry || typeof entry.name !== "string" || !entry.name) {
      throw new AtomicWorkflowProtocolError("Atomic workflow list entry requires a non-empty name");
    }
    if (seen.has(entry.name)) throw new AtomicWorkflowProtocolError("Atomic workflow list contains a duplicate name");
    seen.add(entry.name);
    workflows.push(entry.name);
  }
  return { workflows, rawDetails: details };
}

/**
 * Parses Atomic's native workflows:chat-surface detail while preserving the
 * original record separately at the caller. Unrelated native records return
 * null; a matching but malformed lifecycle record fails closed.
 */
export function parseAtomicWorkflowLifecycleEvent(value: unknown): AtomicWorkflowLifecycleDetail | null {
  const record = objectRecord(value);
  if (!record || record.type !== "message_start") return null;
  const message = objectRecord(record.message);
  if (!message || message.role !== "custom" || message.customType !== "workflows:chat-surface") return null;
  const details = objectRecord(message.details);
  if (!details) throw new AtomicWorkflowProtocolError("Atomic workflow lifecycle event is missing details");
  if (details.kind !== "dispatch" && details.kind !== "detail") return null;

  const nativeDetail = details.kind === "detail" ? objectRecord(details.detail) : details;
  if (!nativeDetail) throw new AtomicWorkflowProtocolError("Atomic workflow detail surface is missing detail");
  const runId = nativeDetail.runId;
  if (typeof runId !== "string" || !FULL_UUID.test(runId)) {
    throw new AtomicWorkflowProtocolError("Atomic workflow lifecycle event requires a full run UUID");
  }
  const status = details.kind === "dispatch" ? "running" : nativeDetail.status;
  if (typeof status !== "string" || !WORKFLOW_STATUSES.has(status)) {
    throw new AtomicWorkflowProtocolError("Atomic workflow lifecycle event has an unknown status");
  }
  const workflow = details.kind === "dispatch" ? details.workflowName : nativeDetail.name;
  if (typeof workflow !== "string" || !workflow) {
    throw new AtomicWorkflowProtocolError("Atomic workflow lifecycle workflow must be a non-empty string");
  }
  const nativeOutput = details.kind === "detail" ? nativeDetail.result : undefined;
  const output = nativeOutput === undefined ? undefined : objectRecord(nativeOutput);
  if (nativeOutput !== undefined && !output) {
    throw new AtomicWorkflowProtocolError("Atomic workflow lifecycle output must be an object");
  }
  if (nativeDetail.error !== undefined && typeof nativeDetail.error !== "string") {
    throw new AtomicWorkflowProtocolError("Atomic workflow lifecycle error must be a string");
  }
  return {
    action: details.kind === "dispatch" ? "run" : "status",
    mode: details.kind === "dispatch"
      ? "named"
      : typeof nativeDetail.mode === "string" && nativeDetail.mode ? nativeDetail.mode : "inspection",
    runId,
    workflow,
    status: status as AtomicWorkflowStatus,
    ...(output ? { output } : {}),
    ...(typeof nativeDetail.error === "string" ? { error: nativeDetail.error } : {}),
    rawDetails: details,
  };
}

export function isTerminalAtomicWorkflowStatus(status: AtomicWorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function parseAtomicFixtureWorkflowOutput(value: unknown): AtomicFixtureWorkflowOutput {
  const output = objectRecord(value);
  if (!output) throw new AtomicWorkflowProtocolError("Atomic fixture workflow output must be an object");
  const expectedNames = [
    ...Object.keys(ATOMIC_FIXTURE_WORKFLOW_OUTPUT_PATHS),
    "source_after_sha256",
    "repair_count",
    "checks_passed",
    "verifier_passed",
  ].sort();
  const names = Object.keys(output).sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new AtomicWorkflowProtocolError("Atomic fixture workflow output keys do not match the reviewed contract");
  }
  for (const [field, expected] of Object.entries(ATOMIC_FIXTURE_WORKFLOW_OUTPUT_PATHS)) {
    if (output[field] !== expected) {
      throw new AtomicWorkflowProtocolError(`Atomic fixture workflow output ${field} is not the fixed artifact path`);
    }
  }
  if (typeof output.source_after_sha256 !== "string" || !SHA256.test(output.source_after_sha256)) {
    throw new AtomicWorkflowProtocolError("Atomic fixture source_after_sha256 is invalid");
  }
  if (output.repair_count !== 0 || output.checks_passed !== true || output.verifier_passed !== true) {
    throw new AtomicWorkflowProtocolError("Atomic fixture terminal output did not pass its bounded evidence contract");
  }
  return output as unknown as AtomicFixtureWorkflowOutput;
}

export function parseAtomicFixtureModelWorkflowOutput(
  value: unknown,
  expectedLiveProviderVerified?: boolean,
): AtomicFixtureModelWorkflowOutput {
  const output = objectRecord(value);
  if (!output) throw new AtomicWorkflowProtocolError("Atomic model fixture output must be an object");
  const paths = {
    evidence_manifest_path: ".valkyrie-model-output/evidence.json",
    patch_path: ".valkyrie-model-output/candidate.patch",
    checks_initial_path: ".valkyrie-model-output/checks-initial.json",
    verifier_initial_path: ".valkyrie-model-output/verifier-initial.json",
    checks_final_path: ".valkyrie-model-output/checks-final.json",
    verifier_final_path: ".valkyrie-model-output/verifier-final.json",
    memory_proposal_path: ".valkyrie-model-output/memory-proposal.json",
    draft_pr_mock_path: ".valkyrie-model-output/draft-pr-mock.json",
    context_pack_path: ".valkyrie-model-output/context-pack.json",
    run_contract_path: ".valkyrie-model-output/run-contract.json",
    launch_manifest_path: ".valkyrie-model-output/atomic-model-launch-manifest.json",
  } as const;
  const expected = [
    ...Object.keys(paths), "source_after_sha256", "repair_count", "checks_passed", "verifier_passed", "live_provider_verified",
  ].sort();
  const names = Object.keys(output).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new AtomicWorkflowProtocolError("Atomic model fixture output keys do not match the reviewed contract");
  }
  for (const [field, path] of Object.entries(paths)) {
    if (output[field] !== path) throw new AtomicWorkflowProtocolError(`Atomic model fixture ${field} is not the fixed artifact path`);
  }
  if (typeof output.source_after_sha256 !== "string" || !SHA256.test(output.source_after_sha256)) {
    throw new AtomicWorkflowProtocolError("Atomic model fixture source_after_sha256 is invalid");
  }
  if ((output.repair_count !== 0 && output.repair_count !== 1) || output.checks_passed !== true
      || output.verifier_passed !== true || typeof output.live_provider_verified !== "boolean"
      || (expectedLiveProviderVerified !== undefined && output.live_provider_verified !== expectedLiveProviderVerified)) {
    throw new AtomicWorkflowProtocolError("Atomic model fixture did not satisfy the bounded provider-verification output contract");
  }
  return output as unknown as AtomicFixtureModelWorkflowOutput;
}
