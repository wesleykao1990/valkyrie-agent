import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeGithubTransport,
  GITHUB_API_VERSION,
  GITHUB_REST_ORIGIN,
  GithubDraftPrError,
  GithubDraftPrGateway,
  createGithubDraftPrPolicy,
  createLiveGithubDraftPrGateway,
} from "../apps/control-plane/src/github-draft-pr-gateway.ts";

const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);
const NEXT_HEAD_OID = "c".repeat(40);

function policy(overrides: Record<string, unknown> = {}) {
  return createGithubDraftPrPolicy({
    owner: "acme",
    repo: "project",
    baseRef: "main",
    headRef: "feature/remote",
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    ...overrides,
  });
}

function fixture(overrides: Record<string, unknown> = {}) {
  const transport = new FakeGithubTransport();
  transport.setRef("main", BASE_OID);
  transport.setRef("feature/remote", HEAD_OID);
  const gateway = new GithubDraftPrGateway({ policy: policy(overrides), transport });
  return { transport, gateway };
}

const input = {
  actionId: "github_action_1",
  title: "Review the bounded connector",
  body: "Evidence summary\nwith a second line",
} as const;

test("GitHub draft PR gateway is inert by default and fixes the repository policy", async () => {
  const gateway = new GithubDraftPrGateway({ policy: policy() });
  await assert.rejects(gateway.inspectRefs(), (error: unknown) => error instanceof GithubDraftPrError && error.code === "GITHUB_CONNECTOR_DISABLED");
  assert.equal(gateway.policy.owner, "acme");
  assert.equal(gateway.policy.repo, "project");
  assert.equal(gateway.policy.baseRef, "main");
  assert.equal(gateway.policy.headRef, "feature/remote");
  assert.match(gateway.policy.policyDigest, /^[a-f0-9]{64}$/u);
});
test("GitHub success inspects exact remote OIDs then creates only a draft with a stable marker", async () => {
  const item = fixture();
  const receipt = await item.gateway.createDraftPullRequest(input);
  assert.equal(receipt.provider, "github");
  assert.equal(receipt.kind, "draft-pull-request");
  assert.equal(receipt.draft, true);
  assert.equal(receipt.reconciled, false);
  assert.match(receipt.stableMarker, /<!-- valkyrie-action:github_action_1 -->/u);
  assert.equal(receipt.baseOid, BASE_OID);
  assert.equal(receipt.headOid, HEAD_OID);
  assert.equal(item.transport.pulls.length, 1);
  const createRequest = item.transport.requests.at(-1);
  assert.equal(createRequest?.method, "POST");
  const body = JSON.parse(createRequest?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.base, "main");
  assert.equal(body.head, "feature/remote");
  assert.equal(body.draft, true);
  assert.match(String(body.body), /valkyrie-action:github_action_1/u);
  assert.equal(createRequest?.url, `${GITHUB_REST_ORIGIN}/repos/acme/project/pulls`);
  assert.equal(createRequest?.headers["X-GitHub-Api-Version"], GITHUB_API_VERSION);
});

test("GitHub exact replay is single-spend and changed payload with the same action ID conflicts", async () => {
  const item = fixture();
  const first = await item.gateway.createDraftPr(input);
  const requestCount = item.transport.requests.length;
  const replay = await item.gateway.createDraftPr(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.externalId, first.externalId);
  assert.equal(item.transport.requests.length, requestCount);
  await assert.rejects(
    item.gateway.createDraftPr({ ...input, title: "Changed title" }),
    (error: unknown) => error instanceof GithubDraftPrError && error.code === "GITHUB_IDEMPOTENCY_CONFLICT",
  );
});

test("GitHub rejects remote ref drift and requires a pre-existing approved head", async () => {
  const item = fixture();
  item.transport.setRef("feature/remote", NEXT_HEAD_OID);
  await assert.rejects(item.gateway.createDraftPr({ ...input, actionId: "github_drift" }), (error: unknown) => {
    return error instanceof GithubDraftPrError && error.code === "GITHUB_REF_DRIFT";
  });
  const missing = new GithubDraftPrGateway({
    policy: createGithubDraftPrPolicy({ owner: "acme", repo: "project", baseRef: "main", headRef: "feature/remote" }),
    transport: item.transport,
  });
  await assert.rejects(missing.createDraftPr({ ...input, actionId: "github_no_approved_oids" }), (error: unknown) => {
    return error instanceof GithubDraftPrError && error.code === "GITHUB_POLICY_INVALID";
  });
});

test("GitHub timeout before creation stays ambiguous, while timeout after creation reconciles one exact marker", async () => {
  const before = fixture();
  before.transport.queueTimeout("before");
  await assert.rejects(before.gateway.createDraftPr({ ...input, actionId: "github_timeout_before" }), (error: unknown) => {
    return error instanceof GithubDraftPrError && error.code === "GITHUB_AMBIGUOUS_RESULT";
  });
  assert.equal(before.transport.pulls.length, 0);

  const after = fixture();
  after.transport.queueTimeout("after");
  const reconciled = await after.gateway.createDraftPr({ ...input, actionId: "github_timeout_after" });
  assert.equal(reconciled.reconciled, true);
  assert.equal(after.transport.pulls.length, 1);
});

