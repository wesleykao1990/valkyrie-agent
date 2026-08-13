# HTTP API

Default base URL: `http://127.0.0.1:8787`

The API is a prototype contract. It does not expose raw shell/container/secret or
filesystem-management tools. M7 can create only a separately approved GitHub
draft PR from a pre-existing configured remote head; no route publishes a branch,
merges, or deploys.

## Authentication

`GET /health` and static developer-console assets are always public on the bound
listener. When either `CONTROL_PLANE_AUTH_TOKEN` or
`CONTROL_PLANE_AUTH_TOKEN_FILE` is configured, **every** `/api` route—including
SSE—requires:

```http
Authorization: Bearer <token>
```

Missing/invalid credentials return `401` plus `WWW-Authenticate: Bearer`. Native
runtime selection and non-loopback host binding both fail startup when no token is
configured. The default loopback/mock demo can still run without auth.

Engineering assessment is stricter than the mock demo: its POST and GET routes
return `403` unless a bearer token is configured, even on loopback. This prevents
literal general requests from becoming an unauthenticated local intake surface.

The token must be 32–4096 bytes with no whitespace/control characters. A token
file must be a regular non-symlink and, on POSIX, grant no group/other permissions
(`0600`). Set exactly one token source.

## Health and runtime preflight

### `GET /health`

Reports storage availability and current migrations. Returns `503` when storage
is unavailable or stale.

### `GET /api/runtimes`

Returns one preflight record per configured adapter:

```json
[
  {
    "runtime": "codex",
    "adapter": "native",
    "enabled": true,
    "available": true,
    "executionMode": "read-only",
    "command": "codex",
    "version": "codex-cli 0.147.0-alpha.6.5",
    "authenticated": true,
    "capabilities": {
      "steer": false,
      "pause": false,
      "resume": false,
      "approve": false,
      "artifacts": true
    },
    "reason": "Pinned native CLI and authentication are available"
  }
]
```

`available` is the start gate. The M3 Atomic connectivity record reports
authentication `unknown` because it performs credential-free offline discovery.
When M5a is enabled, a second Atomic record has
`workflow="atomic-fixture-pilot"`, `executionMode="isolated-writer"`,
`authenticated=false`, and `modelExecutionAttempted=false`. It proves only the
configured immutable runner and fixed tool-only workflow preflight, not model
availability or general repository-writing authority.

## Read operations

- `GET /api/portfolio`
- `GET /api/projects`
- `GET /api/projects/:projectId/brief`
- `GET /api/engineering/assessments/:assessmentId`
  - Returns the durable literal-request assessment, context-source provenance,
    dimensions, hard signals, upward-only preference, final-action intent,
    selected shape, policy version/reasons, TTL, and launch-support status.
  - Expiry is reported without rewriting or launching the assessment.
- `GET /api/tasks?projectId=...`
- `GET /api/runs`
- `GET /api/runs/:runId`
  - Returns `{ run, task, events, approvals, artifacts }`.
  - Raw native JSONL is retained in events whose `type` is `runtime.native`; the
    parsed record is `payload.rawNative` and `payload.recordIndex` preserves each
    occurrence.
- `GET /api/atomic-fixture/runs/:runId/artifacts/:artifactId`
  - Available only for an M5a run with exactly one pending, unexpired
    `accept_atomic_fixture_result` gate. Both IDs use the control-plane safe-ID
    grammar and are never interpreted as filesystem paths.
  - Reopens the approval-bound governed artifact with no-follow semantics,
    rechecks its recorded size and SHA-256, rejects invalid UTF-8 and secret-scan
    findings, and returns at most 256 KiB. Allowed media types are
    `application/json`, `text/x-diff`, and `text/plain`.
  - Returns `{ runId, approvalId, artifactId, kind, mediaType, checksum,
    sizeBytes, evidenceDigest, content }`. It never returns a host path. A failed
    read returns a path-opaque error and no content.
- `GET /api/runs/:runId/events?after=<sequence>`
  - Server-Sent Events for normalized and raw-native records after the numeric
    sequence. Supply the bearer header when auth is enabled.
