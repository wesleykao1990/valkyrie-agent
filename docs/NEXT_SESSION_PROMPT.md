# Continuation prompt — begin Milestone 7 production connectors

Continue the existing public `valkyrie-agent` repository and draft PR #1. Do not
create a new repository, substitute another agent framework, expose a generic
writer, or redesign the accepted architecture.

Read `START_HERE.md`, `AGENTS.md`, `.project-context.yaml`, `CLAUDE.md`,
`docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`,
`docs/CONTINUATION_PLAN.md`, `docs/VERIFICATION.md`,
`docs/SESSION_HANDOFF_v0.3.0.md`, `docs/IMPLEMENTATION_PLAN_M6.md`, and proposed
ADR-P008 and ADR-P009. Also read
`docs/IMPLEMENTATION_PLAN_POST_M6_GAPS.md`. Run `npm run verify` before changing
code.

## Current state

Milestones 0–6 are complete for their documented default-off local scope. The
fixed live M6 comparison is `compare_493a626ad2e583bff275ffc343bb495e`:

- Atomic run `run_2592e612-7f6d-46ab-bf7d-b786de72e62f` and direct Codex run
  `run_ee9b00bd-52af-4006-bd81-a00c9b6aa5b2` both passed the same checks and a
  fresh verifier without repair;
- each used a separate worktree, container, fenced lease, capability, evidence
  set, and approval, and all writer resources were cleaned;
- Atomic used 134,670 input/934 output tokens in 83,188 ms; direct Codex used
  34,933 input/349 output tokens in 27,267 ms; subscription cost is unknown and
  recorded as zero;
- both approvals remain pending, no candidate is accepted, and no default runtime
  is selected; and
- Claude Code remains a separately gated unavailable candidate.

The latest pre-M7 verification recorded in `docs/VERIFICATION.md` reported 264
general tests / 261 passed / 3 honest skips, disposable PostgreSQL storage 22/22
plus M5b lifecycle 7/7, Atomic package verification with 38 required files and 6
workflows, and HTTP/MCP smokes. Rerun it before relying on the count.

ADR-P009 now defines Direct, Atomic Lite, and Atomic Full. Hermes supplies the
literal request and optional preference; the control plane owns the structured
six-dimension decision and hard-signal escalation. The authenticated assessment
surface and migration 010 now persist that decision, but truthfully return
execution unsupported because Linear remains a prototype projection, Git is not
connected, and no accepted project execution policy exists. No general launch
operation is exposed and fixed pilots are never substituted.

The package-local `atomic-lite-writer` contract is independently testable: one
retained implementer, model-free checks, at most one forked repair, and a fresh
reviewer only when policy requires a distinct surface. It is not runtime
registered. Its admitted Git commit/tree/index, descriptor writes, and full
Git-visible worktree gates reject ordinary and committed undeclared mutations;
an external sandbox is still mandatory for a real writer. Migration 011 and the subscription broker now retain one
process-local Codex provider thread per capability/role and send appended message
deltas; different roles remain isolated and restart resume fails closed.

## Milestone 7 objective

Implement production connectors only after a new inventory/plan and one coherent
connector slice at a time:

1. Add least-privilege Linear reads and idempotent issue/idea/evidence writes
   behind a provider interface. Linear remains authoritative; never mirror its
   full roadmap or depend on preview AgentSession APIs. Wesley already has a
   Linear gateway configured for Hermes, but that is not evidence of a
   control-plane connector or credential boundary.
   First replace the assessment's `prototype` Linear and `unavailable` Git source
   labels with revision-bound provider evidence; do not enable assessment launch
   until the selected project also has an accepted repository/check/write policy.
2. Keep deterministic local-Markdown Project Brain retrieval first. Add an
   evaluation harness for cross-project leakage, accepted-decision ranking,
   stale/superseded suppression, deletion, latency, and token cost before any
   OpenViking default. OpenViking remains read-only and feature-flagged.
3. Add GitHub draft-PR creation only after an exact evidence-bound approval,
   secret scan, deterministic checks, and artifact revalidation. PR creation,
   merge, deployment, and memory promotion remain separate actions.
4. Implement the external outbox dispatcher, retry/dead-letter/retention policy,
   operational observability, and recovery runbooks before relying on connector
   writes.
5. Emit concise Linear milestone/evidence updates without flooding issue
   comments. Every mutation must be idempotent and auditable.

Start with read-only inventory of the existing Linear/Hermes setup, connector
interfaces, outbox schema, auth configuration, and tests. Write a short M7 plan
covering files, migrations, rollback, failure behavior, least privilege, feature
flags, deterministic fake gateways, opt-in live tests, and decisions requiring
Wesley. Do not request or copy credentials until the exact connector and minimum
scope are defined. Do not resolve either M6 candidate approval or select a default
runtime as part of M7.
