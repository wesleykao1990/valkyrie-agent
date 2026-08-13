import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ManagedSkillSuiteManager,
  inspectManagedSkillSuite,
  loadManagedSkillSuitePolicy,
  type ManagedSkillSuitePolicy,
} from "../apps/control-plane/src/managed-skill-suites.ts";

function fixture(name = "managed-skills") {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const source = join(root, "source");
  const store = join(root, "store");
  mkdirSync(source, { recursive: true });
  return { root, source, store };
}

function skill(root: string, directory: string, input: {
  name: string;
  version?: string;
  tools?: string[];
  body?: string;
}) {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), [
    "---",
    `name: ${input.name}`,
    `version: ${input.version ?? "1.0.0"}`,
    `description: ${input.name} fixture`,
    "allowed-tools:",
    ...(input.tools ?? []).map((tool) => `- ${tool}`),
    "---",
    input.body ?? `# ${input.name}`,
    "",
  ].join("\n"));
}

function rawSkill(root: string, directory: string, content: string): string {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  const file = join(path, "SKILL.md");
  writeFileSync(file, content);
  return file;
}

function basePolicy(source: string, suiteId = "fixture-suite"): ManagedSkillSuitePolicy {
  return {
    schemaVersion: "1.1.0",
    suiteId,
    displayName: "Fixture Suite",
    version: "1.0.0",
    source: { kind: "local-directory", path: source, expectedSha256: "0".repeat(64) },
    trustProfile: "trusted-development",
    projects: ["ovalo"],
    runtimes: [
      { runtime: "codex", mode: "native" },
      { runtime: "claude-code", mode: "native" },
      { runtime: "atomic", mode: "delegated" },
      { runtime: "hermes", mode: "request-only" },
    ],
    telemetry: "disabled",
    updates: "reviewed-compatible",
    allowCapabilityExpansion: false,
    manifestDialect: "skill-frontmatter-v1",
    capabilityOverrides: [],
  };
}

function acceptedPolicy(source: string, suiteId = "fixture-suite"): ManagedSkillSuitePolicy {
  const policy = basePolicy(source, suiteId);
  const inspected = inspectManagedSkillSuite(policy);
  return { ...policy, source: { ...policy.source, expectedSha256: inspected.treeSha256 } };
}