- `GET /api/approvals`
- `GET /api/memory/search?projectId=...&q=...`
- `GET /api/memory/proposals`
- `GET /api/memory/proposals/:proposalId/preview`
  - Computes an exact promotion preview without writing canonical Markdown.

## Run mutations

### `POST /api/engineering/assessments`

This is an authenticated assessment, not a run mutation. The caller may supply
only project/task identity, the literal request, an optional upward-only
preference, final-action intent, and an idempotency key:

```json
{
  "projectId": "ovalo",
  "taskId": "task_ovalo_parser",
  "request": "Implement a bounded parser with unit tests.",
  "preference": "auto",
  "finalAction": "prepare_reviewable_result",
  "idempotencyKey": "route-parser-001"
}
```

Scores and hard signals are control-plane-owned; extra fields are rejected.
Migration 010 persists the decision transactionally. Without M7 configuration,
the response records prototype/unavailable sources. With a reviewed M7 policy and
read connectors, it records bounded current Linear/Git revisions. In both cases
general execution remains `executionSupported=false`, `status="unsupported"`,
and `launch.supported=false`: this route creates no run, workspace, lease,
container, or fixed-pilot substitution.

## Milestone 7 connector operations

Every route below requires configured bearer authentication. Mutations also
require a configured `CONTROL_PLANE_OPERATOR_ID`.

- `GET /api/connectors/status` returns enabled modes, configured project IDs,
  safe credential-loaded booleans, bounded final-action delivery status, and external-action
  counts. It returns no token, path, provider URL, or policy contents.
- `GET /api/connectors/outbox/dead?limit=...` lists a bounded page for the exact
  external-final-action consumer.
- `POST /api/connectors/outbox/dead/:outboxId` accepts `{}` and requeues only a
  dead exact delivery under its stable action identity.
- `POST /api/external-actions/github-draft-pr` accepts only `runId`, bounded
  `title`/`body`, optional `idempotencyKey`, and optional `expiresAt`. The
  repository/base/head/OIDs come exclusively from policy and current authority.
- `POST /api/external-actions/linear-evidence-comment` accepts only `runId`,
  bounded `body`, optional `idempotencyKey`, and optional `expiresAt`. The fixed
  issue target comes exclusively from policy.
- `POST /api/external-actions/linear-issue` accepts only `runId`, bounded
  `title`/`description`, optional `idempotencyKey`, and optional `expiresAt`.
  The team/project target comes exclusively from the accepted connector policy;
  ordinary idea/task creation never calls the provider.
- `GET /api/external-actions?projectId=...&state=...&limit=...` and
  `GET /api/external-actions/:planId` expose bounded durable plan/receipt state.
- `POST /api/external-actions/:planId/resolve` accepts `approve`, `deny`, or
  `request_changes` plus an optional idempotency key. Approval only authorizes
  the already-bound plan; provider work happens after a fresh worker preflight.
- `POST /api/external-actions/:planId/reconcile` is HTTP-only and accepts a
  bounded zero/one/multiple result plus exact provider identity hashes. It is for
  an already-ambiguous effect and cannot supply a target, URL, ref, command, or
  arbitrary payload. Zero remains ambiguous; one exact match succeeds; multiple
  matches quarantine for operator review.

The general MCP implementation contains bounded counterparts for status,
dead-letter operations, plan preparation/list/get, and plan resolution. The
default Hermes pilot wrapper does not automatically enable those M7 mutations;
operators must set an explicit reviewed tool allowlist. Reconciliation remains
HTTP-only.

### `POST /api/runs`

Mock example:

```json
{
  "projectId": "ovalo",
  "objective": "Exercise the governed mock lifecycle",
  "runtime": "atomic",
  "maxCostUsd": 2,
  "idempotencyKey": "mobile-mock-001"
}
```

Native connectivity example:

```json
{
  "projectId": "ovalo",
  "objective": "Return exactly VALKYRIE_API_CODEX_OK and nothing else.",
  "runtime": "codex",
  "workflow": "runtime-connectivity",
  "maxCostUsd": 1,
  "idempotencyKey": "mobile-native-001"
}
```

Credential-free Atomic fixture example (only when the separate default-off
feature is configured):

