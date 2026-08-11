import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DirectCliRuntimeAdapter } from "../apps/control-plane/src/direct-cli-runtimes.ts";
import { exactVersionPattern } from "../apps/control-plane/src/runtime-registry.ts";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import type { Run } from "../apps/control-plane/src/types.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";

const fakeRuntime = resolve("scripts/fake-direct-runtime.ts");

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(name: "codex" | "claude", behavior = "success") {
  const root = mkdtempSync(join(tmpdir(), `valkyrie-${name}-native-`));
  const store = new SqliteStore(join(root, "store.sqlite"));
  await store.seedProjects([{
    id: "fixture", name: "Fixture", objective: "Runtime contract", currentMilestone: "Pilot", health: "on_track",
    linearTeam: "FIX", repository: "fixture/repo", vaultPath: "Projects/Fixture", memoryNamespace: "projects/fixture",
  }]);
  const project = await store.getProject("fixture");
  assert.ok(project);
  const workspaces = new WorkspaceManager(store, join(root, "workspaces"));
  const run: Run = {
    id: `run-${name}-${behavior}`, projectId: "fixture", rootRuntime: name, workflow: "runtime-connectivity",
    status: "queued", stage: null, stageIndex: 0, budgetUsd: 1, costUsd: 0,
    workspaceId: null, nativeRunId: null, nextActionAt: null, startedAt: null, completedAt: null,
    metadata: { requestedObjective: "Return exactly VALKYRIE_FIXTURE_OK and nothing else." }, createdAt: new Date().toISOString(),
  };
  const prepared = workspaces.prepare(run.id, project);
  run.workspaceId = prepared.workspaceId;
  const created = await store.createRunBundle({ run, workspace: prepared.workspace, lease: prepared.lease });
  const controlDir = join(prepared.path, ".control-plane");
  mkdirSync(controlDir, { recursive: true });
  const contextBody = JSON.stringify({ runId: run.id, acceptedDecisions: [] });
  const contractBody = JSON.stringify({ runId: run.id, objective: "Return exactly VALKYRIE_FIXTURE_OK and nothing else.", finalAction: "analysis_only" });
  const contextPath = join(controlDir, "context-pack.json");
  const contractPath = join(controlDir, "run-contract.json");
  writeFileSync(contextPath, contextBody, "utf8");
  writeFileSync(contractPath, contractBody, "utf8");
  const adapter = new DirectCliRuntimeAdapter({
    name,
    command: process.execPath,
    commandPrefixArgs: ["--experimental-strip-types", fakeRuntime, name, behavior],
    expectedVersion: exactVersionPattern(name, name === "codex" ? "0.147.0-alpha.6.5" : "2.1.81"),
    allowedEnvNames: name === "claude" ? ["ANTHROPIC_API_KEY"] : [],
    store,
    workspaces,
    artifactRoot: join(root, "artifacts"),
    startTimeoutMs: behavior === "ignore-term-no-session" ? 50 : 2_000,
    stopTimeoutMs: behavior === "ignore-term-no-session" ? 50 : 2_000,
  });
  const context = {
    run: created.run,
    objective: "Return exactly VALKYRIE_FIXTURE_OK and nothing else.",
    workspacePath: prepared.path,
    workspace: created.workspace,
    writerLease: created.lease,
    contextPack: { path: contextPath, uri: contextPath, checksum: sha(contextBody) },
    runContract: { path: contractPath, uri: contractPath, checksum: sha(contractBody) },
    finalAction: "analysis_only" as const,
  };
  return { root, store, workspaces, adapter, context };
}

