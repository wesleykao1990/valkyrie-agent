# Milestone 7 production-connector implementation plan

Date: 2026-08-13
Status: deterministic implementation and final repository verification complete;
live credential exercise pending

## Objective

Add production-shaped, fail-closed connector boundaries without changing the
accepted system authorities or turning the local database into a second roadmap:

1. read a bounded current Linear project/task snapshot and bind its revision to
   engineering assessments;
2. bind Git repository identity, revision, and an accepted deterministic check
   policy without accepting caller-supplied paths or commands;
3. deliver only explicitly planned and approved external actions through a
   transactional per-consumer outbox with fencing, retry, dead-letter evidence,
   replay, retention, and operator status; ordinary task intake has no provider
   consumer;
4. evaluate deterministic local-Markdown Project Brain retrieval behind a
   read-only provider boundary before enabling a candidate provider;
5. prepare and, only after an exact evidence-bound approval, create a GitHub
   draft PR from a pre-existing immutable remote head; and
6. keep every live connector disabled until its exact credential and project
   allowlist have been configured and exercised.

The implementation does not use Linear AgentSession preview APIs, mirror the
Linear roadmap, publish a writer branch, merge a PR, deploy, promote memory, or
make a runtime the default.

## Baseline

The untouched M6/pre-M7 tree passed on 2026-08-13:

- root tests: 264 total, 261 passed, 0 failed, 3 intentional skips;
- disposable PostgreSQL storage: 22/22;
- disposable PostgreSQL model lifecycle: 7/7;
- Atomic package verification: 38 required files, 6 workflows, 16 routes,
  5 prompt templates, and 11 invalid-manifest cases;
- authenticated HTTP and MCP smoke tests.

## Architecture slices

### 1. Authority snapshots and project policy

- Add a `LinearAuthorityGateway` whose read methods return only a bounded project
  or issue view, provider ID, `updatedAt` revision, observed time, and canonical
  payload hash.
- Add a host-side `GitAuthorityProvider` that resolves only repositories and
  refs from an accepted project policy. It records the repository identity,
  remote URL identity, commit/tree OIDs, clean state, and check-policy digest.
- Store narrow authority bindings/snapshots. Do not persist Linear initiatives,
  dependencies, comments, or arbitrary roadmap pages.
- Engineering assessment remains fail-closed unless both authority snapshots and
  the accepted policy are current. M7 does not silently launch the selected
  runtime; general launcher registration is a separate reviewed change.

### 2. External outbox delivery

- Migration 012 adds revision-bound authority bindings and per-consumer outbox
  deliveries. The original outbox row remains immutable business evidence.
- Claiming is cross-process, expiring, and fenced. A consumer acknowledges or
  fails only with its exact claim token.
- Retry uses the stable outbox ID as the provider idempotency/reconciliation key:
  15-second exponential delays capped at 15 minutes, at most eight attempts,
  then durable dead-letter state. Delivered rows may be pruned after 30 days;
  dead letters are retained until an explicit operator action.
- Errors retain a bounded safe code and fingerprint, never a token, request
  body, raw provider response, or secret-bearing URL.
- The composed consumer accepts only `external.action.authorized`; ordinary
  `task.created` events never call a provider. Linear issue creation therefore
  follows the same evidence-bound action-plan and approval boundary as comments
  and GitHub draft PRs.

### 3. Project Brain retrieval evaluation

- Introduce a read-only provider interface and adapt `LocalProjectBrain` as the
  default. Promotion remains a separate local writer and automatic capture stays
  disabled.
- Add a deterministic fixture evaluation for project isolation, accepted-note
  ranking, stale/superseded suppression, deletion, determinism, output bounds,
  latency, and reported token/cost use.
- Keep OpenViking behind an explicit read-only flag and namespace allowlist. A
  candidate result cannot become a context pack until it passes the same
  correctness contract; local Markdown remains the active provider.

### 4. External final actions

- Migration 013 adds immutable external-action plans and provider receipts.
- Linear issue/idea/evidence projections and GitHub draft-PR creation require an
  exact action plan plus an approval binding for action, exact effect, project,
  workflow, evidence digest, policy hash, and expiry.
- GitHub creation is allowed only for a configured repository, current approved
  base/head OIDs, a pre-existing remote head, unchanged governed artifact bytes,
  a cleaned sandbox, no writer lease, and deterministic title/body hashes.
