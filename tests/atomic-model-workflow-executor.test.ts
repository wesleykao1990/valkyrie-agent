import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AtomicRpcClient } from "../apps/control-plane/src/atomic-rpc-client.ts";
import { executeAtomicFixtureModelWorkflow } from "../apps/control-plane/src/atomic-model-workflow-executor.ts";

const fake = resolve("scripts/fake-atomic-rpc.ts");
const inputs = {
  control_plane_run_id: "run_model_executor", contract_sha256: "a".repeat(64),
  expected_before_sha256: "b".repeat(64), capability_policy_sha256: "c".repeat(64), package_sha256: "d".repeat(64),
};

function client(env: Record<string, string> = {}) {
  const item = new AtomicRpcClient({
    command: process.execPath,
    commandArgs: ["--experimental-strip-types", fake],
    requestTimeoutMs: 2_000, stopTimeoutMs: 500,
  });
  item.start({ cwd: process.cwd(), env });
  return item;
}

test("model executor follows the native fixed workflow and preserves raw pre-live evidence", async () => {
  const item = client({ FAKE_ATOMIC_WORKFLOW_RUNNING_POLLS: "1", FAKE_ATOMIC_MODEL_REPAIR: "1" });
  try {
    const result = await executeAtomicFixtureModelWorkflow({
      client: item, inputs, signal: new AbortController().signal, timeoutMs: 5_000, pollMs: 10,
    });
    assert.equal(result.nativeSessionId, "fake-main-session");
    assert.equal(result.nativeWorkflowRunId, "11111111-2222-4333-8444-555555555555");
    assert.equal(result.output.repair_count, 1);
    assert.equal(result.output.live_provider_verified, false);
    assert.ok(result.rawRecords.some((record) => record.type === "message_start"));
    assert.ok(result.rawRecords.some((record) => record.type === "response"));
  } finally { await item.stop(); }
});

test("model executor fails closed on native failure without fabricating terminal output", async () => {
  const item = client({ FAKE_ATOMIC_WORKFLOW_RUNNING_POLLS: "0", FAKE_ATOMIC_WORKFLOW_OUTCOME: "failed" });
  try {
    await assert.rejects(executeAtomicFixtureModelWorkflow({
      client: item, inputs, signal: new AbortController().signal, timeoutMs: 5_000, pollMs: 10,
    }), /ended failed/);
  } finally { await item.stop(); }
});
