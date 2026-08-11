import type { RuntimeName, StartRunInput } from "./types.ts";

const allowed = new Set<RuntimeName>(["atomic", "codex", "claude", "prime", "hermes"]);

export interface RouteDecision {
  runtime: RuntimeName;
  reason: string;
}

export function routeTask(input: StartRunInput): RouteDecision {
  if (input.runtime) {
    if (!allowed.has(input.runtime)) throw new Error(`Runtime ${input.runtime} is not allowed`);
    return { runtime: input.runtime, reason: "Explicit user selection" };
  }

  const text = input.objective.toLowerCase();
  if (/research|benchmark|investigate|experiment|compare models/.test(text)) {
    return { runtime: "prime", reason: "Open-ended investigation benefits from a research specialist" };
  }
  if (/remind|monitor|weekly|daily brief|watch/.test(text)) {
    return { runtime: "hermes", reason: "Personal monitoring and scheduled work remain with Hermes" };
  }
  if (/small edit|tiny fix|one-line|focused review|review only/.test(text)) {
    return { runtime: "codex", reason: "Low-ceremony bounded coding path" };
  }
  return { runtime: "atomic", reason: "Non-trivial engineering task with evidence and approval gates" };
}

export function validateBudget(value: number | undefined): number {
  const budget = value ?? 8;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("Budget must be a positive number");
  if (budget > 25) throw new Error("Prototype budget ceiling is $25 per run");
  return budget;
}