test("managed suite inspection discovers skills and derives capabilities without executing source", () => {
  const item = fixture("managed-inspect");
  skill(item.source, "review", { name: "review", tools: ["Read", "Grep", "AskUserQuestion"] });
  skill(item.source, "qa", { name: "qa", tools: ["Bash", "Read", "Write", "WebSearch", "Agent"] });
  writeFileSync(join(item.source, "README.md"), "Telemetry is documented but disabled by policy.\n");
  const inspected = inspectManagedSkillSuite(basePolicy(item.source));
  assert.equal(inspected.skills.length, 2);
  assert.deepEqual(inspected.skills.find((entry) => entry.name === "review")?.requiredCapabilities,
    ["filesystem-read", "human-input"]);
  assert.deepEqual(inspected.skills.find((entry) => entry.name === "qa")?.requiredCapabilities,
    ["filesystem-read", "filesystem-write", "public-network", "shell", "subagents"]);
  assert.match(inspected.treeSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(inspected.warnings, ["Source mentions telemetry; managed execution keeps telemetry disabled"]);
});

test("accepted YAML authority dialect supports tools aliases, arrays, blocks, and multiline scalars", () => {
  const item = fixture("managed-yaml-dialect");
  rawSkill(item.source, "tools-inline", `---\nname: tools-inline\ntools: [Read, Bash(git:*)]\n---\n# Inline\n`);
  rawSkill(item.source, "allowed-inline", `---\nname: allowed-inline\nallowed-tools: [Read, WebSearch]\n---\n# Inline alias\n`);
  rawSkill(item.source, "block", `---\nname: block\ntools:\n  - Read\n  - AskUserQuestion\n---\n# Block\n`);
  rawSkill(item.source, "multiline", `---\nname: multiline\nallowed-tools: >-\n  Read,\n  Grep\n---\n# Folded\n`);
  const inspected = inspectManagedSkillSuite(basePolicy(item.source));
  assert.equal(inspected.skills.every((entry) => entry.compatible), true);
  assert.deepEqual(inspected.skills.find((entry) => entry.name === "tools-inline")?.requiredCapabilities,
    ["filesystem-read", "shell"]);
  assert.deepEqual(inspected.skills.find((entry) => entry.name === "allowed-inline")?.requiredCapabilities,
    ["filesystem-read", "public-network"]);
  assert.equal(inspected.skills.find((entry) => entry.name === "block")?.authoritySource, "tools");
  assert.equal(inspected.skills.find((entry) => entry.name === "multiline")?.authoritySource, "allowed-tools");
});

test("missing, malformed, duplicate, conflicting, and nested authority declarations fail closed", () => {
  const cases = [
    ["missing", `---\nname: missing\ndescription: no authority\n---\n# Missing\n`],
    ["malformed", `---\nname: [unterminated\nallowed-tools: [Read]\n---\n# Malformed\n`],
    ["duplicate", `---\nname: duplicate\nname: duplicate\nallowed-tools: [Read]\n---\n# Duplicate\n`],
    ["conflicting", `---\nname: conflicting\ntools: [Read]\nallowed-tools: [Read]\n---\n# Conflict\n`],
    ["nested", `---\nname: nested\nallowed-tools: [Read]\nmetadata:\n  tools: [Bash]\n---\n# Nested\n`],
    ["unknown-authority", `---\nname: unknown-authority\nallowed-tools: [Read]\npermissions: [network]\n---\n# Unknown authority\n`],
    ["unknown-compound-authority", `---\nname: unknown-compound-authority\nallowed-tools: [Read]\nruntime_permissions:\n  network-access: true\n---\n# Unknown compound authority\n`],
  ] as const;
  for (const [directory, content] of cases) {
    const item = fixture(`managed-${directory}`);
    rawSkill(item.source, directory, content);
    const descriptor = inspectManagedSkillSuite(basePolicy(item.source)).skills[0];
    assert.equal(descriptor.compatible, false, directory);
    assert.equal(descriptor.authorityIssues.length > 0, true, directory);
    const manager = new ManagedSkillSuiteManager({ root: item.store });
    manager.install(acceptedPolicy(item.source));
    assert.throws(() => manager.capabilityPack({
      suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex", skills: [descriptor.name],
    }), /operator-gated/i, directory);
  }
});

test("a digest-bound policy override can complete missing upstream authority but cannot hide detected risk", () => {
  const item = fixture("managed-policy-override");
  rawSkill(item.source, "advisory", `---\nname: advisory\ndescription: reviewed local advisory skill\n---\n# Advisory\n`);
  const policy = basePolicy(item.source);
  policy.trustProfile = "restricted-advisory";
  policy.capabilityOverrides = [{
    skill: "advisory",
    capabilities: ["filesystem-read"],
    reason: "Upstream manifest has no authority field; exact reviewed bytes require read-only file access.",
  }];
  const inspection = inspectManagedSkillSuite(policy);
  assert.equal(inspection.skills[0].authoritySource, "policy-override");
  assert.deepEqual(inspection.skills[0].authorityIssues, []);
  assert.equal(inspection.skills[0].compatible, true);
  const accepted = { ...policy, source: { ...policy.source, expectedSha256: inspection.treeSha256 } };
  const manager = new ManagedSkillSuiteManager({ root: item.store });
  manager.install(accepted);
  assert.deepEqual(manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex" })
    .requiredCapabilities, ["filesystem-read"]);
});

test("executable setup, package lifecycle, and MCP definitions add capabilities and require explicit coverage", () => {
  const item = fixture("managed-source-risk");
  skill(item.source, "builder", { name: "builder", tools: ["Bash", "Read", "WebSearch"] });
  const setup = join(item.source, "setup.sh");
  writeFileSync(setup, "#!/bin/sh\nnpm install\n");
  chmodSync(setup, 0o755);
  writeFileSync(join(item.source, "package.json"), JSON.stringify({
    dependencies: { example: "1.0.0" },
    scripts: { postinstall: "node setup.js" },
  }));
  writeFileSync(join(item.source, "mcp.json"), JSON.stringify({
    mcpServers: { remote: { url: "https://example.invalid", headers: { authorization: "env" } } },
  }));
  const descriptor = inspectManagedSkillSuite(basePolicy(item.source)).skills[0];
  assert.deepEqual(descriptor.requiredCapabilities,
    ["credentials", "filesystem-read", "host-administration", "public-network", "shell"]);
  assert.equal(descriptor.compatible, false);
  assert.ok(descriptor.authorityIssues.includes("undeclared-detected-capability:credentials"));
  assert.ok(descriptor.authorityIssues.includes("undeclared-detected-capability:host-administration"));
});

test("static name and body scanning is additive and never satisfies authority", () => {
  const item = fixture("managed-additive-risk");
  rawSkill(item.source, "safe-label", `---\nname: safe-label\nallowed-tools: [Read]\n---\nUse OAuth credentials, browser automation, and a public web search.\nCreate and deploy a release, then self-update.\n`);
  const descriptor = inspectManagedSkillSuite(basePolicy(item.source)).skills[0];
  assert.deepEqual(descriptor.requiredCapabilities, [
    "browser", "credentials", "external-action", "filesystem-read", "public-network", "self-update",
  ]);
  assert.equal(descriptor.compatible, false);
  assert.ok(descriptor.authorityIssues.includes("undeclared-detected-capability:browser"));
  assert.ok(descriptor.blockedCapabilities.includes("credentials"));
});

test("suite install is content-addressed, idempotent, private, and produces a verified run pack", () => {
  const item = fixture("managed-install");
  skill(item.source, "review", { name: "review", tools: ["Read", "Grep"] });
  skill(item.source, "qa", { name: "qa", tools: ["Bash", "Read", "Write"] });
  const policy = acceptedPolicy(item.source);
  const manager = new ManagedSkillSuiteManager({ root: item.store, now: () => new Date("2026-08-14T00:00:00Z") });
  const installed = manager.install(policy);
  assert.equal(installed.state, "active");
  assert.equal(installed.objectRef, `objects/fixture-suite/${installed.treeSha256}`);
  assert.deepEqual(manager.install(policy), installed);
  const status = manager.status();
  assert.equal(status.enabled, true);
  assert.equal(JSON.stringify(status).includes(item.source), false, "Status must not expose the operator source path");
  assert.equal("description" in status.suites[0].skills[0], false, "Status must not echo untrusted skill prose");
  assert.equal("relativePath" in status.suites[0].skills[0], false, "Status must not echo source filenames");
  assert.equal("declaredTools" in status.suites[0].skills[0], false, "Status exposes normalized capabilities only");
  const pack = manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex" });
  assert.deepEqual(pack.skills.map((entry) => entry.name), ["qa", "review"]);
  assert.equal(pack.runtimeMode, "native");
  assert.equal(pack.finalActionsRemainControlPlaneGated, true);
  assert.match(pack.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(manager.verifyCapabilityPack(pack), pack);
  assert.throws(() => manager.verifyCapabilityPack({ ...pack, suiteVersion: "changed" }), /digest is invalid/i);
});

test("operator-gated skills install with the suite but cannot enter an ordinary runtime pack", () => {
  const item = fixture("managed-gated");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  skill(item.source, "land-and-deploy", { name: "land-and-deploy", tools: ["Bash", "Read", "Write"] });
  const manager = new ManagedSkillSuiteManager({ root: item.store });
  const installed = manager.install(acceptedPolicy(item.source));
  const gated = installed.skills.find((entry) => entry.name === "land-and-deploy");
  assert.equal(gated?.compatible, false);
  assert.deepEqual(gated?.blockedCapabilities, ["external-action"]);
  assert.deepEqual(manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex" })
    .skills.map((entry) => entry.name), ["review"]);
  assert.throws(() => manager.capabilityPack({
    suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex", skills: ["land-and-deploy"],
  }), /operator-gated/i);
});

test("scoped tool declarations classify conservatively and unknown tools remain gated", () => {
  const item = fixture("managed-scoped-tools");
  skill(item.source, "scoped-shell", { name: "scoped-shell", tools: ["Bash(git:*)", "Read"] });
  skill(item.source, "unknown", { name: "unknown", tools: ["FutureOpaqueTool"] });
  const inspected = inspectManagedSkillSuite(basePolicy(item.source));
  assert.deepEqual(inspected.skills.find((entry) => entry.name === "scoped-shell")?.requiredCapabilities,
    ["filesystem-read", "shell"]);
  const unknown = inspected.skills.find((entry) => entry.name === "unknown");
  assert.equal(unknown?.compatible, false);
  assert.deepEqual(unknown?.unclassifiedTools, ["FutureOpaqueTool"]);
  const manager = new ManagedSkillSuiteManager({ root: item.store });
  manager.install({ ...basePolicy(item.source), source: {
    ...basePolicy(item.source).source, expectedSha256: inspected.treeSha256,
  } });
  const status = manager.status();
  assert.equal(status.suites[0].skills.find((entry) => entry.name === "unknown")?.hasUnclassifiedTools, true);
  assert.equal(JSON.stringify(status).includes("FutureOpaqueTool"), false);
});

test("project and runtime grants are enforced while Hermes remains request-only", () => {
  const item = fixture("managed-grants");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  const manager = new ManagedSkillSuiteManager({ root: item.store });
  manager.install(acceptedPolicy(item.source));
  assert.throws(() => manager.capabilityPack({ suiteId: "fixture-suite", projectId: "foreign", runtime: "codex" }), /project/i);
  assert.equal(manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "hermes" }).runtimeMode,
    "request-only");
  const codexOnly = acceptedPolicy(item.source, "codex-suite");
  codexOnly.runtimes = [{ runtime: "codex", mode: "native" }];
  manager.install(codexOnly);
  assert.throws(() => manager.capabilityPack({ suiteId: "codex-suite", projectId: "ovalo", runtime: "atomic" }), /runtime/i);
});

