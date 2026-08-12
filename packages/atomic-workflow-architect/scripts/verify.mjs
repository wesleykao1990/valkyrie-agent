import { readFile, access, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { routePrompt } from "../lib/router-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "LICENSE.md",
  "package.json",
  "README.md",
  "START_HERE.md",
  "extensions/auto-route.ts",
  "lib/atomic-fixture-pilot-core.d.mts",
  "lib/atomic-fixture-pilot-core.mjs",
  "lib/atomic-fixture-model-pilot-core.d.mts",
  "lib/atomic-fixture-model-pilot-core.mjs",
  "skills/atomic-workflow-architect/SKILL.md",
  "workflows/atomic-fixture-pilot.ts",
  "workflows/atomic-fixture-model-pilot.ts",
  "workflows/idea-to-decision.ts",
  "workflows/project-blueprint.ts",
  "workflows/request-preflight.ts",
  "research/ATOMIC_EXPERT_RESEARCH.md",
  "research/VIDEO_MASTERCLASS_FINDINGS.md",
  "research/VIDEO_TIMESTAMP_INDEX.md",
  "research/SOURCE_MANIFEST.md",
  "integration/CONTROL_PLANE_INTEGRATION.md",
  "integration/INSTALLATION_AND_OPERATIONS.md",
  "integration/ARCHITECTURE_DECISION_ADDENDUM.md",
  "lib/router-core.d.mts",
  "skills/atomic-workflow-architect/references/02-routing-rubric.md",
  "skills/atomic-workflow-architect/references/07-verification-gates.md",
  "skills/atomic-workflow-architect/references/14-durability-and-workspaces.md",
  "skills/atomic-workflow-architect/references/15-video-masterclass-lessons.md",
  "skills/atomic-workflow-architect/references/16-runtime-integration-and-promotion.md",
  "skills/atomic-workflow-architect/references/17-session-context-and-project-memory.md",
  "skills/atomic-workflow-architect/assets/launch-manifest.schema.json",
  "skills/atomic-workflow-architect/assets/launch-manifest-template.json",
  "skills/atomic-workflow-architect/assets/model-launch-manifest.schema.json",
  "skills/atomic-workflow-architect/assets/model-launch-manifest-template.json",
];

for (const path of required) await access(join(root, path));

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (pkg.version !== "0.2.1") throw new Error(`expected package version 0.2.1, got ${pkg.version}`);
if (!pkg.keywords?.includes("atomic-package")) throw new Error("package.json needs atomic-package keyword");
if (!pkg.atomic?.extensions?.includes("./extensions/auto-route.ts")) throw new Error("extension missing from manifest");
if (!pkg.atomic?.skills?.includes("./skills")) throw new Error("skills missing from manifest");
if (!pkg.atomic?.workflows?.includes("./workflows")) throw new Error("workflows missing from manifest");
for (const dependency of ["@bastani/atomic", "@bastani/workflows", "typebox"]) {
  if (!Object.hasOwn(pkg.peerDependencies ?? {}, dependency)) throw new Error(`package.json missing host peer ${dependency}`);
}

const skill = await readFile(join(root, "skills/atomic-workflow-architect/SKILL.md"), "utf8");
if (!skill.startsWith("---\n")) throw new Error("SKILL.md frontmatter missing");
if (!/\nname: atomic-workflow-architect\n/.test(skill)) throw new Error("skill name mismatch");
if (!/\n  version: "0\.2\.1"\n/.test(skill)) throw new Error("skill metadata version mismatch");
for (const phrase of [
  "Atomic is the root runtime, not a wrapper under another coding agent",
  "Generated workflows are drafts until proven",
  "idea-to-decision",
  "request-preflight",
  "<keepContext>",
]) {
  if (!skill.includes(phrase)) throw new Error(`SKILL.md missing required doctrine: ${phrase}`);
}
if (!skill.includes("Authority is domain-specific rather than one global ranking")) {
  throw new Error("SKILL.md must describe domain-specific authority");
}

const agents = await readFile(join(root, "AGENTS.md"), "utf8");
for (const phrase of [
  "not the whole control plane",
  "Keep direct Codex and Claude paths available",
  "Do not enable live runtime execution",
]) {
  if (!agents.includes(phrase)) throw new Error(`AGENTS.md missing package boundary: ${phrase}`);
}

const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
if (!claude.startsWith("@AGENTS.md\n")) throw new Error("CLAUDE.md must bootstrap from AGENTS.md");

const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes("## 0.2.1 — 2026-08-11")) throw new Error("0.2.1 changelog entry missing");

