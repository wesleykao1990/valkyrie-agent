# Continuation plan

Version: 0.3.0
Sequence authority: `Wesley_Project_OS_Continuation_Bundle_v0.3.0`

The original `0.2.2` repository called Linear projection “Milestone 2.” The
continuation bundle reserves Milestone 2 for Atomic package integration. This
document follows the bundle sequence; the older numbering is historical only.

Complete and verify one milestone before beginning the next.

## Milestone 0 — Inventory and plan: complete

- Mapped storage, runtime adapter, Project Brain, workspace, HTTP, and MCP
  contracts.
- Identified mock-only paths and reviewed the disconnected Atomic RPC scaffold.
- Compared whole-system decisions with the Atomic package.
- Recorded implementation, migration, rollback, security, test, and flag plans in
  `docs/IMPLEMENTATION_PLAN_M1_M2.md`.
- Recorded evidence-backed challenges in `docs/REVIEW_NOTES_v0.3.0.md`.

## Milestone 1 — PostgreSQL storage: complete

- Async `ControlPlaneStore` with SQLite and PostgreSQL adapters.
- Explicit checksummed migrations and PostgreSQL advisory migration lock.
- Transactional run/workspace/lease creation, event append, approval resolution,
  and outbox state.
- Stable run idempotency, event replay, approval conflict handling, and worker
  claims.
- Startup/restart reconciliation with conservative native-runtime behavior.
- Shared SQLite/PostgreSQL evidence for migrations, rollback, concurrency,
  outbox, idempotency, restart, and reconciliation.

Operational setup and limitations are in `docs/STORAGE.md`. ADR-P001 remains
proposed until Wesley accepts or amends its semantics.

## Milestone 2 — Atomic package integration: complete (non-live)

- Imported and versioned at `packages/atomic-workflow-architect/`.
- Skill, router, prompts, workflows, launch template/schema, and package verifier
  remain independently runnable.
- Package-local bootstrap files stay lightweight.
- Provenance, derived changes, compatibility caveat, and nested license are
  recorded in `docs/ATOMIC_PACKAGE_PROVENANCE.md`.
- No extension was installed and no runtime was enabled.

ADR-P002 and the Atomic A-01 through A-07 addendum remain proposed for explicit
whole-system reconciliation.

## Milestone 3 — Real Atomic adapter: next

Implement behind a disabled-by-default feature flag. Do not enable live execution
until exact host versions are pinned and contract-tested.

Required outcomes:

- strict LF-delimited JSONL RPC boundary and deterministic fake subprocess;
- launch-manifest schema validation with stable control-plane/native IDs;
- exact task/request, context-pack reference, budget, final-action boundary,
  workspace owner, and writer-lease contract;
- raw native event retention alongside normalized events and cursor state;
- only positively verified start/status/event/steer/pause/resume/cancel/input/
  artifact/cost/durability capabilities;
- one Atomic main session per Atomic root run;
- `crossProcessResume=false` unless runner startup proves native DBOS/PostgreSQL
  durability for the installed version;
- opt-in live tests only when Atomic and disposable credentials are present.

Atomic's main session owns its native workflow. Codex/Claude must not orchestrate
Atomic's internal stages.

## Milestone 4 — Real workspace boundary

- One Git worktree per writing candidate and no duplicate Atomic top-level
  worktree.
- Writer-lease heartbeat, renewal/fencing, expiry, and orphan reconciliation.
- External container/devcontainer or VM for every real writer.
- No production credentials; scoped filesystem/network policy.
- Artifact export, secret scanning, terminal cleanup, and quarantine evidence.

## Milestone 5 — End-to-end Atomic pilot

Run one medium-risk, non-production fixture with deterministic acceptance criteria:

Hermes-compatible MCP request → stable run/task → current/fake Linear context →
bounded Project Brain pack → isolated workspace/container → Atomic preflight and
contract → implementation → deterministic checks → fresh verifier → bounded
repair → human approval → safe draft-PR mock or gated draft PR → evidence → memory
proposal without automatic promotion.

Bound repair rounds, cost, time, turns, concurrency, and child depth. Preserve the
literal task contract, use implementer continuity for repairs, fresh contexts for
independent reviewers, and artifacts rather than full transcripts.

## Milestone 6 — Direct Codex/Claude comparison

Preserve a direct candidate under the same task contract, workspace policy,
checks, budgets, verifier rubric, and approval boundary. Never share a worktree
with Atomic. Compare correctness, caught defects, cost, elapsed time, human review,
event/recovery reliability, resumability, and integration complexity. Atomic does
not become the permanent default without evidence.

## Milestone 7 — Production connectors

Only after storage/runtime/workspace paths are stable:

- authenticated least-privilege Hermes/control-plane MCP;
- live Linear reads plus idempotent issue/idea/evidence writes without depending
  on preview AgentSession APIs or mirroring the roadmap;
- deterministic local Project Brain context packs first;
- read-only OpenViking provider flag and retrieval/isolation/staleness/deletion/
  latency/token evaluation;
- GitHub draft PR creation only after exact approval/evidence gates;
- concise Linear milestone updates without comment flooding;
- external outbox dispatcher, retention, observability, and recovery runbooks.

## Required method for every milestone

1. Update a short implementation plan.
2. Add tests before or alongside code.
3. Use small reviewable commits.
4. Run narrow checks, then `npm run verify`.
5. Use a fresh reviewer that did not author the implementation.
6. Repair only evidence-backed findings and cap repair rounds.
7. Update setup, migrations, rollback/failure behavior, environment examples, and
   security assumptions.
8. Record architecture changes as proposed ADRs; do not silently rewrite accepted
   decisions.