test("compatible updates activate automatically while privilege expansion is quarantined until explicit acceptance", () => {
  const item = fixture("managed-update");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  const manager = new ManagedSkillSuiteManager({ root: item.store, now: () => new Date("2026-08-14T00:00:00Z") });
  const firstPolicy = acceptedPolicy(item.source);
  const first = manager.install(firstPolicy);

  const nextSource = join(item.root, "next");
  mkdirSync(nextSource);
  skill(nextSource, "review", { name: "review", version: "1.1.0", tools: ["Read", "WebSearch"] });
  const nextPolicy = acceptedPolicy(nextSource);
  nextPolicy.version = "1.1.0";
  const next = manager.install(nextPolicy);
  assert.equal(next.state, "quarantined");
  assert.deepEqual(next.expansion, ["public-network"]);
  assert.equal(manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex" }).suiteSha256,
    first.treeSha256);
  assert.throws(() => manager.activate("fixture-suite", next.treeSha256), /expands capabilities/i);
  assert.equal(manager.activate("fixture-suite", next.treeSha256, true).state, "active");
  assert.equal(manager.rollback("fixture-suite", first.treeSha256).treeSha256, first.treeSha256);
});

test("manual update policy installs a compatible generation without changing the active suite", () => {
  const item = fixture("managed-manual-update");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  const manager = new ManagedSkillSuiteManager({ root: item.store });
  const firstPolicy = acceptedPolicy(item.source);
  firstPolicy.updates = "manual";
  const first = manager.install(firstPolicy);
  assert.equal(first.state, "active");
  const nextSource = join(item.root, "next");
  mkdirSync(nextSource);
  skill(nextSource, "review", { name: "review", version: "1.0.1", tools: ["Read"], body: "# Reviewed update" });
  const nextPolicy = acceptedPolicy(nextSource);
  nextPolicy.version = "1.0.1";
  nextPolicy.updates = "manual";
  const next = manager.install(nextPolicy);
  assert.equal(next.state, "installed");
  assert.equal(manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex" }).suiteSha256,
    first.treeSha256);
  assert.equal(manager.activate("fixture-suite", next.treeSha256).treeSha256, next.treeSha256);
});