const videoStatus = await readFile(join(root, "skills/atomic-workflow-architect/references/13-video-analysis-status.md"), "utf8");
if (!/Status: complete/i.test(videoStatus)) throw new Error("video analysis not marked complete");
if (/have not yet been transcript-analyzed/i.test(videoStatus)) throw new Error("stale pending-video text remains");

const research = await readFile(join(root, "research/ATOMIC_EXPERT_RESEARCH.md"), "utf8");
for (const phrase of [
  "first-class root runtime",
  "Natural-language workflow generation",
  "Verbatim compaction",
  "Anecdotal stream metrics",
]) {
  if (!research.includes(phrase)) throw new Error(`research dossier missing ${phrase}`);
}

const runtimeIntegration = await readFile(join(root, "skills/atomic-workflow-architect/references/16-runtime-integration-and-promotion.md"), "utf8");
for (const phrase of ["launch-manifest.schema.json", "exclusive writer lease", "crossProcessResume"]) {
  if (!runtimeIntegration.includes(phrase)) throw new Error(`runtime integration reference missing ${phrase}`);
}

const extension = await readFile(join(root, "extensions/auto-route.ts"), "utf8");
if (!extension.includes('event.source === "extension"') && !extension.includes('source === "extension"')) throw new Error("extension must skip extension-originated input");
if (!extension.includes("event.streamingBehavior")) throw new Error("extension must skip steering/follow-up input");
if (!extension.includes('action === "test"')) throw new Error("extension must expose routing test command");

const workflowFiles = ["atomic-fixture-model-pilot.ts", "atomic-fixture-pilot.ts", "idea-to-decision.ts", "project-blueprint.ts", "request-preflight.ts"];
for (const name of workflowFiles) {
  const source = await readFile(join(root, "workflows", name), "utf8");
  for (const expected of ['from "@bastani/workflows"', 'from "typebox"', "workflow({", "outputs:"]) {
    if (!source.includes(expected)) throw new Error(`${name} missing ${expected}`);
  }
}

const fixtureWorkflow = await readFile(join(root, "workflows/atomic-fixture-pilot.ts"), "utf8");
if ((fixtureWorkflow.match(/ctx\.tool\(/g) ?? []).length !== 5) {
  throw new Error("atomic-fixture-pilot must own exactly five durable ctx.tool nodes");
}
for (const forbidden of ["ctx.task(", "ctx.stage(", "ctx.parallel(", "ctx.chain(", "ctx.ui."]) {
  if (fixtureWorkflow.includes(forbidden)) throw new Error(`atomic-fixture-pilot must remain credential-free and tool-only: ${forbidden}`);
}
for (const requiredFixtureText of [
  "control_plane_run_id",
  "contract_sha256",
  "expected_before_sha256",
  "stop_before_external_action",
  "fresh-deterministic-process",
  "context_pack_path",
  "run_contract_path",
  "launch_manifest_path",
]) {
  if (!fixtureWorkflow.includes(requiredFixtureText)) {
    throw new Error(`atomic-fixture-pilot missing fixed contract text: ${requiredFixtureText}`);
  }
}
const fixtureCore = await readFile(join(root, "lib/atomic-fixture-pilot-core.mjs"), "utf8");

const modelLaunchSchema = JSON.parse(await readFile(join(root, "skills/atomic-workflow-architect/assets/model-launch-manifest.schema.json"), "utf8"));
const modelLaunchTemplate = JSON.parse(await readFile(join(root, "skills/atomic-workflow-architect/assets/model-launch-manifest-template.json"), "utf8"));
if (modelLaunchSchema.$id !== "urn:wesley:atomic:model-launch-manifest:1.1.0") {
  throw new Error("unexpected model launch-manifest schema ID");
}
for (const field of ["inference", "inference_policy_sha256", "package_sha256", "workspace", "sandbox", "approval"]) {
  if (!modelLaunchSchema.required.includes(field) || !Object.hasOwn(modelLaunchTemplate, field)) {
    throw new Error(`model launch manifest must require and template ${field}`);
  }
}
if (modelLaunchTemplate.inference.credential_in_writer !== false
    || modelLaunchTemplate.inference.live_provider_expected !== false
    || modelLaunchTemplate.inference.live_provider_verified !== false
    || modelLaunchTemplate.sandbox.network_policy !== "run_internal_gateway_only"
    || modelLaunchTemplate.bounds.max_repairs !== 1
    || modelLaunchTemplate.bounds.max_concurrency !== 1) {
  throw new Error("model launch manifest template weakens the credential-free inference boundary");
}

const modelFixtureWorkflow = await readFile(join(root, "workflows/atomic-fixture-model-pilot.ts"), "utf8");
for (const requiredModelText of [
  'context: "fresh"',
  'context: "fork"',
  "forkFromSessionFile: implementer.sessionFile",
  'model: ATOMIC_FIXTURE_MODEL_ALIASES.implementer',
  'model: ATOMIC_FIXTURE_MODEL_ALIASES.verifier_initial',
  'model: ATOMIC_FIXTURE_MODEL_ALIASES.repair',
  'model: ATOMIC_FIXTURE_MODEL_ALIASES.verifier_final',
  "max_repair_rounds: 1",
]) {
  const source = requiredModelText === "max_repair_rounds: 1"
    ? await readFile(join(root, "lib/atomic-fixture-model-pilot-core.mjs"), "utf8")
    : modelFixtureWorkflow;
  if (!source.includes(requiredModelText)) throw new Error(`atomic-fixture-model-pilot missing bounded model doctrine: ${requiredModelText}`);
}
for (const forbidden of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "sk-", "~/.atomic", "~/.codex", "~/.claude"]) {
  if (modelFixtureWorkflow.includes(forbidden)) throw new Error(`atomic-fixture-model-pilot must not receive provider credentials or host homes: ${forbidden}`);
}
for (const requiredFixtureCoreText of [
  '"/usr/local/bin/node", "--test"',
  '"/usr/bin/git", "diff", "--check"',
  'final_action: "stop_before_external_action"',
  "canonical_promotion: false",
  "external_request_performed: false",
  "context_copies:",
  'launch.final_action !== "stop_before_pr"',
]) {
  if (!fixtureCore.includes(requiredFixtureCoreText)) {
    throw new Error(`atomic fixture core missing fixed safety contract: ${requiredFixtureCoreText}`);
  }
}
for (const forbiddenFixtureCoreText of ["fetch(", "https://", "ctx.task(", "ctx.ui."]) {
  if (fixtureCore.includes(forbiddenFixtureCoreText)) {
    throw new Error(`atomic fixture core must not use model, HIL, or network execution: ${forbiddenFixtureCoreText}`);
  }
}

