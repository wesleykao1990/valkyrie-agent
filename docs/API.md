# HTTP API

Base URL: `http://127.0.0.1:8787`

## Read operations

- `GET /health`
  - Reports the selected storage backend and migration health; returns 503 when
    storage is unavailable or not current.
- `GET /api/portfolio`
- `GET /api/projects`
- `GET /api/projects/:projectId/brief`
- `GET /api/tasks?projectId=...`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events` — Server-Sent Events
- `GET /api/approvals`
- `GET /api/memory/search?projectId=...&q=...`
- `GET /api/memory/proposals`

## Mutations

- `POST /api/ideas`
  - `{ "projectId": "ovalo", "title": "..." }`
- `POST /api/runs`
  - `{ "projectId": "ovalo", "objective": "...", "runtime": "atomic", "maxCostUsd": 8, "idempotencyKey": "mobile-request-123" }`
  - `idempotencyKey` is optional. Reusing it with the same request replays the
    stored run; changing the request returns a conflict error.
- `POST /api/runs/compare`
  - `{ "projectId": "ovalo", "objective": "...", "runtimes": ["atomic", "codex", "claude"], "perRunMaxCostUsd": 8 }`
  - Creates one isolated run/workspace per candidate and returns a shared comparison ID.
- `POST /api/runs/:runId/steer`
  - `{ "message": "..." }`
- `POST /api/runs/:runId/cancel`
- `POST /api/approvals/:approvalId/resolve`
  - `{ "decision": "approve" | "deny" | "request_changes" }`
- `POST /api/memory/proposals`
  - `{ "projectId": "ovalo", "claim": "...", "evidence": ["..."] }`
- `POST /api/memory/proposals/:proposalId/resolve`
  - `{ "decision": "promote" | "reject" }`
- `POST /api/demo/reset`
  - Disabled by default when PostgreSQL is selected.

Run creation has explicit body-level idempotency. Other mutations still require a
general authenticated idempotency contract before production use. The entire HTTP
surface is unauthenticated and local-prototype only.
