# Storage setup and operations

Version: 0.3.0
Status: SQLite demo adapter and PostgreSQL production-candidate adapter implemented

## Backend selection

The application has one asynchronous `ControlPlaneStore` boundary.

| Backend | Selection | Intended use | Migration behavior |
|---|---|---|---|
| SQLite | `CONTROL_PLANE_STORE=sqlite` (default) | Local zero-service demo and tests | Applies checked migrations on open |
| PostgreSQL | `CONTROL_PLANE_STORE=postgres` | Durable multi-process candidate | Fails closed unless current; explicit migration recommended |

The adapters use separate data sets. There is no dual write and no automatic
SQLite-to-PostgreSQL copy.

## SQLite

The default database is `./data/control-plane.sqlite`. Override the parent
directory with `DATA_DIR`.

```bash
npm start
```

SQLite uses WAL, foreign keys, a busy timeout, and full synchronous writes. Its
schema is owned by `infra/sqlite/*.sql` and recorded in `schema_migrations` with a
SHA-256 checksum. A changed applied migration fails open/startup; add a new
forward migration instead of editing history.

The live browser/API reset has no confirmation dialog; it clears SQLite
operational rows transactionally and reseeds demo tasks. The offline `npm run
reset` command is different: after the service is stopped, it deletes the SQLite
main, WAL, and shared-memory files under `DATA_DIR` and surfaces filesystem
failures. It refuses to run when `CONTROL_PLANE_STORE` is not `sqlite`. The next
start recreates and seeds the database. Neither path removes artifact/workspace
directories or promoted Project Brain Markdown. They are not production backup
or migration commands.

## PostgreSQL setup

Use PostgreSQL 16 or a deliberately tested later version. Create a dedicated
database and least-privilege roles outside this repository. Do not put credentials
in `.env`, shell history, Git, logs, or examples committed to the project.

For a disposable local database, create the role and database, then inject
`DATABASE_URL` through an appropriate local secret mechanism rather than placing
its value in shell history:

```bash
createuser --pwprompt control_plane
createdb --owner=control_plane control_plane

CONTROL_PLANE_STORE=postgres \
npm run migrate
```

Migration output reports each version, filename, status, and a shortened
checksum. Re-running the command must report `already_applied` for every version.
The migrator takes a PostgreSQL advisory lock so only one process applies schema
changes at a time.

Start the service only after migration succeeds:

```bash
CONTROL_PLANE_STORE=postgres \
POSTGRES_AUTO_MIGRATE=false \
SEED_DEMO_DATA=false \
ENABLE_DEMO_RESET=false \
npm start
```

`POSTGRES_AUTO_MIGRATE=true` is available for disposable developer environments.
Keep it false in governed deployments so migration and runtime authority can use
separate roles and release gates.

PostgreSQL mode deliberately disables automatic demo project/task seeding. A new
database therefore exposes an empty portfolio until a governed ingestion or
bootstrap path provisions project state. Use SQLite for the out-of-box walkthrough.

Use TLS appropriate to the deployment boundary. `pg` accepts connection-string
TLS parameters; the explicit migration command also supports
`POSTGRES_SSL=require`. Validate the certificate policy in the target environment
rather than assuming a local example is production-safe.

## Role separation

Recommended deployment roles:

- **migration owner**: can create/alter schema objects and update
  `schema_migrations`; used only during a governed release;
- **runtime role**: can connect and perform the required DML/sequence operations,
  but cannot alter schema or grant privileges;
- **backup/observer role**: read-only and separately audited where needed.

Grant exact privileges after schema creation and re-evaluate them whenever a new
migration adds a table or sequence. Never reuse a broad developer/superuser role
for the long-running control-plane process.

## Transaction boundaries

Both adapters implement named aggregate operations so callers do not compose
partial transactions accidentally:

- run, optional workspace, and writer lease creation;
- event append plus matching outbox record;
- conditional approval resolution, optional run patch/event, and outbox record;
- workspace/lease acquisition, rotation, renewal, quarantine, and exact-fence
  release;
- task/memory mutations plus outbox records;
- all-or-nothing, exact-replay artifact batches plus deterministic outbox rows.

Filesystem preparation is outside the database transaction. The service discards
an unpersisted prepared workspace after a database failure or an idempotent race.
That compensating cleanup is not a substitute for the real worktree/container
reconciler required by the workspace milestone.

## Idempotency

`runs_start`/`POST /api/runs` accepts `idempotencyKey`.

- Same scope/key and same canonical request hash: return the original run and
  workspace without another writer lease or runtime start.
- Same scope/key and a different hash: fail with an idempotency conflict.
- Stable event IDs replay only if the complete stored event matches.
- Approval retries replay the same decision and reject a conflicting decision.

Idempotency expiry is recorded but this version has no scheduled cleanup or
retention job. Set production retention only after accounting for mobile retry
windows and audit requirements.

## Outbox behavior

The outbox row commits in the same transaction as its business mutation. IDs are
deterministic for an operation, and a reused ID must match exact topic, aggregate,
and payload content.