function resolveLocalRef(schema, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported non-local JSON Schema ref: ${ref}`);
  return ref.slice(2).split("/").reduce((value, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    return value?.[key];
  }, schema);
}

function validateSchemaValue(value, rule, schema, path = "$") {
  if (rule.$ref) {
    const resolved = resolveLocalRef(schema, rule.$ref);
    if (!resolved) return [`${path}: unresolved schema ref ${rule.$ref}`];
    return validateSchemaValue(value, resolved, schema, path);
  }

  const errors = [];
  if (Object.hasOwn(rule, "const") && !Object.is(value, rule.const)) {
    errors.push(`${path}: expected constant ${JSON.stringify(rule.const)}`);
  }
  if (rule.enum && !rule.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path}: value is not in enum`);
  }

  if (rule.type) {
    const typeMatches = rule.type === "array"
      ? Array.isArray(value)
      : rule.type === "object"
        ? value !== null && typeof value === "object" && !Array.isArray(value)
        : rule.type === "integer"
          ? Number.isInteger(value)
          : rule.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : typeof value === rule.type;
    if (!typeMatches) return [...errors, `${path}: expected type ${rule.type}`];
  }

  if (typeof value === "string") {
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${path}: shorter than minLength`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${path}: longer than maxLength`);
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, "u").test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === "number" && rule.minimum !== undefined && value < rule.minimum) {
    errors.push(`${path}: below minimum ${rule.minimum}`);
  }
  if (typeof value === "number" && rule.maximum !== undefined && value > rule.maximum) {
    errors.push(`${path}: above maximum ${rule.maximum}`);
  }
  if (Array.isArray(value) && rule.items) {
    value.forEach((item, index) => errors.push(...validateSchemaValue(item, rule.items, schema, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const name of rule.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push(`${path}: missing required property ${name}`);
    }
    for (const [name, child] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(value, name)) errors.push(...validateSchemaValue(value[name], child, schema, `${path}.${name}`));
    }
    if (rule.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(rule.properties ?? {}, name)) errors.push(`${path}: unexpected property ${name}`);
      }
    }
  }
  return errors;
}

