# Milestone 5 end-to-end Atomic pilot plan

Date: 2026-08-12
Status: M5a implementation and live no-model evidence complete. M5b model-backed
acceptance remains deferred.

## Run contract

Objective: compose the pinned Atomic 0.9.12 workflow runtime with the live-
verified Milestone 4 writer boundary for one disposable, non-production fixture,
then stop at a control-plane operator-intended approval gate and safe mock final
action. The automated live smoke may resolve that gate only after all assertions;
it proves the transition, not human presence or judgment.

The first executable slice deliberately separates two claims:

1. **Native integration proof:** a credential-free, tool-only Atomic workflow
   owns its graph, edits the disposable fixture, runs deterministic checks, emits
   native workflow evidence, and exits inside the external container.
2. **Model-backed pilot proof:** Atomic model stages implement and independently
   review the same literal contract through scoped inference access. This claim
   remains false until a real provider request, cost/model metadata, and fresh
   verifier are positively exercised.

The native integration slice is necessary but is not by itself the complete
model-backed Milestone 5 acceptance gate.

## Fixed pilot task

The pilot uses a repository fixture created from committed, reviewed template
content. Hermes can select only the literal `atomic-fixture-pilot` workflow; it
cannot supply a repository path, shell command, image, container, socket,
credential, artifact manifest, or arbitrary workflow source.

The task contract is:

- implement the fixture's missing project-slug normalization behavior;
- preserve the literal input/output examples in its run contract;
- pass the fixture's deterministic Node test suite;
- run an independent verifier from only the contract, candidate files, and check
  artifact;
- permit no repair in this reviewed tool-only slice (a changed/failed fixture must
  fail closed and be retried as a new run);
- prepare evidence, a safe draft-PR mock, and a governed memory proposal;
- stop before any GitHub request, merge, deployment, external/product database mutation, expanded
  credential access, or canonical-memory promotion.

## Required flow

```text
authenticated Hermes-compatible MCP runs_start
  -> stable control-plane run/task and idempotency key
  -> isolated fake Linear projection + bounded Project Brain pack
  -> control-plane-owned strict Git workspace and fenced writer lease
  -> one externally isolated container
  -> one Atomic main RPC session
  -> one native atomic-fixture-pilot workflow run
  -> implementation -> deterministic checks -> independent verifier
  -> zero repair rounds; any mismatch fails closed
  -> raw native + normalized evidence
  -> stop Atomic and container
  -> secret-scanned governed export
  -> remove worktree and release exact fence
  -> evidence-bound governed memory proposal (still advisory)
  -> control-plane operator-intended, evidence-bound approval gate
  -> safe mock acceptance receipt
  -> terminal run; no automatic memory promotion
```

## Architecture changes

1. Add a dedicated `AtomicFixturePilotCoordinator`. It is control-plane-owned and
   composes the strict workspace, writer boundary, OCI provider, and Atomic RPC
   workload. It is not a generic remote-exec service and is not exposed directly
   to Hermes.
2. Extend the writer boundary with a trusted internal workload seam and an
   evidence-ready completion mode. Existing `sandbox-fixture` behavior remains
   unchanged.
3. Add a provider-owned interactive exec transport for Atomic JSONL RPC. It must
   re-inspect the exact run/workspace/owner/fence/policy before spawn, bind its
   lifetime to container stop, bound I/O, and retain only redacted argv evidence.
   The adapter must not construct an unchecked `docker exec` command itself.
4. Add a reviewed package workflow for the disposable fixture. Atomic's main
   session launches the native graph; Codex and Claude Code do not orchestrate
   its stages.
5. Add a default-off pilot configuration with exact fixture, image, engine,
   roots, network, budget, duration, turn, repair, concurrency, and child-depth
   bounds. Normal verification strips every live pilot variable.
6. After evidence export and cleanup, request the exact control-plane action
   `accept_atomic_fixture_result`. Approval records only a safe mock acceptance
   receipt and completes the fixture. `request_changes` ends the cleaned
   candidate and requires a new run; it cannot resurrect a removed workspace.
7. Generate a deterministic memory proposal from accepted evidence. Promotion
   remains a later, separate, preview-bound action and is absent from the pilot
   Hermes allow-list.

