# ADR-P001: Transactional storage boundary and PostgreSQL adapter

- Status: Proposed
- Date: 2026-08-11
- Decision owner: Wesley Kao
- Implementation status: Milestone 1 evaluation

## Context

The `0.2.2` prototype binds the application directly to a synchronous SQLite
class. Multi-step lifecycle mutations can leave run state, approval state,
workspace leases, and observable events inconsistent after a crash or retry. A
PostgreSQL schema exists, but there is no adapter, migration ledger, transactional
outbox, or restart reconciliation contract.

The continuation architecture requires PostgreSQL durability without sacrificing
the zero-dependency SQLite demo. HTTP and MCP response contracts must remain
stable, and PostgreSQL must not introduce a second workflow engine or imply that
native runtime state belongs to the control plane.

## Proposed decision

1. Replace concrete storage coupling with an asynchronous `ControlPlaneStore`
   contract implemented by SQLite and PostgreSQL adapters.
2. Keep SQLite as the default demo backend. Select PostgreSQL explicitly through
   configuration and fail closed on missing connectivity or migration state.
3. Own forward-only, checksummed migrations in this repository. PostgreSQL
   migration application uses a database advisory lock; production migration and
   runtime roles should be separated.
4. Store a durable outbox record in the same transaction as each externally
   observable lifecycle mutation. Delivery is at-least-once; consumers must
   deduplicate by the stable outbox ID. This milestone stores and exposes the
   outbox but does not add an external broker.
5. Treat retries as explicit commands:
   - identical idempotency scope/key and request hash replays the stored result;
   - the same scope/key with a different hash is a conflict;
   - duplicate event IDs replay one event and one outbox record;
   - approval resolution is conditional and rejects conflicting decisions.
6. Persist one workspace and one active writer lease per run. Filesystem
   preparation remains outside the database transaction and must be cleaned up if
   persistence fails.
7. Reconcile bounded control-plane projections after restart. Unknown native
   runtime state is surfaced for human/operator action; the control plane must not
   claim unverified cross-process resume.
8. Do not dual-write or automatically copy SQLite data into PostgreSQL.

## Consequences

- All service and worker callers become asynchronous, even when SQLite is used.
- PostgreSQL deployments gain transaction and concurrency semantics without
  changing the public JSON shapes.
- The outbox enables later reliable connector delivery but adds sensitive retained
  data and therefore requires retention policy and access control.
- Selecting SQLite after a PostgreSQL rollback returns to a separate data set; it
  is an application rollback, not a database rollback.
- PostgreSQL durability does not provide runtime or filesystem isolation.

## Alternatives rejected for this milestone

- Redis or another coordination service: unnecessary before the database contract
  is proven.
- An ORM/migration framework: adds a new abstraction without solving a current
  requirement better than small explicit adapters and SQL migrations.
- Dual-write migration: creates correctness and rollback ambiguity.
- A generic transaction callback exposed to domain services: makes lifecycle
  atomicity easy to bypass; named aggregate operations are preferred.

## Approval requested

Wesley should accept or amend the idempotency scope, outbox delivery semantics,
one-workspace-per-run invariant, and forward-only migration ownership before this
proposal is promoted to an accepted architecture decision.
