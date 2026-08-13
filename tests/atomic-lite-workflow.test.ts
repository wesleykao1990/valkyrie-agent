import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const liteModulePath = ["..", "packages", "atomic-workflow-architect", "lib", "atomic-lite-writer-core.mjs"].join("/");
const liteCore: any = await import(liteModulePath);
const {
  ATOMIC_LITE_CONTEXT_ROOT,
  ATOMIC_LITE_OUTPUT_PATHS,
  ATOMIC_LITE_POLICY_EXAMPLE,
  ATOMIC_LITE_WORKFLOW_NAME,
  createAtomicLiteCustomTools,
  emitAtomicLiteEvidence,
  preflightAtomicLite,
  runAtomicLiteChecks,
  validateAtomicLiteInputs,
  validateAtomicLitePolicy,
  writeAtomicLiteFile,
  writeAtomicLiteReview,
} = liteCore;

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git fixture command failed");
}

function fixture(overrides: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-lite-")));
  const workspace = join(root, "workspace");
  const context = join(root, "context");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "test"), { recursive: true });
  mkdirSync(context);
  writeFileSync(join(workspace, "src", "index.js"), "export const answer = 42;\n");
  writeFileSync(join(workspace, "test", "index.test.js"), "import test from 'node:test'; test('ok', () => {});\n");
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["add", "."]);
  git(workspace, ["-c", "user.name=Atomic Lite Test", "-c", "user.email=atomic-lite@example.invalid", "commit", "--quiet", "-m", "baseline"]);
  const policy = structuredClone(ATOMIC_LITE_POLICY_EXAMPLE) as any;
  policy.checks[0].executable = process.execPath;
  policy.checks[0].argv = ["-e", "process.exit(0)"];
  Object.assign(policy, overrides);
  const policyBody = json(policy);
  const inputs = {
    control_plane_run_id: "run_atomic_lite_test",
    contract_sha256: "",
    policy_sha256: sha(policyBody),
    context_sha256: "",
  };
  const request = "Implement the bounded test change and stop before external action.";
  const contextBody = json({
    schemaVersion: "1.0.0",
    projectId: "atomic-lite-test",
    taskId: "LITE-1",
    request,
    acceptedContext: [{ authority: "linear", content: "Accepted test context for the bounded fixture." }],
  });
  inputs.context_sha256 = sha(contextBody);
  const contractBody = json({
    schemaVersion: "1.0.0",
    runId: inputs.control_plane_run_id,
    projectId: "atomic-lite-test",
    taskId: "LITE-1",
    request,
    rootRuntime: "atomic",
    workflow: ATOMIC_LITE_WORKFLOW_NAME,
    finalAction: "stop_before_external_action",
    policySha256: inputs.policy_sha256,
    contextSha256: inputs.context_sha256,
    crossProcessResume: false,
  });
  inputs.contract_sha256 = sha(contractBody);
  writeFileSync(join(context, "atomic-lite-contract.json"), contractBody);
  writeFileSync(join(context, "atomic-lite-policy.json"), policyBody);
  writeFileSync(join(context, "atomic-lite-context.json"), contextBody);
  return { root, workspace, context, inputs, policy };
}

