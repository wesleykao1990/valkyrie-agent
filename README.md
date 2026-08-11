# Wesley Agent Control Plane — Prototype v0.3.0

A mobile-first Project OS/control-plane prototype with a deliberately narrow
architecture:

- Hermes is the mobile interface, not a system of record.
- Linear owns roadmap and work state.
- Git/GitHub and executable checks own implementation and delivery truth.
- Accepted Project Brain Markdown owns reviewed rationale and decisions.
- The control plane owns cross-system run IDs, policy, budgets, approvals,
  workspace leases, normalized events, and artifact references.
- Exactly one native runtime owns each root run.

Version `0.3.0` completes the transactional SQLite/PostgreSQL storage milestone
and integrates the Atomic Workflow Architect as an inert, independently verified
module. It does **not** enable a real Atomic, Codex, Claude, Linear, GitHub, or
OpenViking connection.

## Quick start

Requirements: Node.js 22.16 or newer.

```bash
npm ci
npm start
```

Open `http://127.0.0.1:8787`. SQLite, demo seed data, and scripted mock runtimes
remain the defaults, so no external service or credential is needed.

Reset only the local demo database:

```bash
npm run reset
```

## Verification

The complete verifier requires Node.js plus PostgreSQL 16 command-line programs
(`initdb` and `pg_ctl`). It creates and removes a disposable local cluster; it
does not touch an existing PostgreSQL service.

```bash
npm run verify
```

Useful narrow commands:

```bash
npm run typecheck
npm test
npm run test:postgres
npm run verify:atomic
npm run smoke:http
npm run smoke:mcp
```

## PostgreSQL mode

SQLite is the zero-service demo adapter. PostgreSQL is opt-in and fails closed on
a missing URL, unavailable database, or unapplied/checksum-mismatched migration.
There is no dual write and no automatic SQLite data copy.

```bash
CONTROL_PLANE_STORE=postgres \
DATABASE_URL=postgresql://control_plane@127.0.0.1:5432/control_plane \
npm run migrate

CONTROL_PLANE_STORE=postgres \
DATABASE_URL=postgresql://control_plane@127.0.0.1:5432/control_plane \
SEED_DEMO_DATA=false \
ENABLE_DEMO_RESET=false \
npm start
```

See [Storage setup and operations](docs/STORAGE.md) before using a persistent
database.

## Hermes MCP bridge

Start the HTTP service, then register the clean stdio wrapper with Hermes:

```bash
./bin/project-os-mcp
```

The MCP bridge exposes project, run, approval, and governed-memory operations.
`runs_start` accepts an optional `idempotencyKey` for safe request retries. The
prototype bridge is unauthenticated, so keep it local and follow the restricted
allow-list in [Hermes MCP setup](docs/HERMES_MCP_SETUP.md).

## What is implemented

- Responsive developer console, HTTP API, SSE event stream, and Hermes-compatible
  stdio MCP bridge.
- Async `ControlPlaneStore` contract with SQLite and lazy-loaded PostgreSQL
  adapters.
- Explicit checksummed migrations, PostgreSQL advisory migration lock, startup
  health checks, and fail-closed backend selection.
- Transactional run/workspace/writer-lease creation, event append, conditional
  approval resolution, outbox records, and safe retry/idempotency semantics.
- Exclusive worker claims plus bounded restart reconciliation for queued runs,
  resolved approvals, terminal/expired leases, and pending outbox rows.
- Cross-project task/run/memory validation and one writer lease per candidate.
- Deterministic mock lifecycle fixtures whose events, evidence, approvals,
  artifacts, and memory claims are explicitly marked simulated.
- Read-only local Markdown retrieval and human-triggered memory proposals.
- Atomic Workflow Architect `0.2.1` integration module with its skill, router,
  prompts, workflows, launch-manifest template/schema, provenance, and package
  verification.

## What remains disabled or incomplete

- All runtime adapters are scripted mocks. `atomic-rpc-client.ts` is a disconnected
  scaffold; no live native capability or cross-process resume was verified.
- The Atomic host dependencies are not pinned to a contract-tested version set.
- Workspace directories/worktrees are coordination boundaries, not security
  sandboxes. Real writers still require an external container or VM.
- Linear, GitHub, OpenViking, and external outbox delivery are not connected.
- HTTP/MCP authentication, authorization, secret brokering, and production
  deployment do not exist.
- Project Brain promotion is not yet atomic across Markdown and database state.
- PR creation, merge, deployment, destructive database actions, expanded secret
  access, and canonical-memory promotion remain separate high-risk final actions.

The full honesty statement is in [Prototype scope](docs/PROTOTYPE_SCOPE.md), and
the challenged decisions/risks are in [Review notes](docs/REVIEW_NOTES_v0.3.0.md).

## Continue the project

Read in this order:

1. `START_HERE.md`
2. `AGENTS.md`
3. `.project-context.yaml`
4. `CLAUDE.md`
5. `docs/DECISIONS.md`
6. `docs/ARCHITECTURE.md`
7. `docs/CONTINUATION_PLAN.md`
8. `docs/PROTOTYPE_SCOPE.md`
9. `docs/IMPLEMENTATION_BACKLOG.md`
10. `SECURITY.md`
11. `docs/VERIFICATION.md`

The next-session prompt is at `docs/NEXT_SESSION_PROMPT.md`.

## License boundary

The repository root is MIT licensed. `packages/atomic-workflow-architect/` retains
its own `UNLICENSED`, private-use, all-rights-reserved notice; the root license does
not supersede it. Wesley explicitly authorized public repository visibility on
2026-08-11. Public source visibility grants no additional right to use, copy, or
redistribute that nested subtree.