```json
{
  "projectId": "atomic-pilot",
  "taskId": "task_atomic_fixture_m5",
  "objective": "Implement normalizeProjectSlug in the disposable Atomic pilot fixture and stop after verified evidence for control-plane approval.",
  "runtime": "atomic",
  "workflow": "atomic-fixture-pilot",
  "maxCostUsd": 0.25,
  "idempotencyKey": "mobile-atomic-fixture-001"
}
```

M3 native adapters accept only the literal `runtime-connectivity` workflow.
Omitting it or asking for another workflow is rejected. Atomic performs offline
RPC/package discovery; Codex and an available Claude adapter make bounded
read-only model calls. Direct Codex/Claude objectives must be exactly `Return
exactly MARKER and nothing else.` where `MARKER` is 3–64 uppercase letters,
digits, or underscores. Every final action is `analysis_only`.

The separate M5a workflow accepts only the exact project, task, objective, and
Atomic runtime shown above. Repository/image/engine/command/artifact choices are
server configuration and are never request fields. A healthy request first
returns `queued`; poll until it reaches cleaned `awaiting_approval` or a terminal
failure. It runs a real Atomic 0.9.12 tool-only workflow in the no-network OCI
writer, not an Atomic provider/model. Its fresh verifier is deterministic, model
cost/tokens remain zero, and `crossProcessResume=false`.

The response has the selected route plus a run detail:

```json
{
  "run": {
    "run": { "id": "run_...", "status": "running" },
    "task": null,
    "events": [],
    "approvals": [],
    "artifacts": []
  },
  "route": { "runtime": "codex", "reason": "Explicit user selection" }
}
```

Atomic may already be completed when the response returns; direct adapters return
after a native session ID is observed and finish asynchronously. Poll the detail
route or use SSE until `completed`, `failed`, or `cancelled`.

`idempotencyKey` is optional but recommended for mobile retries. Reuse it only for
the exact same logical body. Exact replay returns the original run; changed input
returns a conflict.

### Milestone 6 direct candidate and comparison

When the complete default-off M5b deployment plus
`DIRECT_CODEX_MODEL_PILOT_ENABLED=true` are configured, `runs_start` accepts only
this additional literal contract:

```json
{
  "projectId": "atomic-pilot",
  "taskId": "task_atomic_fixture_model_m5b",
  "objective": "Implement normalizeProjectSlug in the disposable Atomic pilot fixture using the configured model, run the immutable checks, obtain a fresh independent verifier decision, and stop before any external final action.",
  "runtime": "codex",
  "workflow": "direct-codex-fixture-model-pilot",
  "maxCostUsd": 1,
  "idempotencyKey": "direct-codex-fixed-001"
}
```

The exact task ID/objective remain those exported by the fixture package; callers
should obtain them from the documented fixed contract rather than editing the
literal. The server owns repository/image/command/policy details.

- `GET /api/direct-codex-fixture/runs/:runId/artifacts/:artifactId` reads one
  bounded UTF-8 artifact only while the exact pending approval remains valid.
- `POST /api/direct-codex-fixture/approvals/:approvalId/resolve` accepts only
  `approve`, `deny`, or `request_changes`. Approve records a safe mock receipt;
  it performs no external action or memory promotion.
- `POST /api/runs/compare` accepts the exact fixture plus runtimes
  `["atomic","codex"]`, optional existing `candidateRunIds` in the same order,
  and an idempotency key. It creates/attaches independent candidates.
- `GET /api/comparisons/:comparisonId` refreshes and returns the durable
  evidence-derived comparison. Comparison completion is not candidate selection.

`direct-claude-code-fixture-model-pilot` is recognized only as a separately
gated unavailable capability. It cannot reuse Codex credentials or silently
fall back to the Codex implementation.

### Other run mutations

- `POST /api/runs/compare`
  - The mock-demo contract remains available without M6 coordinators. With both
    M6 coordinators configured, only the exact fixed Atomic/direct-Codex contract
    described above is accepted.
- `POST /api/runs/:runId/steer`
  - `{ "message":"..." }`
  - Works only when the selected adapter advertises steering; minimum native
    adapters do not.
