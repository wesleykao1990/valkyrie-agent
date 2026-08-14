import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "request-preflight",
  description: "Turn an ordinary idea/project/feature/bug request into a reviewable run contract, evidence plan, and Atomic launch recommendation without editing product source code.",
  inputs: {
    request: Type.String({ description: "The user's exact request." }),
    project: Type.Optional(Type.String({ description: "Project name or stable project ID." })),
    task_ref: Type.Optional(Type.String({ description: "Linear/GitHub/task reference when known." })),
    requested_final_action: Type.Optional(Type.String({ description: "Requested stopping point, such as plan_only, checks, draft_pr, merge, or deploy." })),
    constraints: Type.Optional(Type.Array(Type.String())),
    max_cost_usd: Type.Optional(Type.Number({ description: "Indicative run budget for the recommended execution." })),
  },
  outputs: {
    launch_plan: Type.String({ description: "Reviewable run contract and launch recommendation." }),
    launch_plan_path: Type.String({ description: "Artifact path containing the launch plan." }),
    decision: Type.String({ description: "Human preflight decision." }),
    approved_for_launch: Type.Boolean({ description: "Whether the user approved the recommendation for a later native launch." }),
  },
  run: async (ctx: any) => {
    const request = String(ctx.inputs.request);
    const project = ctx.inputs.project ? String(ctx.inputs.project) : "unresolved";
    const taskRef = ctx.inputs.task_ref ? String(ctx.inputs.task_ref) : "none supplied";
    const finalAction = ctx.inputs.requested_final_action
      ? String(ctx.inputs.requested_final_action)
      : "infer conservatively; never imply merge/deploy";
    const constraints = Array.isArray(ctx.inputs.constraints) && ctx.inputs.constraints.length > 0
      ? ctx.inputs.constraints.map((item: string) => `- ${item}`).join("\n")
      : "- none supplied";
    const budget = typeof ctx.inputs.max_cost_usd === "number"
      ? `$${ctx.inputs.max_cost_usd}`
      : "not supplied";

    const common = [
      `Exact request: ${request}`,
      `Project: ${project}`,
      `Task reference: ${taskRef}`,
      `Requested final action: ${finalAction}`,
      `Indicative budget: ${budget}`,
      `Constraints:\n${constraints}`,
      "This is a read-only preflight. Do not edit product source, create a PR, merge, deploy, or promote memory.",
    ].join("\n\n");

    const analyses = await ctx.parallel([
      {
        name: "intent-and-contract",
        context: "fresh",
        prompt: [
          common,
          "Classify request type and intent. Draft objective, acceptance criteria, scope, non-goals, compatibility posture, invariants, stop conditions, and questions whose answers materially change the run. Prefer contrastive options with a recommendation.",
        ].join("\n\n"),
      },
      {
        name: "execution-shape",
        context: "fresh",
        prompt: [
          common,
          "Score Structure, Verifiability, Iteration, Risk, Duration, and Isolation from 0-2. Recommend direct, bounded subagents, installed workflow, custom workflow, or composed workflows. Map likely Atomic built-ins only conditionally; state that installed contracts must be inspected before launch. Produce a dependency graph and context-mode plan.",
        ].join("\n\n"),
      },
      {
        name: "evidence-and-policy",
        context: "fresh",
        prompt: [
          common,
          "Design an evidence matrix, deterministic probes, fresh reviewer roles, bounded repair policy, model-role policy, workspace/sandbox/durability requirements, approval gates, and explicit final-action separation. Identify untrusted inputs and potential scope drift.",
        ].join("\n\n"),
      },
    ], { concurrency: 3, failFast: false });

    const runId = String(ctx.runId ?? "current");
    const launchPlanPath = `.atomic/workflows/runs/${runId}/request-preflight.md`;
    const evidence = analyses
      .map((item: { text: string }, index: number) => `## Preflight branch ${index + 1}\n${item.text}`)
      .join("\n\n");

    const synthesis = await ctx.task("synthesize-launch-plan", {
      context: "fresh",
      output: launchPlanPath,
      prompt: [
        common,
        evidence,
        "Create one concise, internally consistent launch plan with these sections: request class/intent; authoritative context and freshness gaps; canonical run contract; unresolved material questions; score and hard workflow signals; recommended execution shape; graph/dependencies/context modes; evidence matrix; models by role (no fixed stale IDs); workspace/sandbox/durability owner; bounds; approval gates; final action; exact next native Atomic/control-plane action. Do not claim that the run is launched.",
      ].join("\n\n"),
    });

    const decision = await ctx.ui.select("Preflight decision", [
      "Approve recommended launch",
      "Keep as plan only",
      "Revise before launch",
      "Cancel",
    ]);

    return {
      launch_plan: synthesis.text,
      launch_plan_path: launchPlanPath,
      decision: decision ?? "No decision recorded",
      approved_for_launch: decision === "Approve recommended launch",
    };
  },
});
