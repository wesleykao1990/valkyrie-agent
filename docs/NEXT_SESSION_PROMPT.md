# Continuation prompt — Milestone 5 disposable Atomic pilot

Continue the existing public `valkyrie-agent` repository. Do not create a new
repository, substitute another agent framework, or redesign the accepted
architecture.

## Read and verify first

Read, in order:

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
12. `docs/SESSION_HANDOFF_v0.3.0.md`
13. `docs/IMPLEMENTATION_PLAN_M4.md`
14. `docs/adr/ADR-P004-external-writer-boundary.md`

For Atomic-specific work, then read the package `START_HERE.md`, complete
`SKILL.md`, `CONTROL_PLANE_INTEGRATION.md`, `CODEX_CLAUDE_HANDOFF.md`,
`INSTALLATION_AND_OPERATIONS.md`, `ATOMIC_EXPERT_RESEARCH.md`, and
`VIDEO_MASTERCLASS_FINDINGS.md` in their documented order.

Run `npm run verify` before editing and record the exact baseline. The normal
suite deliberately strips live OCI variables. Reproduce the explicit live
Milestone 4 smoke only with the exact local engine, socket, private root, and
immutable Alpine digest recorded in `docs/VERIFICATION.md`.

## Existing verified boundary

Milestones 0–4 are complete for the local non-production posture. Milestone 4
provides a disabled, live-verified Colima/Docker boundary with private per-run Git
roots/worktrees, fenced writer leases and heartbeat, checksummed read-only context,
durable sandbox lifecycle/restart reconciliation, governed artifact export,
baseline secret scanning, and exact owned cleanup. It is intentionally not
registered through HTTP, MCP, or any model runtime.

Atomic `0.9.12` is pinned and its LF-JSONL transport/package discovery are
contract-tested. The current Atomic live evidence is credential-free discovery,
not a model workflow. Public RPC does not expose a verified detached-workflow HIL
answer operation, and Atomic native cross-process durability is still false.

## Mission — Milestone 5

Implement one end-to-end, medium-risk, non-production Atomic writer pilot against
a disposable fixture repository with literal deterministic acceptance criteria:

Hermes-compatible authenticated MCP request
→ stable task/run ID and fake/current project context
→ bounded accepted Project Brain pack
→ existing Milestone 4 worktree/container/fence
→ Atomic preflight and exact launch manifest
→ Atomic-owned workflow/model execution
→ deterministic checks
→ fresh-context independent verification
→ bounded repair
→ control-plane human approval
→ safe mock final action or separately approved draft PR
→ checksummed evidence/artifacts
→ governed memory proposal without automatic promotion.

Use a fixture task whose correct result can be proven without LLM judgment. Keep
the entire pilot behind a disabled-by-default feature flag such as
`ATOMIC_WRITER_ENABLED=false`. Do not accept arbitrary repository objectives.

## Required implementation outcomes

1. Compose the existing `WriterSandboxBoundary` into exactly one Atomic root run.
   The control plane owns the top-level workspace, container, lease, and artifact
   boundary; Atomic must not create a duplicate top-level worktree.
2. Generate and schema-validate the exact Atomic launch manifest with request,
   project/task/run IDs, context checksum, workspace/lease owner/fence, budget,
   bounds, final-action boundary, and provenance.
3. Pin and positively verify the selected Atomic provider/model path. Give the
   container only the minimum short-lived credential and scoped network egress
   needed for that provider. Never mount a home directory, Docker socket, general
   credential store, SSH agent, cloud config, or production secret.
4. Keep `crossProcessResume=false` unless a separate Atomic DBOS/PostgreSQL
   kill/restart/resume test positively proves durability at runner startup.
5. Preserve every raw Atomic record before normalized siblings; retain native main
   session, workflow, stage, entry-cursor, model/cost/token, and artifact IDs only
   where the pinned version actually exposes them.
6. Preserve the literal task contract. Use implementer continuity for bounded
   repairs, fresh context for independent verification, artifact handoffs instead
   of full transcripts, and deterministic checks ahead of LLM judgment.
7. Bound cost, elapsed time, turns, repair rounds, concurrency, child depth,
   output, artifact size/count, lease lifetime, and process/container termination.
8. Because detached Atomic HIL answering is not verified over public RPC, keep the
   first pilot's human gate at the control-plane boundary after terminal workflow
   evidence. Do not ask an LLM to relay an approval and do not claim native HIL.
9. Separate implementation acceptance from PR creation. Default to a safe mock
   final action. A GitHub draft PR requires a new exact approval/policy action;
   merge/deploy remain out of scope.
10. Propose concise canonical memory only after evidence. Never auto-promote it.
11. Add deterministic fake-process tests and one opt-in live Atomic fixture test.
    Test SQLite and PostgreSQL lifecycle parity, cancellation, restart/orphan
    behavior, expired/rotated fence, model/API failure, secret finding, failed
    checks, bounded repair exhaustion, approval denial, artifact replay/tamper,
    cleanup failure, and feature-flag-off behavior.
12. Preserve the zero-service SQLite/mock demo and Milestone 3 read-only native
    pilot. Hermes receives only bounded control-plane tools, never raw process,
    Git, container, credential, or filesystem controls.

## Stop/approval boundaries

Stop for Wesley only if the chosen Atomic model path needs a credential/login not
already available, if scoped egress requires a product decision, or before a real
GitHub PR/final action. Do not treat a local container as a production
multi-tenant sandbox; use a reviewed remote micro-VM for confidential/high-risk
work.

## Engineering method and evidence

Update a short Milestone 5 plan and proposed ADR before composition. Add tests
before or alongside code, run narrow checks, then `npm run verify`, then the
explicit live OCI and Atomic fixture smokes. Use a fresh independent review and
repair only evidence-backed findings. Record migrations, rollback, failure and
quarantine behavior, setup, security assumptions, and exact pass/skip evidence.

Return the standard ten-part report: milestone completed, architecture preserved,
files changed, tests/evidence, live integrations actually exercised, limitations,
manual setup, Wesley decisions, exact next commands, and the next copy-paste
continuation prompt.