- `POST /api/runs/:runId/cancel`
- `POST /api/approvals/:approvalId/resolve`
  - `{ "decision":"approve" | "deny" | "request_changes" }`
  - Native runtime approval/HIL mapping is not implemented.
- `POST /api/atomic-fixture/approvals/:approvalId/resolve`
  - `{ "decision":"approve" | "deny" | "request_changes" }`
  - Resolves only action `accept_atomic_fixture_result`. The approval is bound to
    its run/project/workflow, complete artifact digest, sandbox policy hash, and
    expiry (15 minutes in the current coordinator). Approve records a safe mock receipt after writer cleanup; it cannot
    create a PR, merge, deploy, mutate an external database, expand credentials,
    or promote the proposed memory.
- `POST /api/atomic-model-fixture/approvals/:approvalId/resolve`
  - `{ "decision":"approve" | "deny" | "request_changes" }`
  - Available only when the fixed model pilot and configured operator principal
    are enabled. It resolves only `accept_atomic_fixture_model_result`, after
    re-opening every governed artifact and rechecking exact run/project/workflow,
    evidence digest, sandbox policy, expiry, and cleanup. Approve records only a
    safe mock receipt.
- `GET /api/atomic-model-fixture/runs/:runId/artifacts/:artifactId`
  - Returns one bounded UTF-8 artifact from the pending model-pilot gate after a
    no-follow checksum/size/media verification. It never returns a host path and
    serializes only a fixed pathless failure.

## Idea and demo mutations

- `POST /api/ideas`
  - `{ "projectId":"ovalo", "title":"..." }`
- `POST /api/demo/reset`
  - SQLite demo only. Disabled by the pilot wrapper and always disabled for
    PostgreSQL.

## Governed memory mutations

### 1. Propose

`POST /api/memory/proposals`

```json
{
  "projectId": "ovalo",
  "claim": "A reviewed durable claim of at least ten characters.",
  "evidence": ["run run_... artifact artifact_..."],
  "runId": "run_..."
}
```

This stores advisory state only.

### 2. Preview

`GET /api/memory/proposals/:proposalId/preview`

The response binds the project/proposal, relative target, resolved path, exact
Markdown, content hash, preview hash, reviewer, and review timestamp:

```json
{
  "projectId": "ovalo",
  "proposalId": "memory_...",
  "target": "Projects/Ovalo/Decisions/memory_....md",
  "path": "/resolved/project-brain/Projects/Ovalo/Decisions/memory_....md",
  "content": "---\n...",
  "contentHash": "<sha256>",
  "previewHash": "<sha256>",
  "approvedBy": "wesley",
  "approvedAt": "<ISO-8601>"
}
```

Preview does not write a file.

A preview is short-lived: promotion accepts it for at most 15 minutes and allows
at most 30 seconds of future clock skew. If it expires, call the preview route
again, show the new exact target/content to Wesley, and submit that unchanged
value. Do not rewrite its timestamp client-side.

### 3a. Reject

`POST /api/memory/proposals/:proposalId/resolve`

```json
{ "decision": "reject" }
```

### 3b. Promote after exact human review

```json
{
  "decision": "promote",
  "preview": { "projectId": "...", "proposalId": "...", "target": "...", "path": "...", "content": "...", "contentHash": "...", "previewHash": "...", "approvedBy": "wesley", "approvedAt": "..." }
}
```

The entire unchanged preview is required. Missing, tampered, expired/future-dated,
cross-project, or already-resolved input fails without silently promoting. Successful promotion
writes the exact Markdown and then resolves proposal state; cross-resource
filesystem/database atomicity is still a known limitation. The native pilot MCP
allow-list excludes promotion, and `npm run smoke:native` always previews then
rejects.

## Error and safety behavior

Validation/start errors return JSON `{ "error":"..." }`, normally with `400`.
Unauthorized API access returns `401`; disabled demo reset returns `403`; healthy
accepted run creation returns `202`; proposal creation returns `201`.

Run creation is explicitly idempotent. Other mutations need a broader
authenticated idempotency contract before production/multi-client use. Do not
expose this prototype beyond its documented local pilot boundary.
