# Milestone 0 implementation plan: PostgreSQL storage and Atomic package integration

Status: Milestones 1 and 2 implemented and verified
Whole-system baseline: `0.2.2`
Imported Atomic package: `0.2.0`
Plan date: 2026-08-11

## Baseline evidence

The untouched whole-system repository passed `npm run verify` before any changes:

- 10 tests passed;
- the HTTP smoke test completed three isolated mock candidates, three approvals,
  artifacts, and one governed memory promotion;
- the MCP smoke test discovered 15 tools and exercised portfolio and memory reads.

The staged Atomic package passed its structural `npm run verify` (23 required files,
3 workflows, 16 router cases, and 5 prompt templates). Its optional
`npm run verify:all` did not run TypeScript because the source package does not
declare or install `tsc`. No live Atomic process or external connector was tested.

## Inventory and boundaries

- Storage is currently a synchronous, concrete `SqliteStore`; service, HTTP/SSE,
  workspace, and mock-runtime code depend on it directly. SQLite DDL is inline,
  while PostgreSQL has only an unused initial schema and outbox table.
- Run creation, event append, approval resolution, workspace leasing, and runtime
  transitions are multi-statement operations without transactions, idempotency,
  an operational outbox, or startup reconciliation.
- All registered runtimes are deterministic mocks. `atomic-rpc-client.ts` is an
  unregistered scaffold; it has LF decoding and environment filtering but no live
  contract, launch manifest, raw-event retention, or restart attachment.
- Workspaces are prototype directories with database lease records, not security
  sandboxes. Worktree failure can fall back to the prototype directory.
- Project Brain retrieval is local lexical Markdown and is not yet snapshotted into
  a bounded run context pack.
- HTTP and MCP are unauthenticated prototype surfaces. GitHub, Linear, Atomic,
  Codex, Claude, containers, and production credentials remain unconfigured.
- Existing repository milestone numbers predate the continuation bundle. In this
  plan, “Milestone 2” means the bundle's inert Atomic package integration, not the
  older plan's Linear projection milestone.

## Milestone 1: PostgreSQL behind the store contract

### Intended changes

1. Introduce an asynchronous `ControlPlaneStore` contract and factory. Preserve
   `SqliteStore` as the default, zero-service demo implementation and add a
   lazily loaded `PostgresStore` using `pg` only when selected.
2. Move both backends to explicit, checksummed, forward-only migrations with a
   migration ledger. PostgreSQL migrations use an advisory lock.
3. Add the same outbox and idempotency records to both databases. Aggregate
   transaction methods will cover:
   - run/workspace/writer-lease creation;
   - event plus outbox append;
   - conditional approval resolution plus outbox;
   - lease release plus workspace status;
   - idempotent run creation and replay.
4. Convert service, server, workspace, mock runtimes, scripts, and tests to await
   the store without changing existing HTTP response bodies or MCP tool results.
5. Add bounded startup reconciliation for queued runs and inconsistent terminal
   leases. Unknown native runtimes will be reported, never claimed resumable.
6. Fix directly exposed integrity defects alongside the contract work: reset
   deletion order, cross-project task/run validation, and mock evidence labelling.

### Configuration and flags

- `CONTROL_PLANE_STORE=sqlite|postgres` defaults to `sqlite`.
- `DATABASE_URL` is required for PostgreSQL. Selection fails closed; there is no
  silent SQLite fallback.
- Demo seed/reset is hard-disabled for PostgreSQL even when copied environment
  flags remain true. No Redis, dual-write, or automatic SQLite-to-PostgreSQL copy
  is introduced.
- Real Atomic execution remains disabled.

### Tests and evidence

- Run a shared lifecycle/store contract suite against SQLite and a disposable
  PostgreSQL 16 database.
- Test fresh and repeated migration output, transactional rollback, event/outbox
  atomicity, idempotent replay/conflict, conditional approval resolution,
  workspace lease atomicity, close/reopen behavior, and startup reconciliation.
- Run narrow storage tests first, then the unchanged HTTP/MCP smoke paths, then
  `npm run verify`.

### Rollback and failure behavior

- Application rollback is configuration-only: select SQLite again. The adapters
  do not share or synchronize data.
- Database migrations are forward-only. Back up non-disposable databases before
  migrating; destructive down migrations require separate approval.
- PostgreSQL startup fails on a missing URL, unreachable database, checksum
  mismatch, or unapplied migration when auto-migration is disabled.

### Security impact

- SQL is parameterized; connection strings and payload bodies must not be logged.
- Production deployments need separate least-privilege migration/runtime roles,
  TLS, retention for outbox/idempotency data, and authentication in front of HTTP
  and MCP. PostgreSQL durability does not make the runtime or workspace a sandbox.

## Milestone 2: inert Atomic module integration

1. Import the source package intact at
   `packages/atomic-workflow-architect/`, preserving its skill, router, prompts,
   manifest, workflows, integration guidance, research, and nested license.
2. Add provenance, package-version, source-hash, compatibility, and live-test
   status documentation. The module is Atomic-specific and is not the whole
   Project OS.
3. Add root discovery and `verify:atomic`; do not use npm workspaces or register a
   live adapter. Wildcard peer dependencies and unverified capabilities remain
   quarantined.
4. Preserve lightweight package bootstrap files and independently verify its
   structural router/prompt/workflow assets. Any package-local correction will be
   recorded as a derived integration revision rather than misrepresenting the
   imported archive.
5. Treat the imported Atomic decision addendum as proposed reconciliation until
   accepted in the whole-system decision registry.

Rollback removes the inert subtree, verification hook, and additive documentation;
it requires no database migration. The subtree's `UNLICENSED`/all-rights-reserved
terms are not covered by the repository's root MIT license. Wesley explicitly
authorized public repository visibility on 2026-08-11 without changing the nested
license grant.

## Explicit non-goals for this session

- No real Atomic subprocess, SDK embedding, native resume claim, or Atomic default.
- No real Git worktrees/containers, Linear/GitHub writes, OpenViking, deployment,
  canonical-memory auto-promotion, production authentication, or secrets.
- No change to the one-root-runtime rule or to direct Codex/Claude availability.

## Review and decision record

Implementation will receive a fresh-context review after both milestones pass.
Architecture changes will be added as proposed decisions: asynchronous storage
contract, migration ownership, idempotency/outbox semantics, and imported Atomic
addendum reconciliation. Accepted decisions will not be silently rewritten.
