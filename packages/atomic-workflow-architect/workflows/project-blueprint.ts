import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "project-blueprint",
  description: "Turn a project objective into architecture options, dependency-aware workstreams, milestones, risks, and a first vertical slice without implementing the whole project.",
  inputs: {
    project: Type.String(),
    objective: Type.String(),
    constraints: Type.Optional(Type.Array(Type.String())),
  },
  outputs: {
    blueprint: Type.String(),
    approved: Type.Boolean(),
  },
  run: async (ctx: any) => {
    const constraints = (ctx.inputs.constraints ?? []).map((item: string) => `- ${item}`).join("\n") || "- none supplied";
    const common = `Project: ${ctx.inputs.project}\nObjective: ${ctx.inputs.objective}\nConstraints:\n${constraints}`;

    const branches = await ctx.parallel([
      {
        name: "product-contract",
        context: "fresh",
        prompt: `${common}\nDefine users, jobs, outcomes, non-goals, product acceptance criteria, and the riskiest assumptions.`,
      },
      {
        name: "technical-architecture",
        context: "fresh",
        prompt: `${common}\nPropose architecture options, boundaries, data/control flows, integrations, security constraints, and key technical decisions. Compare trade-offs.`,
      },
      {
        name: "delivery-graph",
        context: "fresh",
        prompt: `${common}\nCreate workstreams and prove their dependencies. Identify independent slices, shared contracts, milestones, and the smallest end-to-end vertical slice.`,
      },
      {
        name: "risk-evaluation",
        context: "fresh",
        prompt: `${common}\nIdentify failure modes, evaluation strategy, operational/security/privacy risks, cost drivers, and rollback/exit criteria.`,
      },
    ], { concurrency: 4, failFast: false });

    const evidence = branches.map((item: { text: string }, index: number) => `## Branch ${index + 1}\n${item.text}`).join("\n\n");
    const synthesis = await ctx.task("blueprint-synthesis", {
      context: "fresh",
      prompt: [
        common,
        evidence,
        "Synthesize a review-ready blueprint: executive objective, assumptions, architecture decision options, dependency graph, milestone plan, first vertical slice, acceptance/evaluation strategy, risk register, approval points, and proposed separate Atomic runs. Do not create a monolithic implementation stage.",
      ].join("\n\n"),
    });

    const approved = await ctx.ui.confirm(`Approve this blueprint as the planning baseline?\n\n${synthesis.text}`);
    return { blueprint: synthesis.text, approved };
  },
});