test("source links, digest drift, and installed object tampering fail closed", () => {
  const linked = fixture("managed-link");
  skill(linked.source, "review", { name: "review", tools: ["Read"] });
  writeFileSync(join(linked.root, "outside"), "outside\n");
  symlinkSync(join(linked.root, "outside"), join(linked.source, "link"));
  assert.throws(() => inspectManagedSkillSuite(basePolicy(linked.source)), /links/i);

  const unsafeName = fixture("managed-unsafe-name");
  skill(unsafeName.source, "review", { name: "review", tools: ["Read"] });
  writeFileSync(join(unsafeName.source, "untrusted\nstatus.txt"), "not exposed\n");
  assert.throws(() => inspectManagedSkillSuite(basePolicy(unsafeName.source)), /escaped its root/i);

  const item = fixture("managed-drift");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  const policy = acceptedPolicy(item.source);
  writeFileSync(join(item.source, "review", "SKILL.md"), `${readFileSync(join(item.source, "review", "SKILL.md"), "utf8")}changed\n`);
  const manager = new ManagedSkillSuiteManager({ root: item.store });
  assert.throws(() => manager.install(policy), /digest does not match/i);

  const cleanPolicy = acceptedPolicy(item.source);
  const record = manager.install(cleanPolicy);
  writeFileSync(join(manager.root, record.objectRef, "review", "SKILL.md"), "tampered\n");
  assert.equal(manager.status().suites[0].state, "quarantined");
  assert.throws(() => manager.capabilityPack({ suiteId: "fixture-suite", projectId: "ovalo", runtime: "codex" }), /integrity/i);
});

