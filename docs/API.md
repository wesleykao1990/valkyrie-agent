# HTTP API

Default base URL: `http://127.0.0.1:8787`

The API is a prototype contract. It does not expose raw shell/container/secret or
filesystem-management tools, and no route creates a real PR or deployment.

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

### Other run mutations

- `POST /api/runs/compare`
  - `{ "projectId":"ovalo", "objective":"...", "runtimes":["atomic","codex","claude"], "perRunMaxCostUsd":2 }`
  - Primarily a mock-demo contract. Native candidates still require explicit
    `runtime-connectivity`, which this comparison endpoint does not add; use
    separate native starts for the current pilot.
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
