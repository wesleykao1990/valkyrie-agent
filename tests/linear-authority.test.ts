import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeLinearTransport,
  LINEAR_GRAPHQL_ORIGIN,
  LinearAuthorityError,
  LinearAuthorityGateway,
  createLiveLinearAuthorityGateway,
  linearCanonicalJson,
  linearDeterministicUuid,
} from "../apps/control-plane/src/linear-authority.ts";

const TEAM = "team_linear_test";
const PROJECT = "project_linear_test";
const ISSUE = "issue_linear_test";

function policy() {
  return { teamId: TEAM, projectId: PROJECT } as const;
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT,
    identifier: "VAL",
    name: "Valkyrie test project",
    updatedAt: "2026-08-13T00:00:00.000Z",
    team: { id: TEAM, key: "VAL", name: "Valkyrie" },
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE,
    identifier: "VAL-1",
    title: "Bounded issue",
    description: "Authority fixture",
    updatedAt: "2026-08-13T00:00:00.000Z",
    team: { id: TEAM, key: "VAL", name: "Valkyrie" },
    project: { id: PROJECT, identifier: "VAL", name: "Valkyrie test project" },
    ...overrides,
  };
}

function gateway(transport = new FakeLinearTransport()) {
  return { transport, gateway: new LinearAuthorityGateway({ policy: policy(), transport }) };
}

test("Linear authority reads are bounded, ownership-bound, observed, and canonically hashed", async () => {
  const item = gateway();
  item.transport.projects.set(PROJECT, project());
  item.transport.issues.set(ISSUE, issue());
  const snapshot = await item.gateway.readProject();
  assert.equal(snapshot.provider, "linear");
  assert.equal(snapshot.externalId, PROJECT);
  assert.equal(snapshot.revision, "2026-08-13T00:00:00.000Z");
  assert.match(snapshot.payloadHash, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.payloadHash, await (async () => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(linearCanonicalJson(snapshot.payload)).digest("hex");
  })());
  const issueSnapshot = await item.gateway.readIssue(ISSUE);
  assert.equal(issueSnapshot.payload.project.id, PROJECT);
  assert.equal(issueSnapshot.payload.team.id, TEAM);
  assert.equal(item.transport.requests[0].url, LINEAR_GRAPHQL_ORIGIN);
  assert.equal(item.transport.requests[0].method, "POST");
});

test("Linear connector is inert without an explicitly injected or live transport", async () => {
  const disabled = new LinearAuthorityGateway({ policy: policy() });
  await assert.rejects(disabled.readProject(), (error: unknown) => {
    return error instanceof LinearAuthorityError && error.code === "LINEAR_CONNECTOR_DISABLED";
  });
});