test("Atomic Lite validates hash-bound contract/policy and emits deterministic no-review evidence", async () => {
  const item = fixture();
  try {
    const preflight = await preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs });
    assert.equal(preflight.contract.workflow, ATOMIC_LITE_WORKFLOW_NAME);
    assert.equal(preflight.policy.reviewerRequired, false);
    assert.equal(preflight.contextSummary.ref, `${ATOMIC_LITE_CONTEXT_ROOT}/atomic-lite-context.json`);
    const write = await writeAtomicLiteFile({
      workspacePath: item.workspace,
      policy: preflight.policy,
      relativePath: "src/index.js",
      content: "export const answer = 43;\n",
    });
    assert.match(write.sha256, /^[a-f0-9]{64}$/);
    const initialChecks = await runAtomicLiteChecks({ workspacePath: item.workspace, policy: preflight.policy, baseline: preflight.baseline, gitBaseline: preflight.git, round: "initial" });
    const finalChecks = await runAtomicLiteChecks({ workspacePath: item.workspace, policy: preflight.policy, baseline: preflight.baseline, gitBaseline: preflight.git, round: "final" });
    assert.equal(initialChecks.passed, true);
    assert.equal(finalChecks.passed, true);
    const review = await writeAtomicLiteReview({ workspacePath: item.workspace, reviewNotRequired: true });
    assert.equal(review.decision, "review-not-required");
    const output = await emitAtomicLiteEvidence({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
      preflight,
      initialChecks,
      finalChecks,
      review,
      repairCount: 0,
    });
    assert.equal(output.review_decision, "review-not-required");
    assert.equal(output.repair_count, 0);
    assert.equal(existsSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.delta)), true);
    const evidence = JSON.parse(readFileSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.evidence), "utf8"));
    assert.equal(evidence.model_execution_attempted, true);
    assert.equal(evidence.reviewer_model_execution_attempted, false);
    assert.equal(evidence.contract_sha256, item.inputs.contract_sha256);
    assert.equal(evidence.policy_sha256, item.inputs.policy_sha256);
    assert.equal(evidence.context_sha256, item.inputs.context_sha256);
    assert.equal(JSON.parse(readFileSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.contract), "utf8")).runId, item.inputs.control_plane_run_id);
    assert.deepEqual(
      readFileSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.context), "utf8"),
      readFileSync(join(item.context, "atomic-lite-context.json"), "utf8"),
    );
    assert.match(readFileSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.patch), "utf8"), /diff --git/);
    assert.notEqual(
      readFileSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.patch), "utf8"),
      readFileSync(join(item.workspace, ATOMIC_LITE_OUTPUT_PATHS.delta), "utf8"),
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite custom tools expose usable policy-derived schemas and require readable writes", async () => {
  const item = fixture();
  try {
    const preflight = await preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs });
    const tools = createAtomicLiteCustomTools(item.workspace, preflight.policy);
    const listTool = tools.find((tool: any) => tool.name === "atomic_lite_list") as any;
    const readTool = tools.find((tool: any) => tool.name === "atomic_lite_read") as any;
    const writeTool = tools.find((tool: any) => tool.name === "atomic_lite_write") as any;
    assert.deepEqual(readTool.parameters.properties.path.enum, preflight.policy.workspace.read);
    assert.deepEqual(readTool.parameters.required, ["path"]);
    assert.equal(readTool.parameters.additionalProperties, false);
    assert.deepEqual(writeTool.parameters.properties.path.enum, preflight.policy.workspace.write);
    assert.equal(writeTool.parameters.properties.content.maxLength, preflight.policy.bounds.maxFileBytes);
    assert.deepEqual(writeTool.parameters.required, ["path", "content"]);
    assert.equal(writeTool.parameters.additionalProperties, false);
    assert.deepEqual(listTool.parameters.required, []);

    // The workflow passes the pinned TypeBox namespace.  This tiny constructor
    // harness exercises that branch without installing a provider package in
    // the standalone core test process.
    const typebox = {
      Literal: (value: string) => ({ kind: "Literal", const: value }),
      Union: (items: unknown[], options: Record<string, unknown>) => ({ kind: "Union", anyOf: items, ...options }),
      String: (options: Record<string, unknown>) => ({ kind: "String", type: "string", ...options }),
      Object: (properties: Record<string, unknown>, options: Record<string, unknown>) => ({
        kind: "Object",
        type: "object",
        properties,
        required: Object.keys(properties),
        ...options,
      }),
    };
    const typedTools = createAtomicLiteCustomTools(item.workspace, preflight.policy, typebox);
    const typedRead = typedTools.find((tool: any) => tool.name === "atomic_lite_read") as any;
    const typedWrite = typedTools.find((tool: any) => tool.name === "atomic_lite_write") as any;
    assert.equal(typedRead.parameters.kind, "Object");
    assert.equal(typedRead.parameters.properties.path.kind, "Union");
    assert.deepEqual(typedRead.parameters.properties.path.enum, preflight.policy.workspace.read);
    assert.equal(typedWrite.parameters.properties.content.kind, "String");
    assert.equal(typedWrite.parameters.properties.content.maxLength, preflight.policy.bounds.maxFileBytes);

    assert.throws(() => validateAtomicLitePolicy({
      ...item.policy,
      workspace: { read: ["test/index.test.js"], write: ["src/index.js"] },
    }), /must also be readable/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite rejects tampered context and copies the exact accepted context bytes", async () => {
  const item = fixture();
  try {
    const tampered = JSON.parse(readFileSync(join(item.context, "atomic-lite-context.json"), "utf8"));
    tampered.acceptedContext[0].content = "tampered";
    tampered.untrusted = true;
    const contextBody = json(tampered);
    writeFileSync(join(item.context, "atomic-lite-context.json"), contextBody);
    item.inputs.context_sha256 = sha(contextBody);
    const contract = JSON.parse(readFileSync(join(item.context, "atomic-lite-contract.json"), "utf8"));
    contract.contextSha256 = item.inputs.context_sha256;
    const contractBody = json(contract);
    writeFileSync(join(item.context, "atomic-lite-contract.json"), contractBody);
    item.inputs.contract_sha256 = sha(contractBody);
    await assert.rejects(
      preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs }),
      /exactly|unexpected fields/i,
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite rejects extra fields, traversal, links, shell strings, and loose executables", async () => {
  assert.throws(() => validateAtomicLiteInputs({
    control_plane_run_id: "run_atomic_lite_test",
    contract_sha256: "a".repeat(64),
    policy_sha256: "b".repeat(64),
    context_sha256: "c".repeat(64),
    extra: true,
  }), /exactly/i);
  assert.throws(() => validateAtomicLitePolicy({
    ...ATOMIC_LITE_POLICY_EXAMPLE,
    workspace: { read: ["../outside.js"], write: ["src/index.js"] },
  }), /relative|unsafe|segment/i);
  assert.throws(() => validateAtomicLitePolicy({
    ...ATOMIC_LITE_POLICY_EXAMPLE,
    checks: [{ ...ATOMIC_LITE_POLICY_EXAMPLE.checks[0], executable: "node" }],
  }), /absolute/i);
  assert.throws(() => validateAtomicLitePolicy({
    ...ATOMIC_LITE_POLICY_EXAMPLE,
    checks: [{ ...ATOMIC_LITE_POLICY_EXAMPLE.checks[0], executable: "/bin/sh", argv: ["-c", "echo unsafe"] }],
  }), /shell/i);

  const item = fixture();
  try {
    symlinkSync(join(item.workspace, "src", "index.js"), join(item.workspace, "src", "link.js"));
    const symlinkPolicy = structuredClone(item.policy) as any;
    symlinkPolicy.workspace.read = ["src/link.js", "src/index.js"];
    symlinkPolicy.workspace.write = ["src/index.js"];
    const symlinkBody = json(symlinkPolicy);
    writeFileSync(join(item.context, "atomic-lite-policy.json"), symlinkBody);
    const inputs = { ...item.inputs, policy_sha256: sha(symlinkBody) };
    const contract = JSON.parse(readFileSync(join(item.context, "atomic-lite-contract.json"), "utf8"));
    contract.policySha256 = inputs.policy_sha256;
    const contractBody = json(contract);
    writeFileSync(join(item.context, "atomic-lite-contract.json"), contractBody);
    inputs.contract_sha256 = sha(contractBody);
    await assert.rejects(preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs }), /symlink/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite rejects hardlinks and oversized deterministic check output", async () => {
  const item = fixture();
  try {
    linkSync(join(item.workspace, "src", "index.js"), join(item.workspace, "src", "hardlink.js"));
    const hardlinkPolicy = structuredClone(item.policy) as any;
    hardlinkPolicy.workspace.read = ["src/hardlink.js", "src/index.js"];
    const policyBody = json(hardlinkPolicy);
    writeFileSync(join(item.context, "atomic-lite-policy.json"), policyBody);
    const contract = JSON.parse(readFileSync(join(item.context, "atomic-lite-contract.json"), "utf8"));
    contract.policySha256 = sha(policyBody);
    const contractBody = json(contract);
    writeFileSync(join(item.context, "atomic-lite-contract.json"), contractBody);
    const inputs = { ...item.inputs, contract_sha256: sha(contractBody), policy_sha256: sha(policyBody) };
    await assert.rejects(preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs }), /single-link|hardlink/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }

  const outputFixture = fixture();
  try {
    outputFixture.policy.bounds.maxOutputBytes = 100;
    outputFixture.policy.checks[0].maxOutputBytes = 100;
    outputFixture.policy.checks[0].argv = ["-e", "process.stdout.write('x'.repeat(10000))"];
    const policyBody = json(outputFixture.policy);
    writeFileSync(join(outputFixture.context, "atomic-lite-policy.json"), policyBody);
    const contract = JSON.parse(readFileSync(join(outputFixture.context, "atomic-lite-contract.json"), "utf8"));
    contract.policySha256 = sha(policyBody);
    const contractBody = json(contract);
    writeFileSync(join(outputFixture.context, "atomic-lite-contract.json"), contractBody);
    const inputs = { ...outputFixture.inputs, contract_sha256: sha(contractBody), policy_sha256: sha(policyBody) };
    const preflight = await preflightAtomicLite({ workspacePath: outputFixture.workspace, contextRoot: outputFixture.context, inputs });
    const checks = await runAtomicLiteChecks({ workspacePath: outputFixture.workspace, policy: preflight.policy, gitBaseline: preflight.git, round: "initial" });
    assert.equal(checks.passed, false);
    assert.match(checks.findings.join(" "), /output|exit/i);
  } finally {
    rmSync(outputFixture.root, { recursive: true, force: true });
  }
});

