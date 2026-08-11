# Continuation plan

## Milestone 1 — Production storage adapter

Replace the prototype SQLite adapter with PostgreSQL while preserving service and API contracts.

Acceptance criteria:

- Migrations create the same entities and uniqueness constraints.
- Run creation, event append, approval resolution, and workspace leasing are transactional.
- Outbox rows are written in the same transaction as business state.
- Reconciliation survives process restart.
- Existing tests run against both SQLite and PostgreSQL adapters.

See `infra/postgres/001_initial.sql`.

## Milestone 2 — Linear projection

Add a `LinearGateway` implementation that:

- resolves project and issue identifiers;
- creates ideas/issues with idempotency;
- reads current status live;
- appends concise run milestones and evidence links;
- verifies webhooks;
- falls back to ordinary comments/status if preview AgentSession APIs are unavailable.

Do not mirror the full Linear roadmap into local tables.

## Milestone 3 — Read-only OpenViking trial

Implement the `ProjectBrain` backend through confirmed OpenViking APIs or MCP.

Evaluate:

- correct-project retrieval;
- cross-project leakage rate;
- accepted-decision ranking;
- stale/superseded result suppression;
- deletion and retention;
- context token cost;
- failure fallback to the local vault.

Automatic capture stays disabled until this passes.

## Milestone 4 — Atomic A/B pilot

Wire `AtomicRpcClient` into a real runtime adapter and compare one medium-risk Ovalo task against a direct Codex or Claude path.

Measure:

- correctness and defects caught;
- elapsed time;
- model and infrastructure cost;
- human review burden;
- event/recovery reliability;
- resumability;
- integration effort.

Promote Atomic to default only if the result justifies the additional runtime.

## Milestone 5 — Real workspace sandbox

Replace simulated workspaces with:

- one Git worktree per candidate;
- container/devcontainer per writing run;
- no production credentials;
- scoped network and filesystem access;
- lease heartbeat and orphan cleanup;
- artifact export and secret scanning.

## Milestone 6 — Direct coding-agent adapters

Add Codex and Claude Code behind the same runtime interface. Preserve their native session IDs and events. Use them for small tasks, specialist reviews, and comparison candidates.

## Milestone 7 — Production Hermes experience

- Authenticate the MCP bridge.
- Add exact mutation previews.
- Add quiet hours and attention ranking.
- Return Linear, GitHub, vault, artifact, and optional Orca deep links.
- Keep the web console as an operational/debugging view, not the roadmap authority.
