# HTTP API

Base URL: `http://127.0.0.1:8787`

## Read operations

- `GET /health`
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
  - `{ "projectId": "ovalo", "objective": "...", "runtime": "atomic", "maxCostUsd": 8 }`
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

All mutations should gain explicit authentication and idempotency headers before production use.
