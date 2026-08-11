# Session handoff — v0.3.0

Date: 2026-08-11

## 1. Milestones completed

- Milestone 0: inventory, baseline, implementation/rollback/security plan, and
  architecture/prototype review.
- Milestone 1: PostgreSQL storage behind the async store contract while retaining
  SQLite as the zero-service demo adapter.
- Milestone 2: non-live Atomic Workflow Architect package integration.

## 2. Architecture preserved

Hermes remains an interface; Linear, Git/checks, and accepted Markdown keep their
domain authority. The control plane remains a thin TypeScript modular monolith,
one task has one root runtime, Atomic is a first-class future root rather than a
workflow hidden under Codex/Claude, and direct coding-agent paths remain available.

## 3. Implementation summary

- Async SQLite/PostgreSQL adapters, explicit migrations, transactional aggregates,
  idempotency/outbox, worker claims, and startup reconciliation.
- Hard-disabled PostgreSQL demo seed/reset and fail-closed configuration/migrations.
- Safer project/run ownership, approval decisions, workspace/lease ownership, and
  simulated-evidence labels.
- Atomic module `0.2.1` with launch schema, package bootstrap, provenance, and no
  live registration.
- Setup, rollback, failure, security, review, and next-session documentation.

Use `git diff --stat` or the draft PR for the exact file list. Primary entry points
are `apps/control-plane/src/store.ts`, `sqlite-store.ts`, `postgres-store.ts`,
`service.ts`, `infra/{sqlite,postgres}/`, `tests/storage.test.ts`,
`docs/STORAGE.md`, and `packages/atomic-workflow-architect/`.

## 4. Verification evidence

- Untouched baseline: 10 tests plus HTTP/MCP smoke passed.
- Final general suite: 31 passed; the opt-in PG case skipped there.
- Disposable PostgreSQL 16.14: 16/16 passed.
- Atomic module verify/typecheck: passed.
- Full HTTP and MCP smoke: passed.
- Fresh reviewer repair round: nine first-pass findings plus final audit follow-ups
  repaired and independently rechecked.

See `docs/VERIFICATION.md` for exact coverage and commands.

## 5. Live integrations exercised

Real local SQLite, disposable local PostgreSQL, HTTP, stdio MCP, and GitHub
repository metadata. Runtime behavior in HTTP/MCP was scripted and explicitly
marked simulated. No live agent/provider/Linear/OpenViking/GitHub PR connector was
used during implementation verification.

## 6. Known limitations and risks

- HTTP/MCP remain unauthenticated and must stay local.
- Atomic/Codex/Claude/Prime/Hermes adapters are mocks; Atomic host peers are not
  pinned or live-tested.
- Worktree/directory leases are not an external sandbox; heartbeat renewal/fencing,
  container policy, artifact export, secret scanning, and cleanup remain.
- The outbox has no dispatcher/retention job; idempotency expiry has no cleanup.
- Approval state changes are storage-idempotent, but multiple service processes can
  still race to deliver the same resolution to a future real runtime. Require a
  durable command claim or adapter idempotency keyed by approval ID before enabling
  any real runtime or final action.
- Memory promotion is not atomic across Markdown and database state.
- PostgreSQL production roles, TLS, backups, observability, and retention are
  deployment work.
- The architecture DOCX has the recorded page-layout defects.

## 7. Manual setup still required

- `npm ci` and PostgreSQL 16 CLI tools for full verification.
- A dedicated PostgreSQL database plus separate migration/runtime roles, TLS, and
  backup policy before persistent use.
- Authentication/authorization before any non-local HTTP or MCP exposure.
- Exact Atomic/peer version pin and disposable contract test before enabling the
  future adapter.
- Credentials only when a later milestone deliberately exercises a connector.

## 8. Decisions for Wesley

- Accept/amend ADR-P001 transaction, migration, idempotency, outbox, and ownership
  semantics.
- Reconcile Atomic addendum A-01 through A-07 via ADR-P002.
- Select the future authentication boundary and production PostgreSQL role model.
- Public repository visibility is already decided and recorded; the nested license
  remains unchanged.

## 9. Exact next commands

```bash
git status --short
npm ci
npm run verify
sed -n '1,260p' docs/NEXT_SESSION_PROMPT.md
```

For a disposable persistent PostgreSQL trial, follow `docs/STORAGE.md`; do not copy
placeholder credentials into committed files.

## 10. Next-session prompt

Copy the fenced prompt in `docs/NEXT_SESSION_PROMPT.md`. The next bounded milestone
is the disabled-by-default Atomic JSONL adapter with a deterministic fake process;
do not begin the real workspace milestone until those contracts are green.
