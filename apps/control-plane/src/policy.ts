import type { RuntimeName, StartRunInput } from "./types.ts";

const allowed = new Set<RuntimeName>(["atomic", "codex", "claude", "prime", "hermes"]);

export interface RouteDecision {
  runtime: RuntimeName;
  reason: string;
}

export type EngineeringExecutionShape = "direct" | "atomic-lite" | "atomic-full";
export type EngineeringExecutionPreference = "auto" | EngineeringExecutionShape;
export type RoutingScore = 0 | 1 | 2;

export interface EngineeringRoutingAssessment {
  structure: RoutingScore;
  verifiability: RoutingScore;
  iteration: RoutingScore;
  risk: RoutingScore;
  duration: RoutingScore;
  isolation: RoutingScore;
  preference?: EngineeringExecutionPreference;
  hardSignals?: {
    explicitLoop?: boolean;
    durableBackground?: boolean;
    approvalOrEvidenceGate?: boolean;
    multipleCandidates?: boolean;
  };
}

export interface EngineeringExecutionDecision {
  shape: EngineeringExecutionShape;
  baselineShape: EngineeringExecutionShape;
  score: number;
  preference: EngineeringExecutionPreference;
  preferenceApplied: boolean;
  reasons: string[];
}

export const ENGINEERING_ROUTING_POLICY_VERSION = "engineering-routing-v1";

export type EngineeringFinalActionIntent = "analysis_only" | "prepare_reviewable_result";

export interface EngineeringIntakeInput {
  projectId: string;
  taskId?: string;
  /** Literal Hermes/user request; the control plane records it without rewriting it. */
  request: string;
  preference?: EngineeringExecutionPreference;
  finalAction?: EngineeringFinalActionIntent;
  idempotencyKey?: string;
}

export interface EngineeringRoutingContext {
  /** Exact caller request. It is classified without rewriting the persisted literal. */
  request: string;
  preference?: EngineeringExecutionPreference;
  finalAction: EngineeringFinalActionIntent;
  projectHealth: "on_track" | "at_risk" | "exploring";
  task?: {
    title: string;
    objective: string;
    status: string;
    priority: string;
  };
}

export interface DerivedEngineeringRouting {
  policyVersion: typeof ENGINEERING_ROUTING_POLICY_VERSION;
  assessment: EngineeringRoutingAssessment;
  decision: EngineeringExecutionDecision;
  matchedSignals: string[];
}

const shapeRank: Record<EngineeringExecutionShape, number> = {
  direct: 0,
  "atomic-lite": 1,
  "atomic-full": 2,
};

function assertRoutingScore(name: string, value: number): asserts value is RoutingScore {
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throw new Error(`${name} routing score must be an integer from 0 to 2`);
  }
}

/**
 * Selects the smallest complete engineering execution shape from an assessment
 * made against authoritative task context. Hermes may request a preference, but
 * the control plane owns this policy decision and never permits a preference to
 * reduce the evidence/safety shape selected by the rubric.
 */
export function recommendEngineeringExecution(
  assessment: EngineeringRoutingAssessment,
): EngineeringExecutionDecision {
  const dimensions = [
    ["structure", assessment.structure],
    ["verifiability", assessment.verifiability],
    ["iteration", assessment.iteration],
    ["risk", assessment.risk],
    ["duration", assessment.duration],
    ["isolation", assessment.isolation],
  ] as const;
  for (const [name, value] of dimensions) assertRoutingScore(name, value);

  const score = dimensions.reduce((total, [, value]) => total + value, 0);
  const hardSignals = Object.entries(assessment.hardSignals ?? {})
    .filter(([, active]) => active)
    .map(([name]) => name)
    .sort();
  const reasons = dimensions.filter(([, value]) => value === 2).map(([name]) => `high-${name}`);
  reasons.push(...hardSignals.map((name) => `hard-signal:${name}`));

  let baselineShape: EngineeringExecutionShape;
  if (
    hardSignals.length > 0
    || assessment.iteration === 2
    || assessment.risk === 2
    || score >= 7
  ) {
    baselineShape = "atomic-full";
  } else if (score >= 4) {
    baselineShape = "atomic-lite";
  } else {
    baselineShape = "direct";
  }
  reasons.unshift(`rubric:${baselineShape}`);

  const preference = assessment.preference ?? "auto";
  if (!["auto", "direct", "atomic-lite", "atomic-full"].includes(preference)) {
    throw new Error("Unknown engineering execution preference");
  }
  if (preference === "auto") {
    return { shape: baselineShape, baselineShape, score, preference, preferenceApplied: false, reasons };
  }

  if (shapeRank[preference] < shapeRank[baselineShape]) {
    reasons.push(`preference:${preference}:blocked-by-policy`);
    return { shape: baselineShape, baselineShape, score, preference, preferenceApplied: false, reasons };
  }

  reasons.push(`preference:${preference}:applied`);
  return { shape: preference, baselineShape, score, preference, preferenceApplied: true, reasons };
}

function matches(text: string, expression: RegExp): boolean {
  expression.lastIndex = 0;
  return expression.test(text);
}

