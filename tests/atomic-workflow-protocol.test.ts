import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { AtomicRpcClient, type AtomicRpcNativeEvent } from "../apps/control-plane/src/atomic-rpc-client.ts";
import {
  AtomicWorkflowProtocolError,
  buildAtomicFixtureWorkflowDispatchCommand,
  buildAtomicWorkflowStatusCommand,
  isTerminalAtomicWorkflowStatus,
  parseAtomicFixtureWorkflowOutput,
  parseAtomicWorkflowListEvent,
  parseAtomicWorkflowLifecycleEvent,
} from "../apps/control-plane/src/atomic-workflow-protocol.ts";
import {
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";

const fakeScript = resolve("scripts/fake-atomic-rpc.ts");

function startFake(t: TestContext, env: Record<string, string> = {}): AtomicRpcClient {
  const client = new AtomicRpcClient({
    command: process.execPath,
    commandArgs: ["--experimental-strip-types", fakeScript],
    requestTimeoutMs: 2_000,
    stopTimeoutMs: 1_000,
  });
  client.start({ cwd: process.cwd(), env });
  t.after(async () => client.stop());
  return client;
}

async function nextLifecycle(client: AtomicRpcClient) {
  const [event] = await once(client, "event");
  const parsed = parseAtomicWorkflowLifecycleEvent(event as AtomicRpcNativeEvent);
  assert.ok(parsed);
  return parsed;
}

const fixtureInputs = {
  control_plane_run_id: "run_atomic_fixture_protocol",
  contract_sha256: "a".repeat(64),
  expected_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
};

test("Atomic fixture workflow command builders quote fixed inputs and require full native UUIDs", () => {
  assert.equal(
    buildAtomicFixtureWorkflowDispatchCommand(fixtureInputs),
    `/workflow atomic-fixture-pilot --no-picker control_plane_run_id="run_atomic_fixture_protocol" contract_sha256="${"a".repeat(64)}" expected_before_sha256="${ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256}"`,
  );
  assert.equal(
    buildAtomicWorkflowStatusCommand("11111111-2222-4333-8444-555555555555"),
    "/workflow status 11111111-2222-4333-8444-555555555555",
  );
  assert.throws(() => buildAtomicWorkflowStatusCommand("11111111"), /full UUID/);
  assert.throws(
    () => buildAtomicFixtureWorkflowDispatchCommand({ ...fixtureInputs, control_plane_run_id: "bad run" }),
    /safe/,
  );
});

test("Atomic workflow lifecycle parser ignores unrelated records and rejects malformed matching details", () => {
  assert.equal(parseAtomicWorkflowLifecycleEvent({ type: "entry_appended", entry: {} }), null);
  assert.equal(parseAtomicWorkflowLifecycleEvent({
    type: "message_start",
    message: {
      role: "custom",
      customType: "workflows:chat-surface",
      details: { kind: "list", entries: [{ name: "atomic-fixture-pilot" }] },
    },
  }), null);
  assert.throws(() => parseAtomicWorkflowLifecycleEvent({
    type: "message_start",
    message: {
      role: "custom",
      customType: "workflows:chat-surface",
      details: {
        kind: "detail",
        detail: { mode: "single", runId: "short", name: "atomic-fixture-pilot", status: "running" },
      },
    },
  }), AtomicWorkflowProtocolError);
  assert.equal(isTerminalAtomicWorkflowStatus("running"), false);
  assert.equal(isTerminalAtomicWorkflowStatus("completed"), true);
  assert.equal(isTerminalAtomicWorkflowStatus("failed"), true);
});

test("Atomic workflow list parser consumes the pinned 0.9.12 chat-surface shape strictly", () => {
  const event = {
    type: "message_start",
    message: {
      role: "custom",
      customType: "workflows:chat-surface",
      details: {
        kind: "list",
        entries: [
          { name: "atomic-fixture-pilot", description: "fixture", inputs: [] },
          { name: "request-preflight", description: "preflight", inputs: [] },
        ],
      },
    },
  };
  assert.deepEqual(parseAtomicWorkflowListEvent(event)?.workflows, ["atomic-fixture-pilot", "request-preflight"]);
  assert.equal(parseAtomicWorkflowLifecycleEvent(event), null);
  assert.throws(() => parseAtomicWorkflowListEvent({
    ...event,
    message: {
      ...event.message,
      details: { kind: "list", entries: [{ name: "duplicate" }, { name: "duplicate" }] },
    },
  }), /duplicate/);
});

test("fake Atomic RPC exposes admitted, running, and completed native workflow detail", async (t) => {
  const client = startFake(t, {
    FAKE_ATOMIC_WORKFLOW_OUTCOME: "completed",
    FAKE_ATOMIC_WORKFLOW_RUNNING_POLLS: "1",
  });
  const listEvent = once(client, "event");
  await client.prompt("/workflow list");
  const [listRaw] = await listEvent;
  assert.ok(parseAtomicWorkflowListEvent(listRaw)?.workflows.includes("atomic-fixture-pilot"));
  const admittedEvent = nextLifecycle(client);
  await client.prompt(buildAtomicFixtureWorkflowDispatchCommand(fixtureInputs));
  const admitted = await admittedEvent;
  assert.equal(admitted.action, "run");
  assert.equal(admitted.workflow, "atomic-fixture-pilot");
  assert.equal(admitted.status, "running");

  const runningEvent = nextLifecycle(client);
  await client.prompt(buildAtomicWorkflowStatusCommand(admitted.runId));
  assert.equal((await runningEvent).status, "running");

  const terminalEvent = nextLifecycle(client);
  await client.prompt(buildAtomicWorkflowStatusCommand(admitted.runId));
  const terminal = await terminalEvent;
  assert.equal(terminal.status, "completed");
  assert.equal(isTerminalAtomicWorkflowStatus(terminal.status), true);
  const output = parseAtomicFixtureWorkflowOutput(terminal.output);
  assert.equal(output.source_after_sha256, ATOMIC_FIXTURE_IMPLEMENTATION_SHA256);
  assert.equal(output.repair_count, 0);
  assert.equal(output.checks_passed, true);
  assert.equal(output.verifier_passed, true);
});

test("fake Atomic RPC exposes a terminal workflow failure without fabricated output", async (t) => {
  const client = startFake(t, {
    FAKE_ATOMIC_WORKFLOW_OUTCOME: "failed",
    FAKE_ATOMIC_WORKFLOW_RUNNING_POLLS: "0",
  });
  const admittedEvent = nextLifecycle(client);
  await client.prompt(buildAtomicFixtureWorkflowDispatchCommand(fixtureInputs));
  const admitted = await admittedEvent;
  const terminalEvent = nextLifecycle(client);
  await client.prompt(buildAtomicWorkflowStatusCommand(admitted.runId));
  const terminal = await terminalEvent;
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /synthetic fixture workflow failure/);
  assert.equal(terminal.output, undefined);
  assert.throws(() => parseAtomicFixtureWorkflowOutput(terminal.output), /must be an object/);
});