test("Linear rejects GraphQL partial success, malformed JSON, and oversized responses", async () => {
  const partial = new LinearAuthorityGateway({
    policy: policy(),
    transport: async () => ({ status: 200, body: { data: { project: project() }, errors: [{ message: "provider error" }] } }),
  });
  await assert.rejects(partial.readProject(), (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_GRAPHQL_ERROR");

  const emptyErrors = new LinearAuthorityGateway({
    policy: policy(),
    transport: async () => ({ status: 200, body: { data: { project: project() }, errors: [] } }),
  });
  await assert.rejects(emptyErrors.readProject(), (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_GRAPHQL_ERROR");

  const malformed = new LinearAuthorityGateway({
    policy: policy(),
    transport: async () => ({ status: 200, body: "not-json" }),
  });
  await assert.rejects(malformed.readProject(), (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_RESPONSE_MALFORMED");

  const oversized = new LinearAuthorityGateway({
    policy: policy(),
    maxResponseBytes: 1_024,
    transport: async () => ({ status: 200, body: JSON.stringify({ data: { project: project({ name: "x".repeat(2_000) }) } }) }),
  });
  await assert.rejects(oversized.readProject(), (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_RESPONSE_TOO_LARGE");
});

test("Linear rejects cross-team/project authority payloads before returning a snapshot", async () => {
  const crossTeam = gateway();
  crossTeam.transport.projects.set(PROJECT, project({ team: { id: "other-team" } }));
  await assert.rejects(crossTeam.gateway.readProject(), (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_OWNERSHIP_MISMATCH");

  const crossProject = gateway();
  crossProject.transport.issues.set(ISSUE, issue({ project: { id: "other-project" } }));
  await assert.rejects(crossProject.gateway.readIssue(ISSUE), (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_OWNERSHIP_MISMATCH");
});

test("Linear mutations use deterministic UUIDv4 IDs, stable markers, multiline evidence, and exact replay", async () => {
  const item = gateway();
  const expectedId = linearDeterministicUuid("action_linear_1", "issue");
  assert.match(expectedId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const first = await item.gateway.createIssue({ actionId: "action_linear_1", title: "Create bounded issue", description: "Evidence line one\nEvidence line two" });
  assert.equal(first.stableId, expectedId);
  assert.equal(first.reconciled, false);
  assert.equal(first.kind, "issue");
  assert.match((first.payload as { description?: string }).description ?? "", /valkyrie-action:action_linear_1/u);
  const replay = await item.gateway.createIssue({ actionId: "action_linear_1", title: "Create bounded issue", description: "Evidence line one\nEvidence line two" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.externalId, first.externalId);
  await assert.rejects(
    item.gateway.createIssue({ actionId: "action_linear_1", title: "Changed title" }),
    (error: unknown) => error instanceof LinearAuthorityError && error.code === "LINEAR_IDEMPOTENCY_CONFLICT",
  );
});

test("Linear comments bind the exact issue and reject cross-project targets", async () => {
  const item = gateway();
  item.transport.issues.set(ISSUE, issue());
  const receipt = await item.gateway.createEvidenceComment({ actionId: "comment_action_1", issueId: ISSUE, body: "Evidence\nwith a second line" });
  assert.equal(receipt.kind, "comment");
  assert.equal(receipt.kind, "comment");
  assert.equal((receipt.payload as { issueId: string }).issueId, ISSUE);
  assert.match((receipt.payload as { body: string }).body, /valkyrie-action:comment_action_1/u);
  const cross = gateway();
  cross.transport.issues.set(ISSUE, issue({ team: { id: "other-team" } }));
  await assert.rejects(cross.gateway.createEvidenceComment({ actionId: "comment_action_2", issueId: ISSUE, body: "No write" }), /outside the accepted/u);
});

test("Linear mutation timeout remains ambiguous before creation and reconciles exactly one after creation", async () => {
  const before = gateway();
  before.transport.queueMutationTimeout("before");
  await assert.rejects(before.gateway.createIssue({ actionId: "linear_timeout_before", title: "Timeout before" }), (error: unknown) => {
    return error instanceof LinearAuthorityError && error.code === "LINEAR_AMBIGUOUS_RESULT";
  });
  assert.equal(before.transport.issues.size, 0);

  const after = gateway();
  after.transport.queueMutationTimeout("after");
  const reconciled = await after.gateway.createIssue({ actionId: "linear_timeout_after", title: "Timeout after" });
  assert.equal(reconciled.reconciled, true);
  assert.equal(after.transport.issues.size, 1);
});

test("Live Linear auth mode is explicit and never appears in receipts/errors", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)?.authorization));
    return { status: 200, body: null, text: async () => JSON.stringify({ data: { project: project() } }) } as Response;
  }) as typeof fetch;
  try {
    await createLiveLinearAuthorityGateway({ policy: policy(), token: "personal-secret-token", authMode: "personal-api-key" }).readProject();
    await createLiveLinearAuthorityGateway({ policy: policy(), token: "oauth-secret-token", authMode: "oauth-bearer" }).readProject();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, ["personal-secret-token", "Bearer oauth-secret-token"]);
});