test("Atomic Lite caps an in-flight check at maxElapsed and waits only bounded post-kill close", async () => {
  assert.throws(() => validateAtomicLitePolicy({
    ...ATOMIC_LITE_POLICY_EXAMPLE,
    bounds: { ...ATOMIC_LITE_POLICY_EXAMPLE.bounds, maxElapsedSeconds: 1, maxCommandSeconds: 2 },
  }), /maxCommandSeconds.*maxElapsedSeconds/i);

  const item = fixture({
    bounds: { ...ATOMIC_LITE_POLICY_EXAMPLE.bounds, maxElapsedSeconds: 1, maxCommandSeconds: 1 },
    checks: [{
      ...ATOMIC_LITE_POLICY_EXAMPLE.checks[0],
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
    }],
  });
  try {
    const preflight = await preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs });
    const started = Date.now();
    const checks = await runAtomicLiteChecks({ workspacePath: item.workspace, policy: preflight.policy, gitBaseline: preflight.git, round: "initial" });
    const elapsed = Date.now() - started;
    assert.equal(checks.passed, false);
    assert.match(checks.findings.join(" "), /elapsed_bound_exceeded/i);
    assert.ok(elapsed < 5_000, `bounded check took ${elapsed}ms`);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite binds evidence to the exact contract and policy bytes", async () => {
  const item = fixture();
  try {
    const preflight = await preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs });
    const checks = await runAtomicLiteChecks({ workspacePath: item.workspace, policy: preflight.policy, gitBaseline: preflight.git, round: "final" });
    const review = await writeAtomicLiteReview({ workspacePath: item.workspace, reviewNotRequired: true });
    writeFileSync(join(item.context, "atomic-lite-policy.json"), `${readFileSync(join(item.context, "atomic-lite-policy.json"), "utf8")} `);
    await assert.rejects(emitAtomicLiteEvidence({
      workspacePath: item.workspace,
      contextRoot: item.context,
      inputs: item.inputs,
      preflight,
      finalChecks: checks,
      review,
      repairCount: 0,
    }), /hash changed|checksum|policy/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite rejects empty candidate diffs and records distinct reviewer model truth", async () => {
  const empty = fixture();
  try {
    const preflight = await preflightAtomicLite({ workspacePath: empty.workspace, contextRoot: empty.context, inputs: empty.inputs });
    const checks = await runAtomicLiteChecks({ workspacePath: empty.workspace, policy: preflight.policy, baseline: preflight.baseline, gitBaseline: preflight.git, round: "final" });
    const review = await writeAtomicLiteReview({ workspacePath: empty.workspace, reviewNotRequired: true });
    await assert.rejects(emitAtomicLiteEvidence({
      workspacePath: empty.workspace,
      contextRoot: empty.context,
      inputs: empty.inputs,
      preflight,
      finalChecks: checks,
      review,
      repairCount: 0,
    }), /changed|diff/i);
  } finally {
    rmSync(empty.root, { recursive: true, force: true });
  }

  const reviewed = fixture({ reviewerRequired: true });
  try {
    const preflight = await preflightAtomicLite({ workspacePath: reviewed.workspace, contextRoot: reviewed.context, inputs: reviewed.inputs });
    await writeAtomicLiteFile({ workspacePath: reviewed.workspace, policy: preflight.policy, relativePath: "src/index.js", content: "export const answer = 44;\n" });
    const checks = await runAtomicLiteChecks({ workspacePath: reviewed.workspace, policy: preflight.policy, baseline: preflight.baseline, gitBaseline: preflight.git, round: "final" });
    const review = await writeAtomicLiteReview({ workspacePath: reviewed.workspace, review: { approved: true, findings: [] } });
    const output = await emitAtomicLiteEvidence({
      workspacePath: reviewed.workspace,
      contextRoot: reviewed.context,
      inputs: reviewed.inputs,
      preflight,
      finalChecks: checks,
      review,
      repairCount: 0,
    });
    const evidence = JSON.parse(readFileSync(join(reviewed.workspace, ATOMIC_LITE_OUTPUT_PATHS.evidence), "utf8"));
    assert.equal(output.review_decision, "approved");
    assert.equal(evidence.model_execution_attempted, true);
    assert.equal(evidence.reviewer_model_execution_attempted, true);
    assert.deepEqual(evidence.changed_paths, ["src/index.js"]);
  } finally {
    rmSync(reviewed.root, { recursive: true, force: true });
  }
});