/**
 * Derives the rubric from control-plane-visible project/task/request context.
 * Hermes never supplies scores or hard-signal booleans. This deliberately
 * conservative lexical v1 policy is deterministic and auditable; its source
 * freshness is recorded separately with the durable assessment.
 */
export function assessEngineeringRequest(context: EngineeringRoutingContext): DerivedEngineeringRouting {
  if (typeof context.request !== "string" || context.request.trim().length < 5 || context.request.length > 16_000) {
    throw new Error("Engineering request must contain 5 to 16000 characters");
  }
  if (!["analysis_only", "prepare_reviewable_result"].includes(context.finalAction)) {
    throw new Error("Unknown engineering final-action intent");
  }
  if (!["on_track", "at_risk", "exploring"].includes(context.projectHealth)) {
    throw new Error("Unknown project health for engineering routing");
  }
  const preference = context.preference ?? "auto";
  const text = [
    context.request,
    context.task?.title ?? "",
    context.task?.objective ?? "",
    context.task?.status ?? "",
    context.task?.priority ?? "",
  ].join("\n").toLowerCase();
  const matchedSignals: string[] = [];
  const signal = (name: string, expression: RegExp): boolean => {
    const active = matches(text, expression);
    if (active) matchedSignals.push(name);
    return active;
  };

  const structurallySmall = signal("bounded-single-change", /\b(one[- ]line|single[- ]file|one file|typo|copy edit|small edit|tiny fix|rename only)\b/u);
  const structurallyHigh = signal("dependent-multi-surface", /\b(migration|multi[- ]package|multiple packages|cross[- ]package|end[- ]to[- ]end|architecture|schema change|broad refactor|across (?:the )?(?:repo|repository|services))\b/u);
  const objectiveProof = signal("objective-proof", /\b(unit tests?|integration tests?|test suite|build|lint|typecheck|schema validation|benchmark|acceptance criteria|deterministic check|artifact proof)\b/u);
  const readOnly = signal("read-only-analysis", /\b(explain|summari[sz]e|brainstorm|read[- ]only|review only|analysis only)\b/u);
  const explicitLoop = signal("explicit-loop", /\b(until (?:green|passing|done)|loop until|bounded repair|repair rounds?|retry until|fix all failing|keep repairing)\b/u);
  const likelyRepair = signal("likely-repair", /\b(debug|fix|implement|refactor|repair|resolve regression)\b/u);
  const highRisk = signal("high-risk-surface", /\b(security|authentication|authori[sz]ation|credential|secret|database migration|destructive|production|deploy|release|payment|billing|privacy|public api|breaking change)\b/u);
  const scopedRisk = signal("shared-or-integrated-surface", /\b(integration|shared api|api contract|multiple files|multi[- ]file|dependency|runtime adapter|storage contract)\b/u);
  const durableBackground = signal("durable-background", /\b(background|overnight|resumable|multi[- ]hour|long[- ]running|monitor(?:ing)?|scheduled)\b/u);
  const mediumDuration = signal("extended-duration", /\b(research|benchmark|investigate|large change|multi[- ]stage)\b/u);
  const multipleCandidates = signal("multiple-candidates", /\b(compare (?:approaches|models|candidates)|multiple candidates|candidate tournament|parallel candidates|a\/b)\b/u);
  const independentContext = signal("independent-context", /\b(adversarial review|independent review|fresh verifier|fresh context|specialist review)\b/u);
  const approvalOrEvidenceGate = signal("approval-or-final-action-gate", /\b(human approval|approval gate|evidence gate|merge|draft pr|pull request|deployment|promote memory|canonical memory)\b/u);

  let structure: RoutingScore = structurallyHigh ? 2 : structurallySmall ? 0 : 1;
  let verifiability: RoutingScore = objectiveProof ? 2 : readOnly ? 0 : 1;
  let iteration: RoutingScore = explicitLoop ? 2 : likelyRepair ? 1 : 0;
  let risk: RoutingScore = highRisk ? 2 : scopedRisk ? 1 : 0;
  let duration: RoutingScore = durableBackground ? 2 : mediumDuration ? 1 : 0;
  const isolation: RoutingScore = multipleCandidates ? 2 : independentContext ? 1 : 0;

  if (context.projectHealth === "at_risk" && risk < 1) {
    risk = 1;
    matchedSignals.push("project-health-at-risk");
  }
  if (context.task && /^(urgent|critical|high)$/iu.test(context.task.priority) && risk < 1) {
    risk = 1;
    matchedSignals.push("task-priority-risk-floor");
  }
  if (context.finalAction === "prepare_reviewable_result" && verifiability < 1) {
    verifiability = 1;
    matchedSignals.push("reviewable-result-proof-floor");
  }

  const assessment: EngineeringRoutingAssessment = {
    structure,
    verifiability,
    iteration,
    risk,
    duration,
    isolation,
    preference,
    hardSignals: { explicitLoop, durableBackground, approvalOrEvidenceGate, multipleCandidates },
  };
  return {
    policyVersion: ENGINEERING_ROUTING_POLICY_VERSION,
    assessment,
    decision: recommendEngineeringExecution(assessment),
    matchedSignals: [...new Set(matchedSignals)].sort(),
  };
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
