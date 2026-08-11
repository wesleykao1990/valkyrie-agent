# Prototype scope and honesty statement

## Implemented

- Projects, tasks, runs, events, approvals, artifacts, memory proposals, workspace records, and writer leases.
- Responsive developer console.
- Stable HTTP API.
- SSE run-event stream.
- Explicit routing policy.
- Mock Atomic, Codex, Claude, Prime, and Hermes runtimes.
- Human approval before mock PR preparation.
- Read-only canonical-project search.
- Human-gated Markdown promotion.
- Local stdio MCP server for Hermes.
- Atomic RPC client scaffold.
- Tests for routing, lifecycle, approval, memory proposal, project isolation, comparison workspaces, steering, and strict Atomic JSONL framing.

## Intentionally simulated

- Linear: local task projection only.
- Git worktree: simulated directory unless a local repository path is configured.
- Sandbox: no external agent command is executed in mock mode.
- OpenViking: local read-only Markdown search is the fallback implementation.
- Atomic/Codex/Claude/Prime: lifecycle simulations by default.
- GitHub PR: represented as an artifact/event, not created remotely.

## Not implemented

- Production authentication and multi-user authorization.
- Secret broker and short-lived credentials.
- Remote sandbox provider.
- Actual Linear MCP/API write-through.
- Actual OpenViking protocol integration.
- Actual Atomic workflow-run discovery, approval mapping, and resume semantics.
- Codex or Claude native session adapters.
- Production PostgreSQL store.

These are continuation tasks, not hidden claims.
