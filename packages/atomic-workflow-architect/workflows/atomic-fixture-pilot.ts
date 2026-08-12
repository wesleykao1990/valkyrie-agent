import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import {
  ATOMIC_FIXTURE_BOUNDS,
  ATOMIC_FIXTURE_CONTEXT_ROOT,
  ATOMIC_FIXTURE_PATHS,
  ATOMIC_FIXTURE_WORKFLOW_NAME,
  applyReviewedAtomicFixtureImplementation,
  emitAtomicFixtureEvidence,
  preflightAtomicFixture,
  runAtomicFixtureChecks,
  runAtomicFixtureVerifier,
  validateAtomicFixtureInputs,
} from "../lib/atomic-fixture-pilot-core.mjs";

export default workflow({
  name: ATOMIC_FIXTURE_WORKFLOW_NAME,
  description: "Credential-free native integration proof for one fixed disposable fixture; writes reviewed code, runs deterministic gates, emits evidence, and stops before external action.",
  inputs: {
    control_plane_run_id: Type.String({ description: "Stable control-plane run ID bound into the immutable run contract." }),
    contract_sha256: Type.String({ description: "Lowercase SHA-256 of /run-context/run-contract.json." }),
    expected_before_sha256: Type.String({ description: "Lowercase SHA-256 of the reviewed missing implementation." }),
  },
  outputs: {
    evidence_manifest_path: Type.String(),
    patch_path: Type.String(),
    check_path: Type.String(),
    verifier_path: Type.String(),
    memory_proposal_path: Type.String(),
    draft_pr_mock_path: Type.String(),
    context_pack_path: Type.String(),
    run_contract_path: Type.String(),
    launch_manifest_path: Type.String(),
    source_after_sha256: Type.String(),
    repair_count: Type.Number(),
    checks_passed: Type.Boolean(),
    verifier_passed: Type.Boolean(),
  },
  run: async (ctx: any) => {
    const inputs = validateAtomicFixtureInputs(ctx.inputs);
    const workspacePath = process.cwd();
    const nativeRunId = String(ctx.runId ?? "unknown-native-run");

    const preflight = await ctx.tool("validate-literal-fixture-contract", {
      ...inputs,
      workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
      context_root: ATOMIC_FIXTURE_CONTEXT_ROOT,
      bounds: ATOMIC_FIXTURE_BOUNDS,
    }, async ({ signal }: { signal: AbortSignal }) => preflightAtomicFixture({
      workspacePath,
      contextRoot: ATOMIC_FIXTURE_CONTEXT_ROOT,
      inputs,
      signal,
    }));

    const implementation = await ctx.tool("write-reviewed-fixture-implementation", {
      control_plane_run_id: inputs.control_plane_run_id,
      contract_sha256: inputs.contract_sha256,
      expected_before_sha256: inputs.expected_before_sha256,
    }, async () => applyReviewedAtomicFixtureImplementation({
      workspacePath,
      expectedBeforeSha256: inputs.expected_before_sha256,
    }));

    const checks = await ctx.tool("run-deterministic-fixture-checks", {
      control_plane_run_id: inputs.control_plane_run_id,
      contract_sha256: inputs.contract_sha256,
      source_after_sha256: implementation.source_after_sha256,
      node_argv: ["/usr/local/bin/node", "--test"],
      git_argv: ["/usr/bin/git", "diff", "--check"],
      max_command_seconds: ATOMIC_FIXTURE_BOUNDS.max_command_seconds,
    }, async ({ signal }: { signal: AbortSignal }) => runAtomicFixtureChecks({
      workspacePath,
      signal,
    }));

    const verifier = await ctx.tool("run-fresh-deterministic-verifier", {
      control_plane_run_id: inputs.control_plane_run_id,
      contract_sha256: inputs.contract_sha256,
      source_after_sha256: implementation.source_after_sha256,
      checks_sha256: checks.artifact.sha256,
      context_mode: "fresh-deterministic-process",
    }, async ({ signal }: { signal: AbortSignal }) => runAtomicFixtureVerifier({
      workspacePath,
      contractSha256: inputs.contract_sha256,
      checks,
      signal,
    }));

    return ctx.tool("emit-governed-fixture-evidence", {
      control_plane_run_id: inputs.control_plane_run_id,
      contract_sha256: inputs.contract_sha256,
      native_run_id: nativeRunId,
      source_before_sha256: preflight.expected_before_sha256,
      source_after_sha256: implementation.source_after_sha256,
      checks_sha256: checks.artifact.sha256,
      verifier_sha256: verifier.artifact.sha256,
      context_pack_sha256: preflight.context_pack_sha256,
      launch_manifest_sha256: preflight.launch_manifest_sha256,
      atomic_workflow_sha256: preflight.atomic_workflow_sha256,
      artifact_paths: ATOMIC_FIXTURE_PATHS,
      repair_count: 0,
      final_action: "stop_before_external_action",
    }, async ({ signal }: { signal: AbortSignal }) => emitAtomicFixtureEvidence({
      workspacePath,
      nativeRunId,
      preflight,
      implementation,
      checks,
      verifier,
      signal,
    }));
  },
});
