import { keepContext, workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  ATOMIC_FIXTURE_MODEL_ALIASES,
  ATOMIC_FIXTURE_MODEL_BOUNDS,
  ATOMIC_FIXTURE_MODEL_CONTEXT_ROOT,
  ATOMIC_FIXTURE_MODEL_REQUEST,
  ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME,
  emitAtomicFixtureModelEvidence,
  preflightAtomicFixtureModel,
  runAtomicFixtureModelChecks,
  validateAtomicFixtureModelInputs,
  writeAtomicFixtureModelReview,
} from "../lib/atomic-fixture-model-pilot-core.mjs";

const readTargets = {
  source: "src/normalize-project-slug.js",
  test: "test/normalize-project-slug.test.js",
  checks_initial: ".valkyrie-model-output/checks-initial.json",
  checks_final: ".valkyrie-model-output/checks-final.json",
} as const;

async function fixedFile(rootInput: string, relativePath: string) {
  const root = resolve(rootInput);
  const realRoot = await realpath(root);
  const candidate = resolve(root, ...relativePath.split("/"));
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new Error("Fixed fixture tool path escaped the workspace");
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) {
    throw new Error("Fixed fixture tool accepts only a bounded single-link file");
  }
  const real = await realpath(candidate);
  if (!real.startsWith(`${realRoot}${sep}`)) throw new Error("Fixed fixture tool resolved outside the workspace");
  return { path: real, stat };
}

function fixtureTools(workspacePath: string, writable: boolean) {
  const readTool = {
    name: "fixture_read",
    label: "Read fixed fixture evidence",
    description: "Read one allowlisted file from the disposable fixture.",
    parameters: Type.Object({ target: Type.Union(Object.keys(readTargets).map((name) => Type.Literal(name))) }, { additionalProperties: false }),
    execute: async (_id: string, params: { target: keyof typeof readTargets }) => {
      const item = await fixedFile(workspacePath, readTargets[params.target]);
      return { content: [{ type: "text", text: await readFile(item.path, "utf8") }], details: { target: params.target } };
    },
  };
  if (!writable) return [readTool];
  return [readTool, {
    name: "fixture_write_source",
    label: "Write fixed fixture source",
    description: "Replace only src/normalize-project-slug.js in the disposable fixture.",
    parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false }),
    execute: async (_id: string, params: { content: string }) => {
      const item = await fixedFile(workspacePath, readTargets.source);
      await writeFile(item.path, params.content, { encoding: "utf8", mode: 0o600 });
      return { content: [{ type: "text", text: "Updated the one reviewed fixture source file." }], details: { target: "source" } };
    },
  }];
}

const reviewSchema = Type.Object({
  approved: Type.Boolean(),
  findings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
}, { additionalProperties: false });

const implementationSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  changed_files: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false });