const launchSchema = JSON.parse(await readFile(join(root, "skills/atomic-workflow-architect/assets/launch-manifest.schema.json"), "utf8"));
if (launchSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error("launch manifest must use JSON Schema 2020-12");
if (launchSchema.$id !== "urn:wesley:atomic:launch-manifest:1.1.0") throw new Error("launch manifest schema ID mismatch");

const requiredLaunchFields = [
  "run_id", "project_id", "task_id", "context_pack_ref", "budget", "final_action",
  "workspace_owner", "workspace_id", "writer_lease", "crossProcessResume", "bounds",
];
for (const field of requiredLaunchFields) {
  if (!launchSchema.required?.includes(field)) throw new Error(`launch manifest schema must require ${field}`);
}
if (!launchSchema.properties?.bounds?.required?.includes("max_turns")) {
  throw new Error("launch manifest schema must require bounds.max_turns");
}
for (const field of ["owner_id", "fencing_token"]) {
  if (!launchSchema.properties?.writer_lease?.required?.includes(field)) {
    throw new Error(`launch manifest schema must require writer_lease.${field}`);
  }
}

const launchManifest = JSON.parse(await readFile(join(root, "skills/atomic-workflow-architect/assets/launch-manifest-template.json"), "utf8"));
const manifestErrors = validateSchemaValue(launchManifest, launchSchema, launchSchema);
if (manifestErrors.length > 0) throw new Error(`launch manifest template failed schema validation:\n${manifestErrors.join("\n")}`);
if (launchManifest.root_runtime !== "atomic") throw new Error("launch manifest root runtime mismatch");
if (launchManifest.workspace_owner !== "control-plane") throw new Error("launch manifest workspace default mismatch");
if (launchManifest.crossProcessResume !== false) throw new Error("launch manifest must default crossProcessResume to false");
if (launchManifest.writer_lease.holder_run_id !== launchManifest.run_id) throw new Error("writer lease holder must match run ID");
if (launchManifest.writer_lease.workspace_id !== launchManifest.workspace_id) throw new Error("writer lease workspace must match workspace ID");
if (!launchManifest.writer_lease.owner_id) throw new Error("writer lease owner ID is required");
if (!Number.isInteger(launchManifest.writer_lease.fencing_token) || launchManifest.writer_lease.fencing_token < 1) {
  throw new Error("writer lease fencing token must be a positive integer");
}

const invalidManifestCases = [
  ["superseded schema version", (manifest) => { manifest.schema_version = "1.0.0"; }],
  ["missing run ID", (manifest) => { delete manifest.run_id; }],
  ["wrong root runtime", (manifest) => { manifest.root_runtime = "codex"; }],
  ["non-boolean resume capability", (manifest) => { manifest.crossProcessResume = "false"; }],
  ["zero max turns", (manifest) => { manifest.bounds.max_turns = 0; }],
  ["missing writer lease", (manifest) => { delete manifest.writer_lease; }],
  ["missing writer lease owner", (manifest) => { delete manifest.writer_lease.owner_id; }],
  ["missing writer lease fence", (manifest) => { delete manifest.writer_lease.fencing_token; }],
  ["non-integer writer lease fence", (manifest) => { manifest.writer_lease.fencing_token = 1.5; }],
  ["non-positive writer lease fence", (manifest) => { manifest.writer_lease.fencing_token = 0; }],
  ["unsafe writer lease fence", (manifest) => { manifest.writer_lease.fencing_token = Number.MAX_SAFE_INTEGER + 1; }],
];
for (const [name, mutate] of invalidManifestCases) {
  const candidate = structuredClone(launchManifest);
  mutate(candidate);
  if (validateSchemaValue(candidate, launchSchema, launchSchema).length === 0) {
    throw new Error(`launch manifest schema accepted invalid case: ${name}`);
  }
}

const cases = [
  ["Build a feature that adds OAuth login", "route"],
  ["I have an idea for Ovalo: turn videos into lessons", "route"],
  ["New Signal Ledger idea: add a source confidence graph", "route"],
  ["Plan an Ovalo project for live role-play games", "route"],
  ["Can you review this pull request and verify the tests?", "route"],
  ["Can you research Atomic workflow durability?", "route"],
  ["quickly rebase this PR", "route"],
  ["What is Atomic?", "continue"],
  ["How does Atomic compaction work?", "continue"],
  ["Summarize this file", "continue"],
  ["Can you research cafes in Tokyo?", "continue"],
  ["Build me a meal plan", "continue"],
  ["direct: fix the README typo", "bypass"],
  ["atomic: evaluate this architecture", "route"],
  ["/workflow list", "continue"],
  ["Thanks", "continue"],
];
for (const [input, expected] of cases) {
  const actual = routePrompt(input).mode;
  if (actual !== expected) throw new Error(`router ${JSON.stringify(input)}: expected ${expected}, got ${actual}`);
}

const promptFiles = await readdir(join(root, "prompts"));
for (const name of ["atomic-plan.md", "atomic-execute.md", "atomic-status.md", "atomic-idea.md", "atomic-project.md"]) {
  if (!promptFiles.includes(name)) throw new Error(`prompt missing: ${name}`);
}

console.log(`Verified ${required.length} required files, ${workflowFiles.length} workflows, ${cases.length} routing cases, ${promptFiles.length} prompt templates, and the launch-manifest schema with ${invalidManifestCases.length} rejection cases.`);
