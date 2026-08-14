import { keepContext, workflow } from "@bastani/workflows";
import { Type } from "typebox";
import {
  ATOMIC_LITE_BOUNDS,
  ATOMIC_LITE_CONTEXT_ROOT,
  ATOMIC_LITE_EXCLUDED_NATIVE_TOOLS,
  ATOMIC_LITE_TOOL_NAMES,
  ATOMIC_LITE_WORKFLOW_NAME,
  createAtomicLiteCustomTools,
  emitAtomicLiteEvidence,
  preflightAtomicLite,
  runAtomicLiteChecks,
  validateAtomicLiteInputs,
  writeAtomicLiteReview,
} from "../lib/atomic-lite-writer-core.mjs";

const reviewSchema = Type.Object({
  approved: Type.Boolean(),
  findings: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
}, { additionalProperties: false });

const implementationSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  changed_files: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
  delta: Type.String({ maxLength: 4096 }),
}, { additionalProperties: false });

export default workflow({
  name: ATOMIC_LITE_WORKFLOW_NAME,
  description: "Atomic Lite: one retained implementer, deterministic checks, at most one forked repair, and a policy-gated fresh review before external action.",
  inputs: {
    control_plane_run_id: Type.String(),
    contract_sha256: Type.String(),
    policy_sha256: Type.String(),
    context_sha256: Type.String(),
  },
  outputs: {
    evidence_manifest_path: Type.String(),
    patch_path: Type.String(),
    delta_path: Type.String(),
    checks_initial_path: Type.String(),
    checks_final_path: Type.String(),
    review_path: Type.String(),
    review_decision_path: Type.String(),
    review_decision: Type.String(),
    repair_count: Type.Number(),
    context_copy_path: Type.String(),
    context_path: Type.String(),
    context_pack_path: Type.String(),
    contract_copy_path: Type.String(),
    contract_path: Type.String(),
    run_contract_path: Type.String(),
    policy_copy_path: Type.String(),
    policy_path: Type.String(),
    contract_sha256: Type.String(),
    policy_sha256: Type.String(),
    context_sha256: Type.String(),
    checks_sha256: Type.String(),
    review_sha256: Type.String(),
    checks_passed: Type.Boolean(),
    reviewer_passed: Type.Boolean(),
    model_execution_attempted: Type.Boolean(),
    reviewer_model_execution_attempted: Type.Boolean(),
    evidence_sha256: Type.String(),
  },
  run: async (ctx: any) => {
    const inputs = validateAtomicLiteInputs(ctx.inputs);
    const workspacePath = process.cwd();
    const contract = keepContext([
      "Atomic Lite is the root Atomic runtime.",
      "Implement only the requested task in the policy-allowlisted workspace files.",
      "Use only the supplied Atomic Lite custom list/read/write tools; never use network, credentials, Git remotes, PRs, deployment, memory promotion, or final external actions.",
      "Deterministic checks and evidence are workflow-owned ctx.tool calls.",
    ].join("\n"));

    const preflight = await ctx.tool("validate atomic lite contract and policy", {
      ...inputs,
      context_root: ATOMIC_LITE_CONTEXT_ROOT,
      bounds: ATOMIC_LITE_BOUNDS,
    }, async ({ signal }: { signal: AbortSignal }) => preflightAtomicLite({
      workspacePath,
      contextRoot: ATOMIC_LITE_CONTEXT_ROOT,
      inputs,
      signal,
    }));

    // No custom tools are constructed until the signed/hash-bound policy has
    // been read and validated by the durable preflight tool node.
    const customTools = createAtomicLiteCustomTools(workspacePath, preflight.policy, Type);
    const implementer = await ctx.task("atomic lite implementer", {
      context: "fresh",
      tools: [ATOMIC_LITE_TOOL_NAMES.list, ATOMIC_LITE_TOOL_NAMES.read, ATOMIC_LITE_TOOL_NAMES.write],
      customTools,
      excludedTools: [...ATOMIC_LITE_EXCLUDED_NATIVE_TOOLS],
      schema: implementationSchema,
      prompt: `${contract}\n${JSON.stringify({
        workflow: ATOMIC_LITE_WORKFLOW_NAME,
        request: preflight.contract.request,
        context: preflight.contextSummary,
        read_allowlist: preflight.policy.workspace.read,
        write_allowlist: preflight.policy.workspace.write,
        checks: preflight.policy.checks.map((check: any) => check.id),
      })}\nImplement the smallest correct change. Return only the bounded implementation summary, changed file paths, and a short delta description.`,
    });

    const initialChecks = await ctx.tool("run initial atomic lite deterministic checks", {
      round: "initial",
      implementation_delta: implementer.structured?.delta ?? "",
    }, async ({ signal }: { signal: AbortSignal }) => runAtomicLiteChecks({
      workspacePath,
      policy: preflight.policy,
      round: "initial",
      baseline: preflight.baseline,
      gitBaseline: preflight.git,
      signal,
    }));

    let repairCount = 0;
    if (!initialChecks.passed && preflight.policy.maxRepairRounds === 1) {
      repairCount = 1;
      const repairDelta = JSON.stringify({
        findings: initialChecks.findings,
        checks: initialChecks.commands.map((item: any) => ({ id: item.id, exit_code: item.exit_code, error: item.error })),
      }).slice(0, 8192);
      await ctx.task("atomic lite forked repair", {
        context: "fork",
        forkFromSessionFile: implementer.sessionFile,
        tools: [ATOMIC_LITE_TOOL_NAMES.list, ATOMIC_LITE_TOOL_NAMES.read, ATOMIC_LITE_TOOL_NAMES.write],
        customTools,
        excludedTools: [...ATOMIC_LITE_EXCLUDED_NATIVE_TOOLS],
        schema: implementationSchema,
        prompt: `${contract}\nRepair only the evidence-backed deterministic findings below, then stop. Do not start an unrelated context or broaden the allowlist.\n${repairDelta}`,
      });
    }

    const finalChecks = await ctx.tool("run final atomic lite deterministic checks", {
      round: "final",
      repair_count: repairCount,
      prior_findings: initialChecks.findings,
    }, async ({ signal }: { signal: AbortSignal }) => runAtomicLiteChecks({
      workspacePath,
      policy: preflight.policy,
      round: "final",
      baseline: preflight.baseline,
      gitBaseline: preflight.git,
      signal,
    }));
    if (!finalChecks.passed) throw new Error("Atomic Lite exhausted its bounded repair without passing deterministic checks");

    let review;
    if (preflight.policy.reviewerRequired) {
      const reviewer = await ctx.task("atomic lite fresh reviewer", {
        context: "fresh",
        tools: [ATOMIC_LITE_TOOL_NAMES.list, ATOMIC_LITE_TOOL_NAMES.read],
        customTools,
        excludedTools: [...ATOMIC_LITE_EXCLUDED_NATIVE_TOOLS],
        schema: reviewSchema,
        prompt: `${contract}\nIndependently review the current candidate files with the read-only list/read tools. The workflow supplies final deterministic evidence below; do not claim to inspect an inaccessible check artifact. Review only the distinct policy-required surface; approve only when the literal request, accepted context, delta, and final evidence agree.\n${JSON.stringify({
          context: preflight.contextSummary,
          final_checks: {
            passed: finalChecks.passed,
            findings: finalChecks.findings,
            artifact_sha256: finalChecks.artifact.sha256,
          },
          delta: finalChecks.delta,
          changed_paths: finalChecks.changed_paths,
          read_allowlist: preflight.policy.workspace.read,
        })}\nReturn bounded approved/findings JSON.`,
      });
      review = await ctx.tool("persist atomic lite fresh review", {
        approved: reviewer.structured?.approved,
        findings: reviewer.structured?.findings,
      }, async () => writeAtomicLiteReview({
        workspacePath,
        review: reviewer.structured,
      }));
      if (!review.approved) throw new Error("Atomic Lite fresh reviewer rejected the final candidate");
    } else {
      // This explicit artifact is a deterministic policy decision and must not
      // spend a model call merely to repeat that no distinct review surface is
      // trusted/required.
      review = await ctx.tool("persist atomic lite review-not-required decision", {
        reviewer_required: false,
        final_checks_sha256: finalChecks.artifact.sha256,
      }, async () => writeAtomicLiteReview({
        workspacePath,
        reviewNotRequired: true,
      }));
    }

    return ctx.tool("emit atomic lite bounded evidence", {
      control_plane_run_id: inputs.control_plane_run_id,
      contract_sha256: inputs.contract_sha256,
      policy_sha256: inputs.policy_sha256,
      context_sha256: inputs.context_sha256,
      repair_count: repairCount,
      checks_sha256: finalChecks.artifact.sha256,
      review_sha256: review.artifact.sha256,
    }, async ({ signal }: { signal: AbortSignal }) => emitAtomicLiteEvidence({
      workspacePath,
      contextRoot: ATOMIC_LITE_CONTEXT_ROOT,
      inputs,
      preflight,
      nativeRunId: ctx.runId,
      initialChecks,
      finalChecks,
      review,
      repairCount,
      signal,
    }));
  },
});
