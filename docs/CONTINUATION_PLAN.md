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

Do not reinterpret either offline discovery or the credential-free M5a tool-only
workflow as a live Atomic model workflow. The external sandbox now exists, but a
model path still requires scoped inference access. Pin and exercise only the exact
capabilities supported by that installed Atomic version: model start/status/event cursoring, steering or
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

## Milestone 5 — End-to-end Atomic pilot: model slice live through approval gate

### M5a — credential-free native integration slice

The default-off `atomic-fixture-pilot` now composes the hard lifecycle boundaries
for one disposable, non-production fixture:

authenticated Hermes-compatible MCP request → stable fixed task/run → isolated
fake Linear projection → bounded accepted Project Brain pack → M4 private
worktree/fenced no-network container → real Atomic 0.9.12 main session and native
tool-only workflow → reviewed fixture implementation → deterministic checks →
fresh deterministic verifier → frozen/secret-scanned checksummed evidence →
container/worktree/lease cleanup → evidence/policy/expiry-bound,
operator-intended approval gate → safe mock receipt, while the evidence-derived
memory proposal remains unpromoted.

The fixed workflow has one turn, zero repair rounds, one concurrency slot, zero
child depth, and hard command/workflow/output/cost limits. Every raw Atomic record
is retained alongside normalized lifecycle events. The approval is exposed through
a narrow MCP mutation that cannot create a PR or promote memory. The feature flag
is false by default and the zero-service SQLite/mock demo is unchanged.
The live smoke exercised approval automatically after its assertions; this does
not attest human presence or judgment.

This is valid integration evidence, not model-quality evidence. No provider/model
request, model-based verifier, token/cost, real GitHub PR, merge, deploy, Linear
write, expanded secret access, or canonical promotion is implemented. Native
cross-process resume remains false.

### M5b — model-backed pilot: subscription live evidence complete through gate

The fixed scoped inference gateway, role capabilities, model workflow, fresh
verifiers, one-repair path, authenticated service/Hermes lifecycle, restart,
artifact review, approval, and SQLite/PostgreSQL parity are implemented
default-off. Normal verification is credential-free and cannot claim model
quality. A pinned host-side Codex broker uses a dedicated ChatGPT subscription
profile without exporting OAuth material or mounting it in the writer; the
OpenAI-compatible API path remains available. Migration 008 supplies the bounded
multi-turn request ledger needed for Atomic custom-tool conversations. The live
fixed fixture completed real implementer and fresh-verifier turns, passed the
deterministic checks, exported and rehashed 11 governed artifacts, cleaned all
writer resources, and stopped at its evidence-bound approval. Wesley's separate
decision remains pending. Atomic still owns its graph, and real draft PR creation
remains a separate final action.

## Milestone 6 — Direct Codex/Claude comparison

M6 is deterministic- and live-verified, default-off. A direct Codex
root candidate uses the exact M5b fixture contract and model policy through its
own worktree/container/fenced lease/capability/artifacts/approval, without invoking
Atomic. Migration 009 persists an evidence-derived comparison aggregate and
candidate metrics for correctness, repairs, token/cost/elapsed usage, review
burden, events/recovery, resumability, and integration complexity. Raw Codex JSONL
is retained alongside normalized inference events. Claude Code remains separately
unavailable rather than falling back to Codex.

Wesley approved the fixed external payload and the opt-in smoke completed with
both candidates correct, independently cleaned, and stopped at unresolved
approvals. Atomic used more elapsed time/tokens on this fixture; that one result
does not establish general quality, recovery, human-review burden, or a permanent
default.

Post-M6 routing uses the proposed Direct / Atomic Lite / Atomic Full rubric in
ADR-P009. The authenticated assessment ledger and reusable package-local Atomic
Lite contract now exist, and the subscription broker retains one process-local
provider thread per capability/role with appended-message continuation. Forked
repair, artifact/delta handoff, model-free deterministic gates, and conditional
review are encoded in the Lite contract. M7 can now supply revision-bound
Linear/Git authority and an accepted project execution policy, but general launch
remains fail-closed until a separate reviewed launcher consumes that evidence.
The next benchmark must hold model/provider/cache/task/checks constant and include
a task large or risky enough for workflow structure to have a measurable
opportunity to help.

## Milestone 7 — Production connectors

Status: deterministic implementation complete, default-off; live Linear/GitHub
credential exercise pending.

- [x] authenticated least-privilege control-plane HTTP/MCP operations with a
  separate default Hermes allowlist;
- [x] Linear reads plus idempotent issue/idea/evidence writes without depending
  on preview AgentSession APIs or mirroring the roadmap;
- [x] deterministic local Project Brain context packs first;
- [x] read-only OpenViking candidate provider and retrieval/isolation/staleness/deletion/
  latency/token evaluation;
- [x] GitHub draft PR creation only after exact approval/evidence gates and from
  a pre-existing remote head;
- [x] concise Linear evidence updates without comment flooding;
- [x] approval-bound external-action outbox dispatcher, retention, observability, dead-letter replay,
  ambiguous-effect reconciliation, and recovery runbook.

General project execution launch, branch publication, merge/deploy, multi-user
actor attestation, a live OpenViking transport, and live connector evidence are
separate remaining gates.

## Milestone 8 — Unified harness and managed capability plane

### M8a — managed skill-suite foundation

- [x] exact local source and policy digest admission;
- [x] bounded `SKILL.md` discovery and declared-capability classification;
- [x] one suite-level project/runtime/trust policy so Wesley does not manually
  map each skill to every harness;
- [x] private content-addressed generations, rehash-on-use, compatible/manual
  update posture, capability-expansion quarantine, activation, and rollback;
- [x] immutable project/runtime/skill capability packs for future runtime
  composition;
- [x] authenticated, read-only, path-opaque HTTP/Hermes status;
- [x] no execution of setup, hooks, binaries, dependencies, updates, MCP servers,
  or skills during admission.

### Remaining M8 work before web capability enablement

- [ ] prove one exact native projection/setup adapter for Codex and Claude Code;
- [ ] compose Atomic through a compatible delegated specialist without building
  another workflow engine above Atomic;
- [ ] make the reviewed general launcher consume and record capability packs;
- [ ] add a broker for public web/search/browser access, bounded egress, evidence,
  and audit without exposing raw network tooling to Hermes;
- [ ] exercise one real suite such as GStack end to end, including upstream
  behavior, updates, rollback, and final-action separation.

Remote fetch, dependency installation, signed publisher provenance, unattended
updates, shared/mobile actor authorization, GBrain, personal memory, and external
knowledge ingestion remain later reviewed slices.

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
