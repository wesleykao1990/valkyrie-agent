# Architecture and prototype review notes — v0.3.0

Review date: 2026-08-11
Scope: continuation bundle documents, whole-system prototype `0.2.2`, and
Atomic Workflow Architect source `0.2.0`

## Overall assessment

The accepted shape is sound: Hermes is the mobile interface, Linear/Git/accepted
Markdown retain domain authority, the control plane owns cross-system guarantees,
and each task has one root runtime. The codebase is small enough to remain a thin
modular monolith. PostgreSQL and an inert Atomic module fit that shape without
introducing a generic agent framework.

The main risk is not the high-level architecture. It is accidentally presenting
prototype projections as stronger guarantees than they provide. This continuation
therefore makes storage claims testable and labels simulations, while leaving live
runtime, authentication, and sandbox claims disabled.

## Decisions challenged or tightened

1. **Authority cannot be one total precedence list.** Linear, Git/checks, accepted
   Project Brain Markdown, and current user instruction govern different domains.
   Treating them as globally ordered allows a roadmap status to override code truth
   or an implementation artifact to override product rationale. The integrated
   documentation now describes domain-specific authority; ADR-P002 proposes the
   canonical reconciliation.
2. **A writer lease is coordination, not isolation.** The prototype can create a
   directory or optional Git worktree, but neither is a security sandbox. A real
   writing runtime still requires an external container or VM, scoped mounts,
   egress policy, secret handling, heartbeat/fencing, and orphan cleanup. This is
   deliberately deferred rather than simulated.
3. **Mock evidence must say it is mock evidence.** Scripted checks and a scripted
   “fresh verifier” previously looked like real execution evidence. Mock events,
   approval text, artifacts, and memory proposals now carry explicit simulated
   markers. They remain useful lifecycle fixtures, not correctness evidence.
4. **Storage durability does not imply runtime durability.** PostgreSQL can make
   control-plane state transactional and restart-reconcilable; it cannot prove that
   an Atomic/Codex/Claude native session can resume. Unknown native state must be
   surfaced for operator action, and Atomic `crossProcessResume` remains false.
5. **The outbox needs an explicit delivery contract.** Persisting an outbox row is
   useful only if IDs are stable, business state and the row commit together, and a
   later publisher treats delivery as at-least-once. This milestone tests storage
   and retry bookkeeping but does not pretend that a broker or connector publisher
   exists.
6. **Atomic source presence is not Atomic integration at runtime.** The package is
   independently discoverable and verifiable, but the host peers are not pinned and
   no installed Atomic process was contract-tested. It must remain inert until exact
   versions and native capabilities are verified.
7. **The nested license is a real publication boundary.** The repository root is
   MIT, while `packages/atomic-workflow-architect/` is `UNLICENSED` and carries a
   private all-rights-reserved notice. The root license does not supersede that
   notice. Wesley explicitly authorized public repository visibility on
   2026-08-11; that publication does not broaden the nested license.
8. **Milestone numbering needs a mapping, not a silent rewrite.** The original
   repository plan calls Linear “Milestone 2”; the continuation bundle calls Atomic
   package integration “Milestone 2.” Current session documents use the bundle
   numbering and preserve the older sequence as historical context.

## Prototype findings retained as known limitations

- HTTP and MCP mutations are unauthenticated. In particular, canonical-memory
  promotion is exposed by the prototype MCP server even though the recommended
  Hermes allow-list omits it. Do not expose either service on an untrusted network.
- Project Brain promotion writes Markdown before the database records promotion.
  A crash can therefore leave a written note with a still-proposed database row.
  A later milestone needs a staged file/outbox reconciliation design.
- Filesystem preparation necessarily occurs outside a database transaction. Failed
  or raced run creation cleans up an unpersisted prepared workspace, but real Git
  worktree/container cleanup and fencing remain Milestone 4 work.
- PostgreSQL migration `002` adds uniqueness and ownership constraints. Migrating a
  non-disposable database with inconsistent historical rows can fail; operators
  must back up, audit, and repair such data instead of bypassing the constraints.
- The worker claim prevents concurrent advancement while the claim is live, but a
  real long-running adapter needs claim renewal/fencing. The current mock stages are
  short and no real agent is enabled.
- Approval resolution is database-idempotent, but two control-plane processes can
  still observe the resolved row and both invoke a future real adapter. Before any
  real runtime or final action is enabled, add a durable delivery claim/command
  state or adapter-side idempotency keyed by approval ID.
- The outbox has no external publisher or retention job yet. Idempotency and outbox
  payloads may contain operational metadata and need production retention/access
  policy.

## Document quality review

The architecture review DOCX was rendered and inspected as 24 pages. Its content
is coherent with the repository decisions, but the supplied layout has visible
publication defects: page 10 has an orphaned sentence followed by excessive empty
space, and the Appendix C/E headings on pages 22 and 24 are clipped at the left
edge. The source memo is retained unchanged because this session implements the
system milestones rather than revising a signed-off architecture artifact.

## Decisions requested from Wesley

- Accept, amend, or reject proposed ADR-P001 (async store, forward migrations,
  outbox/idempotency semantics, one-workspace/lease invariants).
- Reconcile the imported Atomic A-01 through A-07 addendum into the whole-system
  decision registry via ADR-P002.
- Before a live pilot, choose the authentication boundary and least-privilege
  PostgreSQL runtime/migration roles; these are deployment decisions, not safe
  defaults to infer in this repository.