test("Atomic Lite descriptor writes reject ancestor swaps without modifying the outside target", async () => {
  const writeFixture = fixture();
  try {
    const preflight = await preflightAtomicLite({
      workspacePath: writeFixture.workspace,
      contextRoot: writeFixture.context,
      inputs: writeFixture.inputs,
    });
    const outside = join(writeFixture.root, "outside-write");
    mkdirSync(outside);
    writeFileSync(join(outside, "index.js"), "outside write sentinel\n");
    renameSync(join(writeFixture.workspace, "src"), join(writeFixture.workspace, "src-reviewed"));
    symlinkSync(outside, join(writeFixture.workspace, "src"));
    await assert.rejects(writeAtomicLiteFile({
      workspacePath: writeFixture.workspace,
      policy: preflight.policy,
      relativePath: "src/index.js",
      content: "must not escape\n",
    }), /escaped|identity|symlink/i);
    assert.equal(readFileSync(join(outside, "index.js"), "utf8"), "outside write sentinel\n");
  } finally {
    rmSync(writeFixture.root, { recursive: true, force: true });
  }

  const artifactFixture = fixture();
  try {
    await preflightAtomicLite({
      workspacePath: artifactFixture.workspace,
      contextRoot: artifactFixture.context,
      inputs: artifactFixture.inputs,
    });
    const outputRoot = join(artifactFixture.workspace, ".valkyrie-atomic-lite-output");
    const outside = join(artifactFixture.root, "outside-artifact");
    mkdirSync(outside);
    writeFileSync(join(outside, "review.json"), "outside artifact sentinel\n");
    renameSync(outputRoot, `${outputRoot}-reviewed`);
    symlinkSync(outside, outputRoot);
    await assert.rejects(
      writeAtomicLiteReview({ workspacePath: artifactFixture.workspace, reviewNotRequired: true }),
      /escaped|identity|symlink/i,
    );
    assert.equal(readFileSync(join(outside, "review.json"), "utf8"), "outside artifact sentinel\n");
  } finally {
    rmSync(artifactFixture.root, { recursive: true, force: true });
  }
});