export default workflow({
  name: ATOMIC_FIXTURE_MODEL_WORKFLOW_NAME,
  description: "Bounded model workflow for one disposable fixture: implementer, deterministic checks, fresh verifier, one forked repair, evidence, and no external action.",
  inputs: {
    control_plane_run_id: Type.String(),
    contract_sha256: Type.String(),
    expected_before_sha256: Type.String(),
    capability_policy_sha256: Type.String(),
    package_sha256: Type.String(),
    live_provider_expected: Type.Boolean(),
  },
  outputs: {
    evidence_manifest_path: Type.String(), patch_path: Type.String(), checks_initial_path: Type.String(),
    verifier_initial_path: Type.String(), checks_final_path: Type.String(), verifier_final_path: Type.String(),
    memory_proposal_path: Type.String(), draft_pr_mock_path: Type.String(), context_pack_path: Type.String(),
    run_contract_path: Type.String(), launch_manifest_path: Type.String(), repair_count: Type.Number(),
    source_after_sha256: Type.String(),
    checks_passed: Type.Boolean(), verifier_passed: Type.Boolean(), live_provider_verified: Type.Boolean(),
  },
  run: async (ctx: any) => {
    const inputs = validateAtomicFixtureModelInputs(ctx.inputs);
    const workspacePath = process.cwd();
    const contract = keepContext([
      ATOMIC_FIXTURE_MODEL_REQUEST,
      "Modify only src/normalize-project-slug.js. Preserve the literal tests and all control-plane files.",
      "Do not access the network, credentials, Git remotes, PRs, deployment, databases, or memory promotion.",
      "Run only bounded local inspection needed for this fixed implementation and finish with structured_output.",
    ].join("\n"));

    await ctx.tool("validate-model-pilot-contract", { ...inputs, bounds: ATOMIC_FIXTURE_MODEL_BOUNDS },
      async ({ signal }: { signal: AbortSignal }) => preflightAtomicFixtureModel({
        workspacePath, contextRoot: ATOMIC_FIXTURE_MODEL_CONTEXT_ROOT, inputs, signal,
      }));

    const implementer = await ctx.task("implement fixed fixture", {
      context: "fresh", model: ATOMIC_FIXTURE_MODEL_ALIASES.implementer, fallbackModels: [],
      tools: ["fixture_read", "fixture_write_source"], customTools: fixtureTools(workspacePath, true),
      excludedTools: ["read", "write", "edit", "bash", "ask_user_question", "subagent", "intercom", "web_search", "fetch_content"],
      schema: implementationSchema,
      prompt: `${contract}\nImplement the smallest correct change now. Run the focused test if useful.`,
    });

    let checks = await ctx.tool("run initial deterministic checks", { round: "initial", implementation: implementer.structured },
      async ({ signal }: { signal: AbortSignal }) => runAtomicFixtureModelChecks({ workspacePath, round: "initial", signal }));
    const initialReviewResult = await ctx.task("independent initial verification", {
      context: "fresh", model: ATOMIC_FIXTURE_MODEL_ALIASES.verifier_initial, fallbackModels: [],
      tools: ["fixture_read"], customTools: fixtureTools(workspacePath, false),
      excludedTools: ["read", "write", "edit", "bash", "ask_user_question", "subagent", "intercom", "web_search", "fetch_content"],
      schema: reviewSchema,
      prompt: `${contract}\nIndependently inspect the current diff, literal tests, and .valkyrie-model-output/checks-initial.json. Approve only when the implementation satisfies the fixed contract and deterministic evidence.`,
    });
    const initialReview = await ctx.tool("persist initial fresh verifier", { review: initialReviewResult.structured },
      async () => writeAtomicFixtureModelReview({ workspacePath, round: "initial", review: initialReviewResult.structured }));

    let repairCount = 0;
    if (!checks.passed || !initialReview.approved) {
      repairCount = 1;
      const findings = [...checks.findings, ...initialReview.findings];
      await ctx.task("repair fixed fixture once", {
        context: "fork", forkFromSessionFile: implementer.sessionFile,
        model: ATOMIC_FIXTURE_MODEL_ALIASES.repair, fallbackModels: [],
        tools: ["fixture_read", "fixture_write_source"], customTools: fixtureTools(workspacePath, true),
        excludedTools: ["read", "write", "edit", "bash", "ask_user_question", "subagent", "intercom", "web_search", "fetch_content"],
        schema: implementationSchema,
        prompt: `${contract}\nRepair only these evidence-backed findings, then stop: ${JSON.stringify(findings)}`,
      });
    }
    const finalFindings = [...checks.findings, ...initialReview.findings];
    checks = await ctx.tool("run final deterministic checks", { round: "final", prior_findings: finalFindings },
      async ({ signal }: { signal: AbortSignal }) => runAtomicFixtureModelChecks({ workspacePath, round: "final", signal }));
    const finalReviewResult = await ctx.task("independent final verification", {
      context: "fresh", model: ATOMIC_FIXTURE_MODEL_ALIASES.verifier_final, fallbackModels: [],
      tools: ["fixture_read"], customTools: fixtureTools(workspacePath, false),
      excludedTools: ["read", "write", "edit", "bash", "ask_user_question", "subagent", "intercom", "web_search", "fetch_content"],
      schema: reviewSchema,
      prompt: `${contract}\nFreshly verify the final candidate using only the current files, literal contract, and final deterministic check evidence.`,
    });
    const verifier = await ctx.tool("persist final fresh verifier", { review: finalReviewResult.structured },
      async () => writeAtomicFixtureModelReview({ workspacePath, round: "final", review: finalReviewResult.structured }));
    if (!checks.passed || !verifier.approved) throw new Error("Model pilot exhausted its single repair without verified acceptance");

    return ctx.tool("emit model pilot evidence", {
      control_plane_run_id: inputs.control_plane_run_id, repair_count: repairCount,
      checks_sha256: checks.artifact.sha256, verifier_sha256: verifier.artifact.sha256,
    }, async ({ signal }: { signal: AbortSignal }) => emitAtomicFixtureModelEvidence({
      workspacePath, contextRoot: ATOMIC_FIXTURE_MODEL_CONTEXT_ROOT, inputs,
      nativeRunId: ctx.runId, checks, verifier, repairCount, signal,
    }));
  },
});