async function waitForTerminal(store: SqliteStore, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.getRun(runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${runId}`);
}

for (const name of ["codex", "claude"] as const) {
  test(`${name} native adapter preflights and retains raw JSONL before normalized lifecycle`, async () => {
    const { root, store, adapter, context } = await fixture(name);
    const previousSecret = process.env.VALKYRIE_TEST_SECRET;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.VALKYRIE_TEST_SECRET = "must-not-reach-child";
    if (name === "claude") process.env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
    try {
      const preflight = await adapter.preflight();
      assert.equal(preflight.available, true);
      assert.equal(preflight.authenticated, true);
      assert.equal(preflight.executionMode, "read-only");
      assert.equal(preflight.capabilities.steer, false);

      const native = await adapter.start(context);
      assert.equal(native.runtime, name);
      assert.match(native.nativeSessionId ?? "", new RegExp(`^${name}-fixture-session$`));
      const terminal = await waitForTerminal(store, context.run.id);
      assert.equal(terminal.status, "completed");
      assert.equal((await store.listLeases()).length, 0);
      const events = await store.listEvents(context.run.id);
      const rawIndex = events.findIndex((event) => event.type === "runtime.native");
      const sessionIndex = events.findIndex((event) => event.type === "runtime.session_started");
      assert.ok(rawIndex >= 0 && sessionIndex > rawIndex);
      const raw = events.filter((event) => event.type === "runtime.native");
      assert.ok(raw.length >= 3);
      assert.ok(raw.every((event) => (event.payload.rawNative as any).leakedSecret !== "must-not-reach-child"));
      const session = raw.find((event) => JSON.stringify(event.payload.rawNative).includes(`${name}-fixture-session`));
      assert.ok(Number((session?.payload.rawNative as any).promptBytes) > 0);
      assert.equal((session?.payload.rawNative as any).promptInArgv, false);
      if (name === "claude") {
        assert.deepEqual((session?.payload.rawNative as any).isolationArgs, {
          bare: true,
          strictMcp: true,
          noChrome: true,
          noSessionPersistence: true,
          settingSourcesDisabled: true,
        });
      }
      const resultArtifact = (await store.listArtifacts(context.run.id)).find((artifact) => artifact.kind === "native-result");
      assert.ok(resultArtifact);
      assert.equal(readFileSync(resultArtifact.uri, "utf8").trim(), "VALKYRIE_FIXTURE_OK");
    } finally {
      if (previousSecret === undefined) delete process.env.VALKYRIE_TEST_SECRET;
      else process.env.VALKYRIE_TEST_SECRET = previousSecret;
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      await adapter.shutdown();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("native adapter cancellation terminates the child and releases its writer lease", async () => {
  const { root, store, adapter, context } = await fixture("codex", "slow");
  try {
    await adapter.start(context);
    const running = await store.getRun(context.run.id);
    assert.ok(running);
    await adapter.cancel(running);
    const terminal = await waitForTerminal(store, context.run.id);
    assert.equal(terminal.status, "cancelled");
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native direct adapters reject arbitrary objectives before spawning a model process", async () => {
  const { root, store, adapter, context } = await fixture("codex");
  try {
    await assert.rejects(
      adapter.start({ ...context, objective: "Inspect the host and implement an unrelated task" }),
      /fixed connectivity marker objective/,
    );
    assert.equal((await store.getRun(context.run.id))?.status, "queued");
    assert.equal((await store.listEvents(context.run.id)).length, 0);
    assert.equal((await store.listLeases()).length, 1);
  } finally {
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transport-success response with the wrong marker fails the native run", async () => {
  const { root, store, adapter, context } = await fixture("codex", "wrong-marker");
  try {
    await adapter.start(context);
    const terminal = await waitForTerminal(store, context.run.id);
    assert.equal(terminal.status, "failed");
    assert.match(String(terminal.metadata.nativeFailure), /did not exactly match/);
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native start timeout waits through TERM-to-KILL before releasing the writer lease", async () => {
  const { root, store, adapter, context } = await fixture("codex", "ignore-term-no-session");
  try {
    const startedAt = Date.now();
    await assert.rejects(adapter.start(context), /did not emit a session identifier/);
    assert.ok(Date.now() - startedAt >= 90, "start returned before the TERM-to-KILL bound closed the child");
    assert.equal((await store.getRun(context.run.id))?.status, "failed");
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await adapter.shutdown();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