## Inference and credential policy

The deterministic native workflow runs with network `none` and no credential.
It proves Atomic/container/workflow/event/artifact/approval composition, not
model performance.

A model-backed run may be enabled only through one of these reviewed paths:

- a local model endpoint reachable without external network or credential; or
- an internal-network inference proxy that holds the provider credential outside
  the writer, issues one run-scoped expiring capability, and enforces provider,
  endpoint, model, request, token, cost, time, and concurrency bounds.

Direct named-network internet egress, a host `~/.atomic`, `~/.codex`,
`~/.claude`, browser/keychain state, raw subscription refresh token, Docker
socket, or long-lived API key must never enter the writer container. The
existing named-network option is not sufficient evidence of destination-scoped
egress.

## Storage and restart behavior

- Persist every validated Atomic stdout record, including responses, before or
  alongside normalization. Native session, workflow, stage, prompt, and entry
  identifiers remain stable evidence.
- Bind approval to the run, project, workflow, exact action, evidence digest,
  policy hash, and expiry. Resolution is transactional with the terminal run
  transition.
- `crossProcessResume` remains false. A restart during an active native writer
  stops/cleans or quarantines it through provider-aware reconciliation and fails
  the run.
- A cleaned evidence-ready run may survive restart awaiting approval without a
  container, workspace, or lease. Reconciliation verifies its immutable evidence
  before retaining that state.
- Workflow durability is not claimed until an external Atomic DBOS/PostgreSQL
  process-kill/restart/resume test passes.

Any new schema migration is forward-only and checksummed. A binary rollback
requires a verified pre-migration backup or a separate compatible SQLite data
set; there is no destructive down migration.

## Tests and evidence

Required deterministic coverage:

- flag-off and unavailable-provider paths create no workspace/container;
- exact fixture/task/objective and Hermes input allow-list;
- idempotent mobile retry launches one run/workflow only;
- launch manifest schema plus real workspace/lease/fence/policy binding;
- strict LF JSONL, raw record order, native IDs, cursoring, and unknown events;
- workflow success, check failure, zero-repair fail-closed behavior, cancellation,
  elapsed/output/budget/turn/concurrency/depth bounds;
- secret detection, artifact tamper, persistence failure, cleanup, quarantine,
  and restart during active execution;
- evidence-ready restart and approval expiry/tamper/concurrency;
- approve, deny, and request-changes semantics with no real PR/final action;
- deterministic memory-proposal replay and no automatic promotion;
- existing mock, connectivity, direct-runtime, SQLite, PostgreSQL, and M4 paths
  remain green.

Opt-in live evidence is separate:

1. build the reviewed linux/arm64 runner containing pinned Node, Atomic 0.9.12,
   Git 2.50.1, Bash, ripgrep, and CA roots. Git 2.48+ is required for the host's
   `extensions.relativeWorktrees`; the first older-Git runner failed honestly and
   is not acceptance evidence;
2. pin its resulting repository digest and record the build inputs/provenance;
3. run the credential-free native workflow in Colima/Docker with network none;
4. run the model-backed variant only after the inference boundary above exists;
5. record exact native IDs, checks, repair count, approval, artifacts, cleanup,
   cost/model metadata, and honest skips/failures.

## Rollback and failure behavior

- The pilot flag defaults false; disabling it preserves the M3 connectivity and
  M4 fixture paths.
- A failed preflight never allocates a writer workspace.
- An active failure stops the exact owned container before export or release.
- Ambiguous ownership, output, artifact, persistence, or cleanup is quarantined;
  the workspace is never automatically reused.
- No external PR or canonical-memory write is part of rollback because neither
  is authorized by this milestone.

## Definition of done

The integration slice is implemented when the real pinned Atomic tool-only
workflow is wired end to end through authenticated MCP, live OCI isolation,
deterministic proof, cleanup, approval, mock receipt, and memory proposal. It is
live-verified only after the separate opt-in smoke records the immutable runner
digest and exact run/native/artifact evidence in `docs/VERIFICATION.md`.

Milestone 5 as a model-backed pilot is complete only when the same path also runs
real model implementation and a fresh independent model verifier through a
scoped inference boundary, with cost/model evidence and no unverified capability
claim.
