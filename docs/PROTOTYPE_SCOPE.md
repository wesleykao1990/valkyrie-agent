# Prototype scope and honesty statement

Version: 0.3.0

## Implemented and verified

- Projects, tasks, runs, normalized events, approvals, artifacts, governed memory
  proposals, workspace records, and writer leases.
- Responsive developer console, stable HTTP API, SSE event stream, and local
  stdio MCP bridge for Hermes-compatible clients.
- Explicit routing, exactly one root runtime per run, and isolated comparison
  records/workspace leases for Atomic/Codex/Claude candidates.
- Async storage contract implemented by SQLite and PostgreSQL.
- Checksummed forward migrations, PostgreSQL migration locking, health checks,
  run/event/approval/workspace transaction boundaries, stable idempotency, and a
  transactional outbox in both adapters.
- Exclusive run claims and startup reconciliation for interrupted starts,
  stranded approvals, terminal/expired leases, and pending outbox rows.
- Cross-project task/run/memory integrity checks.
- Read-only local accepted-Markdown search and human-triggered proposal review.
- Atomic JSONL decoder/environment-filter scaffold tests; the scaffold is not a
  registered runtime.
- Inert Atomic Workflow Architect module with independently tested router,
  workflows, prompt templates, launch-manifest template/schema, and provenance.

## Intentionally simulated

- Atomic, Codex, Claude, Prime, and Hermes runtime adapters execute deterministic
  lifecycle fixtures only. Every mock event/evidence/artifact/approval/memory claim
  is marked simulated.
- Linear is a local task projection. Nothing is read from or written to Linear.
- A workspace is a prototype directory or best-effort local Git worktree. It is
  not an external container/VM sandbox.
- GitHub PR preparation is an artifact/event only; no PR, merge, deployment, or
  branch protection action is performed.
- Project Brain retrieval is deterministic local Markdown search, not OpenViking.

## Implemented but not yet production-complete

- PostgreSQL is a working, contract-tested adapter. Production still needs
  deployment-specific least-privilege roles, TLS, backups, monitoring, retention,
  authenticated callers, and an external outbox dispatcher.
- Run claims have expiry and exclusivity, but real long-running runtimes need claim
  renewal/fencing.
- Prepared workspace cleanup covers unpersisted local candidates; real worktree,
  container, heartbeat, orphan, artifact-export, and secret-scan behavior remains
  a later milestone.
- Memory promotion is human-triggered but not atomic across filesystem and database
  state.

## Not implemented or exercised

- Production authentication, multi-user authorization, mutation signatures, and
  exact-action approval binding.
- Secret broker, short-lived runtime credentials, or production network policy.
- Real Atomic JSONL subprocess/SDK adapter, native event retention, verified native
  pause/resume/cancel, human-input mapping, or cross-process resume.
- Real Codex/Claude native session adapters.
- Linear MCP/GraphQL connector, webhook handling, or idempotent issue writes.
- OpenViking provider/evaluation.
- Real Git worktree/container lifecycle and security isolation.
- GitHub draft PR connector and evidence/approval gate.
- External outbox publishing, retention cleanup, or observability stack.

These are explicit continuation tasks, not implied capabilities. No external
connector, live agent runtime, production secret, remote PR, merge, deployment, or
canonical-memory auto-promotion was exercised in this milestone.