- A stable marker is included in every mutation. An ambiguous timeout is never
  blindly retried: reconciliation must find exactly one matching external
  object, while zero stays ambiguous and multiple matches require an operator.
- M6 workspaces are already cleaned and retain no publishable branch. Therefore
  M7 can create a draft PR only from a separately supplied, already-existing
  remote head. Branch publication remains another approval and is not inferred.

## Expected files

The exact list may narrow as contracts settle. Expected additions include:

- `apps/control-plane/src/linear-authority.ts`
- `apps/control-plane/src/git-authority.ts`
- `apps/control-plane/src/project-brain-provider.ts`
- `apps/control-plane/src/project-brain-evaluation.ts`
- `apps/control-plane/src/github-draft-pr-gateway.ts`
- `apps/control-plane/src/external-final-action.ts`
- `infra/{sqlite,postgres}/012_connector_authority_outbox.sql`
- `infra/{sqlite,postgres}/013_external_final_actions.sql`
- focused fake gateways, contract tests, and opt-in live smoke scripts.

The implemented surface also includes `connector-policy.ts`,
`production-connectors.ts`, authenticated HTTP/MCP operations, the
`smoke:m7-read` harness, and the operator runbook in
`docs/M7_CONNECTOR_SETUP.md`. Ambiguous-effect reconciliation is HTTP-only.

Existing store, service, config, server, MCP, setup, security, API, storage,
verification, and handoff files change only where needed to compose these
boundaries. The restricted Hermes MCP will not expose raw GraphQL, arbitrary
HTTP, Git paths, credentials, branch publication, merge, or deployment tools.

## Feature flags and secrets

All live behavior defaults off. Configuration will use separate flags and
private regular `0600` credential files for Linear and GitHub. A Linear read-only
deployment uses OAuth `read` or a read-restricted personal key; write deployment
adds only the narrow official issue/comment scopes needed by the enabled action.
GitHub uses a repository-scoped App installation or fine-grained token with
Contents read and Pull requests read/write only. No credential enters storage,
outbox payloads, events, model context, writer mounts, artifacts, or logs.

The live endpoints are fixed to Linear's official GraphQL origin and GitHub's
official REST origin unless a separately reviewed loopback fake is selected for
tests. GraphQL HTTP 200 responses containing `errors` are failures. Provider
responses are schema-checked and bounded before they affect durable state.

## Required verification

- SQLite/PostgreSQL migration, validation, claim fencing, retry, dead-letter,
  operator replay, retention, idempotency, and crash/reconciliation parity.
- Concurrent dispatchers cannot deliver the same consumer claim concurrently.
- Provider success followed by local crash reconciles by stable marker without
  duplicate external state.
- Linear reads reject cross-team/project data, stale revisions, partial GraphQL
  success, malformed payloads, excessive pages, and unapproved fields.
- Git authority rejects dirty repositories, remote/repository mismatch, ref
  drift, symlinks, unapproved checks, and changed policy bytes.
- Project Brain evaluation proves zero cross-project hits, expected accepted
  hit-at-one, suppression, deletion, deterministic packs, and zero local token
  cost. Latency is recorded separately from hard correctness assertions.
- External final actions reject missing/expired/wrong approvals, evidence or
  artifact drift, active leases, non-clean sandbox state, repository/ref drift,
  duplicate markers, and ambiguous outcomes.
- Live tests remain opt-in and report exactly which read/write was exercised.
- Run narrow tests, then `npm run verify`, then an independent security review.

## Rollback and failure behavior

Migrations 012 and 013 are forward-only and checksummed. Older binaries must fail
closed on the newer ledger. Rollback requires a verified pre-migration backup or
a separate compatible SQLite dataset; there is no destructive down migration.

Disabling a connector stops new claims but preserves pending, ambiguous,
delivered, and dead-letter evidence. External writes cannot be transactionally
undone: created issues, comments, and draft PRs remain operator-owned objects.
The runbook must reconcile them rather than deleting or silently retrying them.

## Live handoff

Only after deterministic verification is green will the handoff request exact
project/team/repository IDs and the minimum credential files. The first live
exercise is read-only Linear and Git/GitHub revision inspection. Each write is a
separate opt-in smoke against a disposable issue/branch and stops after creating
a draft PR; it never merges, deploys, changes a project status, or promotes
memory.