test("Atomic Lite deterministic checks cannot mutate files outside the write allowlist", async () => {
  const item = fixture({
    checks: [{
      ...ATOMIC_LITE_POLICY_EXAMPLE.checks[0],
      executable: process.execPath,
      argv: ["-e", "require('node:fs').writeFileSync('test/index.test.js','mutated by check\\n')"],
      timeoutSeconds: 5,
      maxOutputBytes: 1024,
    }],
  });
  try {
    const preflight = await preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs });
    await writeAtomicLiteFile({
      workspacePath: item.workspace,
      policy: preflight.policy,
      relativePath: "src/index.js",
      content: "export const answer = 45;\n",
    });
    const checks = await runAtomicLiteChecks({
      workspacePath: item.workspace,
      policy: preflight.policy,
      baseline: preflight.baseline,
      gitBaseline: preflight.git,
      round: "final",
    });
    assert.equal(checks.passed, false);
    assert.match(checks.findings.join(" "), /undeclared change.*test\/index\.test\.js/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite rejects a deterministic check that commits an undeclared mutation", async () => {
  const script = [
    "const fs=require('node:fs');",
    "const cp=require('node:child_process');",
    "fs.writeFileSync('test/index.test.js','committed by check\\n');",
    "for (const args of [['add','test/index.test.js'],['-c','user.name=Atomic Lite Check','-c','user.email=atomic-lite-check@example.invalid','commit','--quiet','-m','undeclared check mutation']]) {",
    "  const result=cp.spawnSync('/usr/bin/git',args,{encoding:'utf8'});",
    "  if (result.status!==0) throw new Error(result.stderr||result.stdout);",
    "}",
  ].join("");
  const item = fixture({
    checks: [{
      ...ATOMIC_LITE_POLICY_EXAMPLE.checks[0],
      executable: process.execPath,
      argv: ["-e", script],
      timeoutSeconds: 5,
      maxOutputBytes: 4096,
    }],
  });
  try {
    const preflight = await preflightAtomicLite({ workspacePath: item.workspace, contextRoot: item.context, inputs: item.inputs });
    await writeAtomicLiteFile({
      workspacePath: item.workspace,
      policy: preflight.policy,
      relativePath: "src/index.js",
      content: "export const answer = 46;\n",
    });
    const checks = await runAtomicLiteChecks({
      workspacePath: item.workspace,
      policy: preflight.policy,
      baseline: preflight.baseline,
      gitBaseline: preflight.git,
      round: "final",
    });
    assert.equal(checks.passed, false);
    assert.match(checks.findings.join(" "), /Git commit, tree, or index changed/i);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic Lite source contract has exactly one implementer lineage and conditional fresh reviewer", () => {
  const source = readFileSync(resolve("packages/atomic-workflow-architect/workflows/atomic-lite-writer.ts"), "utf8");
  assert.equal((source.match(/ctx\.task\(/g) ?? []).length, 3);
  assert.match(source, /context: "fresh"/);
  assert.match(source, /context: "fork"/);
  assert.match(source, /forkFromSessionFile: implementer\.sessionFile/);
  assert.match(source, /if \(preflight\.policy\.reviewerRequired\)/);
  assert.match(source, /review-not-required/);
  assert.match(source, /excludedTools/);
  assert.match(source, /createAtomicLiteCustomTools\(workspacePath, preflight\.policy, Type\)/);
  assert.match(source, /Type\.Object/);
  assert.match(source, /Type\.String/);
  assert.match(source, /context: preflight\.contextSummary/);
  assert.match(source, /final_checks/);
  assert.match(source, /artifact_sha256: finalChecks\.artifact\.sha256/);
  assert.match(source, /changed_paths: finalChecks\.changed_paths/);
  assert.match(source, /ATOMIC_LITE_TOOL_NAMES\.read/);
});
