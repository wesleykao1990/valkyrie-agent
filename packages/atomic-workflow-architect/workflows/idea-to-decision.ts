import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "idea-to-decision",
  description: "Evaluate an idea through parallel value, feasibility, fit, and risk analysis, then pause for a human portfolio decision.",
  inputs: {
    idea: Type.String({ description: "The idea exactly as proposed." }),
    project: Type.Optional(Type.String({ description: "Project name or ID, when known." })),
    constraints: Type.Optional(Type.Array(Type.String())),
  },
  outputs: {
    recommendation: Type.String(),
    human_decision: Type.String(),
  },
  run: async (ctx: any) => {
    const project = ctx.inputs.project ? `Project: ${ctx.inputs.project}.` : "No project was supplied.";
    const constraints = (ctx.inputs.constraints ?? []).length > 0
      ? `Constraints:\n${(ctx.inputs.constraints ?? []).map((item: string) => `- ${item}`).join("\n")}`
      : "No additional constraints were supplied.";

    const analyses = await ctx.parallel([
      {
        name: "user-value",
        context: "fresh",
        prompt: `${project}\nIdea: ${ctx.inputs.idea}\n${constraints}\nAssess target user, job-to-be-done, expected value, adoption friction, and the smallest useful validation experiment. Do not assume implementation is authorized.`,
      },
      {
        name: "technical-feasibility",
        context: "fresh",
        prompt: `${project}\nIdea: ${ctx.inputs.idea}\n${constraints}\nAssess likely architecture, dependencies, unknowns, integration points, operational burden, and a cheapest feasibility test. Distinguish evidence from assumptions.`,
      },
      {
        name: "portfolio-fit",
        context: "fresh",
        prompt: `${project}\nIdea: ${ctx.inputs.idea}\n${constraints}\nAssess overlap with existing capabilities, strategic fit, sequencing, opportunity cost, and whether this belongs in the named project.`,
      },
      {
        name: "risk-and-evidence",
        context: "fresh",
        prompt: `${project}\nIdea: ${ctx.inputs.idea}\n${constraints}\nIdentify product, technical, legal, privacy, cost, and maintenance risks. State what evidence would materially change the decision.`,
      },
    ], { concurrency: 4, failFast: false });

    const evidence = analyses.map((item: { text: string }, index: number) => `## Analysis ${index + 1}\n${item.text}`).join("\n\n");
    const synthesis = await ctx.task("synthesize-decision", {
      context: "fresh",
      prompt: [
        `Idea: ${ctx.inputs.idea}`,
        project,
        constraints,
        evidence,
        "Produce a concise decision memo with: recommendation, confidence, reasons, unresolved assumptions, smallest validation experiment, indicative implementation slices, and explicit reasons not to build. Do not treat this as implementation authorization.",
      ].join("\n\n"),
    });

    const selected = await ctx.ui.select("Portfolio decision for this idea", [
      "Park",
      "Research further",
      "Promote to planned feature",
      "Design an MVP contract",
    ]);

    return {
      recommendation: synthesis.text,
      human_decision: selected ?? "No decision recorded",
    };
  },
});