This version does **not** publish to Linear, GitHub, a broker, or any other external
system. It exposes pending rows and retry bookkeeping for a future dispatcher.
That dispatcher must provide at-least-once delivery, deduplicate stable IDs, bound
attempts/backoff, redact logs, and retain raw failure evidence.

## Startup and restart reconciliation

Startup inspects:

- queued runs whose native runtime start was never confirmed;
- approvals resolved while their run still awaits application;
- active leases left on terminal runs;
- expired active writer leases and durable quarantined leases;
- nonterminal durable sandbox instances plus exact provider engine inventory;
- pending outbox rows.

An unconfirmed queued run is failed. Legacy/demo leases whose owner is the run may
be released, but strict isolated-writer leases are quarantined for provider-aware
reconciliation because a database fence alone does not prove their container is
gone. Expired active writers are quarantined and their runs fail; quarantine
evidence remains until an operator proves cleanup and performs an exact-fence
release. Scripted mock
approvals can be safely replayed; unknown native-runtime approval state is marked
for operator reconciliation rather than claiming resumability. PostgreSQL
durability does not prove native runtime durability. Migration 005 lets the
internal writer boundary reconcile tested DB-only, engine-only, active, policy-
drift, and fence-rotation sandbox cases by exact ownership. Ambiguous or unmatched
provider objects remain untouched and quarantined for review.

## Migration failure and rollback

Migrations are forward-only. Before migrating a persistent database:

1. take and verify a recoverable backup;
2. audit existing rows against new uniqueness/ownership constraints;
3. run the migration with the dedicated migration role;
4. verify `/health` and the migration ledger before accepting traffic.

Migration `002_storage_guarantees.sql` intentionally fails if historical rows
violate one-workspace/one-writer or related integrity constraints. Repair the data
under a separate reviewed plan; do not remove the constraints to make deployment
appear green.

Migration `004_fenced_writer_leases.sql` is also forward-only. It adds monotonic
workspace lease epochs, exact writer-owner/fencing identity, renewal state, and
durable quarantine evidence. Existing v3 active leases are conservatively
backfilled with `owner_id=run_id`, fencing token `1`, and `acquired_at` equal to
their prior heartbeat. Treat those as legacy: stop/quarantine/clean them before
enabling any real writer. An older binary rejects the newer migration ledger, so
a rollback requires a verified database backup compatible with the selected
binary (or the independent SQLite data set); it is not a code-only downgrade.

Migration `005_sandbox_instances.sql` adds durable provider lifecycle and
ownership records used for restart reconciliation. It is forward-only too, so a
rollback from the current schema requires a verified pre-v5 backup.

Fencing protects database lease mutations. It cannot revoke a stale process's
raw filesystem access. The owning sandbox must still be stopped and its effective
identity/policy inspected before cleanup or fence release.

Lease expiry decisions use the storage adapter's control-plane clock, not the
caller's heartbeat timestamp. Creation and renewal require an expiry after the
observed time and no more than 24 hours ahead; rotation is allowed only after the
store observes expiry. This prevents a future-dated caller from rotating early or
reviving an already-expired fence. The cleanup coordinator then uses the exact-
fence quarantine reason `writer_filesystem_cleanup_claimed` as a rotation freeze
before artifact export. Success releases it only after container and filesystem
cleanup; interruption leaves durable operator evidence.

Application rollback is configuration-only: stop the service and select SQLite or
a previously compatible PostgreSQL application build. Switching to SQLite exposes
its independent data set; it does not roll PostgreSQL back. Destructive database
rollback/down migrations require a separate backup-backed authorization.

Demo seed and HTTP reset are hard-disabled whenever PostgreSQL is selected, even
if copied environment flags remain true. Startup fails rather than falling back
when:

- `DATABASE_URL` is absent;
- PostgreSQL is unreachable;
- the schema is missing or behind and auto-migration is off;
- an applied migration checksum differs;
- a migration or health probe fails.

## Verification

SQLite and storage-unit contract tests:

```bash
npm test
```

Disposable PostgreSQL 16 contract suite:

```bash
npm run test:postgres
```

The PostgreSQL harness creates a temporary cluster under `/tmp`, binds it to a
random loopback port with trust authentication, runs migration/concurrency/
rollback/restart tests, stops the process, and removes the cluster. It never uses
`DATABASE_URL` from an existing service. Override `INITDB_COMMAND` and
`PG_CTL_COMMAND` only when selecting known local PostgreSQL binaries.

General tests and HTTP/MCP smokes force temporary SQLite and strip persistent
storage, connector, PostgreSQL-contract, and `REPOSITORY_PATH_*` settings from
their child environments. The disposable PostgreSQL harness supplies its own
explicit contract sentinel and database URL.

Normal verification also strips all live OCI-engine/image/socket/user settings. The
opt-in `npm run smoke:sandbox` path accepts only an explicit absolute engine CLI,
an already-present immutable image digest, and an optional local `unix:///`
socket plus a reviewed numeric non-root UID:GID override when host identity cannot
be derived; it never reuses an inherited remote daemon setting.

The full repository verifier runs both suites:

```bash
npm run verify
```
