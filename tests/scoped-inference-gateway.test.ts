import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import {
  issueScopedInferenceCapability,
  HttpOpenAiInferenceUpstream,
  createScopedInferenceGatewayServer,
  listenScopedInferenceGatewayUnix,
  ScopedInferenceGateway,
  ScopedInferenceGatewayError,
  type InferenceUpstream,
  type ScopedInferencePolicy,
} from "../apps/control-plane/src/scoped-inference-gateway.ts";
import type { InferenceRole } from "../apps/control-plane/src/store.ts";
import type { Run } from "../apps/control-plane/src/types.ts";

const now = new Date("2026-08-12T00:00:00.000Z");
const policy: ScopedInferencePolicy = {
  provider: "fake-provider", model: "fixture-model", api: "openai-completions",
  roleModels: {
    implementer: "fixture-implementer", verifier_initial: "fixture-verifier-initial",
    repair: "fixture-repair", verifier_final: "fixture-verifier-final",
  },
  roles: ["implementer", "verifier_initial", "repair", "verifier_final"], maxRequests: 4,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 50_000, maxElapsedMs: 5_000,
  ttlMs: 10 * 60_000, inputCostMicrosPerMillion: 1_000_000, outputCostMicrosPerMillion: 2_000_000,
};

class FakeUpstream implements InferenceUpstream {
  calls: Array<{ role: InferenceRole; body: Record<string, unknown> }> = [];
  failRole?: InferenceRole;
  usage = { inputTokens: 20, outputTokens: 10 };
  async complete(input: Parameters<InferenceUpstream["complete"]>[0]) {
    this.calls.push({ role: input.role, body: input.body });
    if (input.signal.aborted || this.failRole === input.role) throw new Error("synthetic upstream failure containing secret-do-not-log");
    const body = Buffer.from(JSON.stringify({
      id: `fake_${input.role}`, object: "chat.completion", model: input.model,
      choices: [{ index: 0, message: { role: "assistant", content: `fixed ${input.role}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: this.usage.inputTokens, completion_tokens: this.usage.outputTokens, total_tokens: this.usage.inputTokens + this.usage.outputTokens },
    }));
    return {
      status: 200, contentType: "application/json" as const, body,
      providerRequestId: `fake_provider_${input.role}`, ...this.usage,
    };
  }
}

async function fixture() {
  const store = new SqliteStore(":memory:", { now: () => new Date(now) });
  await store.seedProjects([{
    id: "atomic-pilot", name: "Atomic Pilot", objective: "fixture", currentMilestone: "M5b",
    health: "on_track", linearTeam: "VAL", repository: "fixture", vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture", createdAt: now.toISOString(),
  }]);
  const run: Run = {
    id: "run_model_fixture", taskId: null, projectId: "atomic-pilot", rootRuntime: "atomic",
    workflow: "atomic-fixture-model-pilot", status: "running", stage: "model", stageIndex: 1,
    budgetUsd: 0.05, costUsd: 0, workspaceId: null, nativeRunId: null, nextActionAt: null,
    startedAt: now.toISOString(), completedAt: null, metadata: {}, createdAt: now.toISOString(),
  };
  await store.createRun(run);
  const issued = await issueScopedInferenceCapability({
    store, runId: run.id, projectId: run.projectId, workflow: run.workflow!, policy, now: () => new Date(now),
  });
  const upstream = new FakeUpstream();
  const gateway = new ScopedInferenceGateway(store, upstream, policy);
  return { store, run, issued, upstream, gateway };
}

function request(model = policy.roleModels.implementer) {
  return { model, messages: [{ role: "user", content: "Implement only the fixed fixture contract." }], max_tokens: 256 };
}

test("scoped inference stores only a token digest and accounts one exact role", async () => {
  const item = await fixture();
  try {
    const stored = await item.store.getInferenceCapability(item.issued.capability.id);
    assert.equal(stored?.tokenHash, createHash("sha256").update(item.issued.token).digest("hex"));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(item.issued.token));
    const result = await item.gateway.complete(item.issued.token, "implementer", request());
    assert.equal(JSON.parse(result.body.toString()).choices[0].message.content, "fixed implementer");
    const requests = await item.store.listInferenceRequests(item.run.id);
    assert.deepEqual(requests.map((entry) => ({ role: entry.role, state: entry.state, input: entry.inputTokens, output: entry.outputTokens, cost: entry.costMicros })), [
      { role: "implementer", state: "completed", input: 20, output: 10, cost: 40 },
    ]);
    await assert.rejects(item.gateway.complete(item.issued.token, "implementer", request()), (error: unknown) =>
      error instanceof ScopedInferenceGatewayError && error.code === "request_already_attempted");
    assert.equal(item.upstream.calls.length, 1, "an exact retry must not spend twice");
  } finally { await item.store.close(); }
});

test("scoped inference rejects model and capability tampering before upstream", async () => {
  const item = await fixture();
  try {
    await assert.rejects(item.gateway.complete(item.issued.token, "implementer", request("other-model")), /model does not match/i);
    await assert.rejects(item.gateway.complete(`${item.issued.token.slice(0, -1)}x`, "implementer", request()), /capability is invalid/i);
    await assert.rejects(item.gateway.complete(item.issued.token, "unknown" as InferenceRole, request()), /role is outside/i);
    assert.equal(item.upstream.calls.length, 0);
  } finally { await item.store.close(); }
});

test("scoped inference records only a safe failure code when upstream fails", async () => {
  const item = await fixture();
  try {
    item.upstream.failRole = "verifier_initial";
    await assert.rejects(item.gateway.complete(item.issued.token, "verifier_initial", request(policy.roleModels.verifier_initial)), (error: unknown) => {
      assert.ok(error instanceof ScopedInferenceGatewayError);
      assert.equal(error.code, "upstream_failure");
      assert.doesNotMatch(error.message, /secret-do-not-log/);
      return true;
    });
    const [stored] = await item.store.listInferenceRequests(item.run.id);
    assert.equal(stored.state, "failed");
    assert.equal(stored.failureCode, "upstream_failure");
    assert.doesNotMatch(JSON.stringify(stored), /secret-do-not-log/);
  } finally { await item.store.close(); }
});

test("aggregate usage exceeding the capability fails closed after one upstream call", async () => {
  const item = await fixture();
  try {
    item.upstream.usage = { inputTokens: policy.maxInputTokens + 1, outputTokens: 0 };
    await assert.rejects(item.gateway.complete(item.issued.token, "verifier_final", request(policy.roleModels.verifier_final)), (error: unknown) =>
      error instanceof ScopedInferenceGatewayError && error.code === "upstream_failure");
    const [stored] = await item.store.listInferenceRequests(item.run.id);
    assert.equal(stored.state, "failed");
    assert.equal(item.upstream.calls.length, 1);
  } finally { await item.store.close(); }
});

test("external HTTPS upstream sends the provider credential only in the reviewed header and requires usage", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({
      id: "provider_req_1", choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "provider_req_1" } });
  }) as typeof fetch;
  try {
    const upstream = new HttpOpenAiInferenceUpstream({
      baseUrl: "https://provider.invalid/v1", credential: "private-provider-token-123", authorization: "bearer",
    });
    const result = await upstream.complete({
      provider: "future-provider", model: "future-model", role: "implementer",
      body: { model: "future-model", messages: [{ role: "user", content: "fixed" }] },
      timeoutMs: 1000, signal: new AbortController().signal,
    });
    assert.deepEqual({ input: result.inputTokens, output: result.outputTokens }, { input: 7, output: 3 });
    assert.equal(calls[0].url, "https://provider.invalid/v1/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer private-provider-token-123");
    assert.equal(JSON.stringify(calls[0].init.body).includes("private-provider-token-123"), false);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      messages: [{ role: "user", content: "fixed" }], model: "future-model",
    }, "provider request body remains valid canonical JSON");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("credential-free upstream is accepted only for explicit HTTP loopback", async () => {
  assert.doesNotThrow(() => new HttpOpenAiInferenceUpstream({
    baseUrl: "http://127.0.0.1:11434/v1", authorization: "bearer", allowCredentialFreeLoopback: true,
  }));
  assert.throws(() => new HttpOpenAiInferenceUpstream({
    baseUrl: "http://provider.invalid/v1", authorization: "bearer", allowCredentialFreeLoopback: true,
  }), /HTTPS|loopback/i);
  assert.throws(() => new HttpOpenAiInferenceUpstream({
    baseUrl: "https://provider.invalid/v1", authorization: "bearer",
  }), /credential/i);
});

test("deterministic pre-live sequence budgets implementer, fresh verifier, one repair, and final fresh verifier", async () => {
  const item = await fixture();
  try {
    const stages: Array<[InferenceRole, string]> = [
      ["implementer", "fresh implementer session"],
      ["verifier_initial", "fresh verifier with artifact handoff only"],
      ["repair", "forked implementer session with evidence-backed finding"],
      ["verifier_final", "new fresh verifier with repaired artifacts only"],
    ];
    for (const [role, content] of stages) {
      await item.gateway.complete(item.issued.token, role, {
        model: policy.roleModels[role], messages: [{ role: "user", content }], max_tokens: 256,
      });
    }
    assert.deepEqual(item.upstream.calls.map((call) => call.role), stages.map(([role]) => role));
    const requests = await item.store.listInferenceRequests(item.run.id);
    assert.equal(requests.length, 4);
    assert.equal(requests.every((request) => request.state === "completed"), true);
    assert.equal((await item.store.getInferenceCapability(item.issued.capability.id))?.state, "exhausted");
    await assert.rejects(item.gateway.complete(item.issued.token, "repair", request(policy.roleModels.repair)), /already attempted|already used|conflict/i);
    assert.equal(item.upstream.calls.length, 4, "the one-repair workflow cannot spend a fifth request");
  } finally { await item.store.close(); }
});

test("gateway serves the scoped capability through a private Unix socket", async () => {
  const item = await fixture();
  const root = mkdtempSync(join(tmpdir(), "valkyrie-inference-socket-"));
  chmodSync(root, 0o700);
  const socketPath = join(root, "inference.sock");
  const server = createScopedInferenceGatewayServer(item.gateway);
  const close = await listenScopedInferenceGatewayUnix(server, socketPath);
  try {
    const body = JSON.stringify(request());
    const response = await new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
      const call = httpRequest({ socketPath, path: "/v1/chat/completions", method: "POST", headers: {
        authorization: `Bearer ${item.issued.token}`, "x-valkyrie-role": "implementer",
        "content-type": "application/json", "content-length": Buffer.byteLength(body),
      } }, (result) => {
        const chunks: Buffer[] = [];
        result.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        result.on("end", () => resolvePromise({ status: result.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      call.once("error", reject); call.end(body);
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).choices[0].message.content, "fixed implementer");
  } finally {
    await close(); await item.store.close(); rmSync(root, { recursive: true, force: true });
  }
});
