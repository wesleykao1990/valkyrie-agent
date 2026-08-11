# Verification record

Package version: 0.3.0

## Untouched baseline

Before source changes, the restored `0.2.2` whole-system repository passed:

```bash
npm run verify
```

Baseline evidence:

- 10/10 automated tests passed.
- HTTP smoke launched three isolated scripted candidates, resolved three approval
  gates, stored artifacts, and promoted one explicitly reviewed memory proposal.
- MCP smoke listed 15 tools and exercised portfolio and read-only memory calls.
- No pre-existing failure was hidden.

The untouched Atomic `0.2.0` source passed its dependency-free structural verifier:
23 required files, 3 workflows, 16 router cases, and 5 prompt templates. Its
optional TypeScript verifier could not run before the containing repository
installed a TypeScript toolchain; this baseline limitation was recorded rather
than treated as a pass.

## Final full verification

Command:

```bash
npm run verify
```

The final command performs, in order:

1. strict TypeScript 5.8.3 checking with `noCheck=false`;
2. the general Node test suite (SQLite plus policy/service/runtime contracts);
3. a disposable PostgreSQL 16 contract suite;
4. Atomic package structural/schema/type verification;
5. HTTP lifecycle smoke;
6. MCP stdio smoke.

Recorded result on 2026-08-11:

- TypeScript: passed.
- General suite: 33 passed, 1 opt-in PostgreSQL case skipped in this phase.
- Disposable PostgreSQL 16.14 phase: 16 passed, 0 skipped.
- Atomic `0.2.1`: 28 required files, 3 workflows, 16 routing cases, 5 prompt
  templates, a schema-valid launch manifest, and 5 invalid-manifest rejection
  cases; package TypeScript passed.
- HTTP smoke: 3 projects, 3 distinct scripted candidates/workspaces, 3 approvals,
  artifact counts 3/2/2, invalid/missing decisions rejected without mutation, and
  one explicit memory promotion.
- MCP smoke: 15 tools, portfolio/memory calls, and idempotent `runs_start` replay
  returned one stable run.

The PostgreSQL phase creates a temporary cluster under `/tmp`, binds only a random
loopback port, uses no existing `DATABASE_URL`, stops the server, and removes the
cluster.

## Storage evidence

Both adapters cover:

- fresh/repeated checksummed migrations and fail-closed unknown/checksum ledgers;
- transactional run/workspace/writer-lease creation and rollback;
- exact-content event/outbox retry behavior;
- atomic approval request and resolution, conflict handling, and idempotency;
- immutable run/project/runtime/workspace identity;
- run/workspace/lease ownership constraints;
- exclusive worker claims;
- close/reopen or pool restart;
- queued/resolved/terminal/expired reconciliation candidates and pending outbox
  persistence;
- dependency-safe reset ordering.

SQLite migration 003 validates legacy ownership before stamping and installs
semantic owner triggers. PostgreSQL migration 003 adds the composite run/workspace
owner constraint. Unsafe legacy ownership fails closed.

## Fresh-context review

An independent reviewer that did not author storage or caller changes found nine
evidence-backed issues in the first pass. Repair round 1 addressed all nine:

- expired-lease approval replay resurrection;
- non-transactional approval request transition;
- PostgreSQL demo reset/seed exposure;
- migration-backend typo fallback;
- workspace/run/lease ownership parity and unsafe legacy adoption;
- approval idempotency binding on compatible replay;
- unverified Atomic compatibility wording;
- arbitrary approval-decision coercion;
- mutable run identity/ownership fields.

Regression tests were added. A final targeted audit then found one additional
cross-run approval-event ownership gap; both adapters now reject it before any
approval, run, event, outbox, or idempotency mutation, with shared SQLite and
PostgreSQL rollback coverage. The independent re-review found no remaining release
blocker. Missing/mistyped approval and memory decisions are rejected rather than
defaulting to a destructive outcome.

## Document review

The architecture review DOCX was extracted, rendered with the document runtime,
and every actual page was inspected. It has 24 pages, not the old handoff record's
23. Content is coherent, but the supplied source has layout defects: an orphaned
sentence/excess blank area on page 10 and left-clipped Appendix C/E headings on
pages 22 and 24. The signed-off source file remains unchanged.

## Dependency and hygiene checks

- Locked direct versions: TypeScript 5.8.3, `@types/node` 22.20.1,
  `@types/pg` 8.21.0, optional `pg` 8.23.0.
- `npm install --package-lock-only --ignore-scripts`: 0 known vulnerabilities.
- Root-authored diffs pass whitespace checking; imported Atomic research retains
  its original intentional Markdown line breaks.
- No credential or production secret was added.
- Unit, HTTP, and MCP fixture wrappers strip inherited persistent storage,
  connector, and `REPOSITORY_PATH_*` settings from their disposable child
  processes. The supported `npm run test:postgres` path creates the disposable
  cluster and supplies its own explicit contract sentinel and database URL.

## Live integrations actually exercised

- Local SQLite through the real adapter.
- Disposable local PostgreSQL 16.14 through the real adapter.
- Local HTTP and stdio MCP transports using scripted mock runtimes.
- GitHub repository metadata read through the authenticated GitHub connector.

Not exercised as a live integration:

- Atomic host/runtime, Codex, Claude Code, Prime, or Hermes agent execution;
- Linear API/MCP, GitHub PR connector at verification time, or OpenViking;
- real Git worktree/container/VM writer boundary;
- external outbox delivery, deployment, merge, or production secret access.