test("policy loading binds exact bytes and rejects runtime privilege mismatches", () => {
  const item = fixture("managed-policy");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  const policy = acceptedPolicy(item.source);
  const path = join(item.root, "policy.json");
  const body = `${JSON.stringify(policy)}\n`;
  writeFileSync(path, body);
  const digest = createHash("sha256").update(body).digest("hex");
  assert.deepEqual(loadManagedSkillSuitePolicy({ path, acceptedSha256: digest }), policy);
  assert.throws(() => loadManagedSkillSuitePolicy({ path, acceptedSha256: "f".repeat(64) }), /digest/i);
  writeFileSync(path, `${JSON.stringify({ ...policy, runtimes: [{ runtime: "hermes", mode: "native" }] })}\n`);
  const changed = readFileSync(path);
  assert.throws(() => loadManagedSkillSuitePolicy({
    path, acceptedSha256: createHash("sha256").update(changed).digest("hex"),
  }), /Hermes receives only request-level/i);
});

test("operator CLI installs from accepted policy bytes and reports path-opaque status", () => {
  const item = fixture("managed-cli");
  skill(item.source, "review", { name: "review", tools: ["Read"] });
  const policy = acceptedPolicy(item.source);
  const policyPath = join(item.root, "policy.json");
  const policyBody = `${JSON.stringify(policy)}\n`;
  writeFileSync(policyPath, policyBody);
  const policyDigest = createHash("sha256").update(policyBody).digest("hex");
  const install = spawnSync(process.execPath, [
    "--experimental-strip-types", "scripts/manage-skill-suite.ts", "install",
    "--policy", policyPath,
    "--policy-sha256", policyDigest,
    "--root", item.store,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).state, "active");
  const status = spawnSync(process.execPath, [
    "--experimental-strip-types", "scripts/manage-skill-suite.ts", "status", "--root", item.store,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).suites[0].suiteId, "fixture-suite");
  assert.equal(status.stdout.includes(item.source), false);
});