test("GitHub stable-marker reconciliation rejects zero, changed, and multiple matches", async () => {
  const zero = fixture();
  zero.transport.queueTimeout("before");
  await assert.rejects(zero.gateway.createDraftPr({ ...input, actionId: "github_zero" }), (error: unknown) => {
    return error instanceof GithubDraftPrError && error.code === "GITHUB_AMBIGUOUS_RESULT";
  });

  const changed = fixture();
  changed.transport.pulls.push({
    id: 2001,
    number: 1,
    title: "Different payload",
    body: "other\n\n<!-- valkyrie-action:github_changed -->",
    draft: true,
    state: "open",
    base: { ref: "main", sha: BASE_OID },
    head: { ref: "feature/remote", sha: HEAD_OID },
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  await assert.rejects(changed.gateway.createDraftPr({ ...input, actionId: "github_changed" }), (error: unknown) => {
    return error instanceof GithubDraftPrError && error.code === "GITHUB_IDEMPOTENCY_CONFLICT";
  });

  const multiple = fixture();
  const duplicate = {
    id: 2002,
    number: 2,
    title: input.title,
    body: `${input.body}\n\n<!-- valkyrie-action:github_multiple -->`,
    draft: true as const,
    state: "open" as const,
    base: { ref: "main", sha: BASE_OID },
    head: { ref: "feature/remote", sha: HEAD_OID },
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
  multiple.transport.pulls.push({ ...duplicate, id: 2003, number: 3 });
  multiple.transport.pulls.push({ ...duplicate, id: 2004, number: 4 });
  await assert.rejects(multiple.gateway.createDraftPr({ ...input, actionId: "github_multiple" }), (error: unknown) => {
    return error instanceof GithubDraftPrError && error.code === "GITHUB_OPERATOR_REVIEW";
  });
});

test("GitHub list parsing ignores non-draft open PRs and bounds malformed/oversized responses", async () => {
  const transport = new FakeGithubTransport();
  transport.setRef("main", BASE_OID);
  transport.setRef("feature/remote", HEAD_OID);
  transport.pulls.push({
    id: 10,
    number: 10,
    title: "Non-draft",
    body: "not a candidate",
    draft: false,
    state: "open",
    base: { ref: "main", sha: BASE_OID },
    head: { ref: "feature/remote", sha: HEAD_OID },
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  const gateway = new GithubDraftPrGateway({ policy: policy(), transport });
  const receipt = await gateway.createDraftPr({ ...input, actionId: "github_after_non_draft" });
  assert.equal(receipt.reconciled, false);

  const malformed = new GithubDraftPrGateway({
    policy: policy(),
    transport: async () => ({ status: 200, body: "not-json" }),
  });
  await assert.rejects(malformed.inspectRefs(), (error: unknown) => error instanceof GithubDraftPrError && error.code === "GITHUB_RESPONSE_MALFORMED");
});

test("Live GitHub transport uses the fixed origin, API version, and bearer only when explicitly constructed", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; authorization: string; apiVersion: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, authorization: headers.authorization, apiVersion: headers["X-GitHub-Api-Version"] });
    if (url.endsWith("/git/ref/heads/main")) return { status: 200, body: null, text: async () => JSON.stringify({ ref: "refs/heads/main", object: { sha: BASE_OID } }) } as Response;
    if (url.endsWith("/git/ref/heads/feature/remote")) return { status: 200, body: null, text: async () => JSON.stringify({ ref: "refs/heads/feature/remote", object: { sha: HEAD_OID } }) } as Response;
    if (url.includes("/pulls?") && init?.method === "GET") return { status: 200, body: null, text: async () => "[]" } as Response;
    return {
      status: 201,
      body: null,
      text: async () => JSON.stringify({
        id: 99,
        number: 99,
        title: inputValue.title,
        body: inputValue.body,
        draft: true,
        state: "open",
        base: { ref: "main", sha: BASE_OID },
        head: { ref: "feature/remote", sha: HEAD_OID },
        updated_at: "2026-08-13T00:00:00.000Z",
        html_url: "https://github.com/acme/project/pull/99",
      }),
    } as Response;
  }) as typeof fetch;
  const inputValue = { title: input.title, body: `${input.body}\n\n<!-- valkyrie-action:github_live -->` };
  try {
    const gateway = createLiveGithubDraftPrGateway({ policy: policy(), token: "github-secret-token" });
    const receipt = await gateway.createDraftPr({ ...input, actionId: "github_live" });
    assert.equal(receipt.number, 99);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(seen.length >= 4);
  assert(seen.every((request) => request.url.startsWith(GITHUB_REST_ORIGIN)));
  assert(seen.every((request) => request.authorization === "Bearer github-secret-token"));
  assert(seen.every((request) => request.apiVersion === GITHUB_API_VERSION));
});
