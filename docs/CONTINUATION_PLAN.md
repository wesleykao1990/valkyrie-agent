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

## Milestone 3a — Minimum native connectivity slice: implemented and verified

The disabled-by-default pilot now has:

- strict bounded LF-delimited JSONL and deterministic fake Atomic/direct-runtime
  subprocesses with adversarial framing/exit/cancel tests;
- pinned Atomic 0.9.12 offline RPC/package discovery as one Atomic root/main
  session, with no model execution;
- schema-validated launch manifest containing the literal request, IDs, bounded
  context-pack/run-contract references, budget, final-action boundary, workspace,
  writer lease, and provenance;
- raw native occurrence retention before normalized events, stable native IDs,
  cursor/result artifacts, and conservative restart reconciliation;
- exact-version, read-only direct Codex/Claude connectivity adapters with
  marker-only objectives and no internal Atomic orchestration;
- authenticated loopback HTTP/MCP, runtime preflight, restricted Hermes profile,
  and governed Project Brain search/proposal/preview/rejection;
- `crossProcessResume=false` and unverified capabilities advertised false.

`smoke:native` is opt-in and separates implementation evidence from integrations
actually available/exercised on the host. ADR-P003 remains proposed.

## Milestone 3b — Atomic model workflow and native capability mapping: deferred

Do not reinterpret offline discovery as a live Atomic model workflow. After an
external sandbox exists, pin and exercise only the exact capabilities supported
by that installed Atomic version: model start/status/event cursoring, steering or
follow-up, pause/resume/quit/cancel, HIL input/approval mapping, artifacts,
cost/model metadata, and native durability. Atomic's main session must retain
ownership of its workflow; Codex/Claude must not orchestrate its stages.

Keep `crossProcessResume=false` until runner startup positively proves the native
DBOS/PostgreSQL durability contract through a process-kill/restart test.

## Milestone 4 — Real workspace boundary

Status: complete for the disabled local non-production boundary. Colima/Docker
passed the opt-in live provider smoke with an immutable ARM64 Alpine image, and
migration 005 plus exact-label provider reconciliation cover restart/orphan
states. Writer runtime registration remains a separate Milestone 5 action.

- [x] Private shallow Git store plus one relative worktree per fixture candidate;
  no developer checkout/shared Git directory and no duplicate Atomic top-level
  worktree.
- [x] Writer-lease owner, monotonic fencing token, heartbeat, renewal, expiry,
  exact-fence release, and durable quarantine/reconciliation evidence.
- [x] Disabled Docker-compatible provider with one container per fixture, exact
  ownership labels, digest-pinned image, default no-network policy, read-only
  root/context, non-root user, built-in seccomp, privilege/resource bounds, and
  bounded cleanup.
- [x] Explicit artifact manifest, path/type/size bounds, baseline secret scan,
  atomic idempotent registration, opaque references, terminal cleanup, and
  quarantine behavior.
- [x] Deterministic fake-engine/workspace/lease/artifact/coordinator tests.
- [x] Opt-in provider smoke passes against local Colima/Docker and the reviewed
  immutable `alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`
  ARM64 fixture image.
- [x] Durable sandbox-instance lifecycle state and provider-aware restart/orphan
  reconciliation by immutable engine ID and exact ownership/policy labels.
- [x] Caller-supplied context staging is separate, read-only in the container,
  bounded/checksummed before execution, and rechecked before export.
- [ ] Remote micro-VM or equivalent stronger isolation for confidential/high-risk
  work; scoped model egress and short-lived credential broker.

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
