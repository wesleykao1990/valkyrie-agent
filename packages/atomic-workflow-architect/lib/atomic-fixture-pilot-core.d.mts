export interface AtomicFixtureInputs {
  control_plane_run_id: string;
  contract_sha256: string;
  expected_before_sha256: string;
}

export const ATOMIC_FIXTURE_WORKFLOW_NAME: "atomic-fixture-pilot";
export const ATOMIC_FIXTURE_WORKFLOW_VERSION: "1.0.0";
export const ATOMIC_FIXTURE_REQUEST: string;
export const ATOMIC_FIXTURE_TARGET: "src/normalize-project-slug.js";
export const ATOMIC_FIXTURE_TEST: "test/normalize-project-slug.test.js";
export const ATOMIC_FIXTURE_CONTEXT_ROOT: "/run-context";
export const ATOMIC_FIXTURE_STAGED_WORKFLOW: "atomic-package/workflows/atomic-fixture-pilot.ts";
export const ATOMIC_FIXTURE_STAGED_CORE: "atomic-package/lib/atomic-fixture-pilot-core.mjs";
export const ATOMIC_FIXTURE_STAGED_PACKAGE_JSON: "atomic-package/package.json";
export const ATOMIC_FIXTURE_PACKAGE_NAME: "wesley-atomic-workflow-architect";
export const ATOMIC_FIXTURE_PACKAGE_VERSION: "0.2.1";
export const ATOMIC_FIXTURE_OUTPUT_ROOT: ".valkyrie-output";
export const ATOMIC_FIXTURE_PATHS: Readonly<{
  evidence: ".valkyrie-output/evidence.json";
  patch: ".valkyrie-output/candidate.patch";
  checks: ".valkyrie-output/checks.json";
  verifier: ".valkyrie-output/verifier.json";
  memoryProposal: ".valkyrie-output/memory-proposal.json";
  draftPrMock: ".valkyrie-output/draft-pr-mock.json";
  contextPack: ".valkyrie-output/context-pack.json";
  runContract: ".valkyrie-output/run-contract.json";
  launchManifest: ".valkyrie-output/atomic-launch-manifest.json";
}>;
export const ATOMIC_FIXTURE_BOUNDS: Readonly<Record<string, number>>;
export const ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256: string;
export const ATOMIC_FIXTURE_TEST_SHA256: string;
export const ATOMIC_FIXTURE_IMPLEMENTATION: string;
export const ATOMIC_FIXTURE_IMPLEMENTATION_SHA256: string;

export function validateAtomicFixtureInputs(value: unknown): Readonly<AtomicFixtureInputs>;
export function preflightAtomicFixture(options: Record<string, any>): Promise<any>;
export function applyReviewedAtomicFixtureImplementation(options: Record<string, any>): Promise<any>;
export function runAtomicFixtureChecks(options: Record<string, any>): Promise<any>;
export function runAtomicFixtureVerifier(options: Record<string, any>): Promise<any>;
export function emitAtomicFixtureEvidence(options: Record<string, any>): Promise<any>;
export function runBoundedCommand(executable: string, args: string[], options: Record<string, any>): Promise<any>;
