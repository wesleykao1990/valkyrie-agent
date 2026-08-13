# Milestone 6 direct-runtime comparison plan

Date: 2026-08-13
Status: complete for the fixed default-off live comparison; both candidate approvals remain pending and no default runtime is selected

## Objective

Compare the live-verified Atomic model pilot with a direct Codex root candidate
using the same literal disposable task, exact fixture commit, model, deterministic
checks, fresh-verifier rubric, writer isolation, budgets, governed evidence, and
final-action boundary. Preserve a distinct default-off Claude Code candidate, but
do not claim its subscription path until that authentication boundary is actually
exercised.

The comparison is evidence for a later routing decision. It does not make Atomic,
Codex, or Claude the default and does not authorize a PR, merge, deployment,
external/product database write, expanded secret access, or memory promotion.

## Existing contracts and gaps

- `AtomicModelPilotLifecycleCoordinator` is the accepted M5b candidate lifecycle.
- `WriterSandboxBoundary` already owns one isolated worktree/container/fenced
  writer lease and governed export/cleanup.
- `CodexSubscriptionInferenceUpstream` already keeps the dedicated ChatGPT
  subscription profile outside the writer and records native token usage.
- `ControlPlaneService.compareRuns` currently fans out mock workflows only. It
  has no durable comparison aggregate, fair fixed contract, or real metrics.
- `DirectCliRuntimeAdapter` is a read-only marker probe and is not a writer or
  comparison runtime.
- Claude Code has a hardened API-key-only connectivity adapter, but no verified
  subscription-backed writer boundary.

## Proposed implementation

1. Add a narrow `DirectModelPilotCoordinator` for the fixed fixture. Direct Codex
   is the root runtime; it must not invoke or wrap Atomic.
2. Use the same reviewed fixture project/task/objective and exact base commit as
   M5b, but allocate a different worktree, container, writer owner, and lease.
3. Issue a run-scoped inference capability from the existing host-side broker.
   The writer receives no provider token, Codex home, browser/keychain state, or
   Docker socket. The direct coordinator calls only the scoped broker.
4. Run one bounded implementer turn, apply only the returned complete target-file
   bytes through a fixed internal container command, run the same deterministic
   checks, then run a fresh isolated verifier turn. Permit at most one repair and
   rerun both checks and a new final verifier.
5. Export an exact direct-candidate manifest: evidence, patch, initial/final
   checks, initial/final verifier, proposed memory, safe draft-PR mock, context
   pack, and run contract. Rehash frozen exports before approval.
6. Reuse the M5b evidence-bound operator-intended approval semantics. Approval
   records only a safe mock receipt; denial/request-changes are terminal; expiry,
   cancellation, restart, and cleanup fail closed.
7. Add durable comparison and candidate records with a typed metrics snapshot.
   Metrics cover correctness, defects caught, input/output tokens, reported cost,
   elapsed time, human-review artifact burden, event/recovery evidence,
   resumability, and integration complexity. Candidate artifacts and approval
   digests remain the underlying authority.
8. Add a separately flagged Claude candidate configuration that validates its
   exact auth mode and otherwise reports unavailable. It must never silently fall
   back to Codex or inherit the Codex subscription profile.

## Storage and migration

Migration 009 will add comparison aggregates and candidate links/metrics for both
SQLite and PostgreSQL. Creation, candidate attachment, metric finalization, and
idempotent replay use the common store contract. The migration is forward-only
and checksummed. Rollback requires a pre-v9 database backup or a separate older
SQLite dataset; a code-only downgrade must fail closed on the unknown schema.

## Feature flags and setup

- Direct Codex comparison is default-off and requires the already reviewed M5b
  fixture, runner, accepted image/package digests, internal network, dedicated
  authenticated Codex profile, exact CLI version/model, and disabled demo reset.
- Claude comparison remains default-off and unavailable until an explicit
  Anthropic API-key file or a separately reviewed subscription boundary exists.
- Normal `npm run verify` strips every live comparison/provider variable and uses
  deterministic fakes only.

## Security and failure behavior

- The browser/Hermes surface selects only the fixed comparison contract; it
  cannot supply repository paths, commands, images, sockets, credentials, or
  artifact manifests.
- A candidate owns exactly one root runtime and one independent writer worktree.
- Prompt/model output is bounded and schema-validated. Only the exact target file
  may be changed; tests and context are immutable.
- Provider usage, native records, checks, verifier output, export hashes, cleanup,
  and approval bindings are persisted before a candidate can become selectable.
- Any ambiguous execution, lease, artifact, persistence, or cleanup state is
  quarantined or failed; it is never converted into a passing metric.
- Subscription dollar cost remains zero/unknown, not claimed as free API usage.

## Verification

Required deterministic tests include:

- exact task/objective/runtime/workflow gates and idempotent retries;
- independent worktree/container/lease ownership between Atomic and direct runs;
- implementer schema, fixed write scope, deterministic checks, fresh verifier,
  bounded repair, output/time/token/request/concurrency limits;
- raw broker evidence, usage accounting, artifact tamper, secret scan, cleanup,
  cancellation, restart, and approval expiry/replay;
- durable comparison creation/finalization and SQLite/PostgreSQL parity;
- Claude disabled/auth-missing fail-closed behavior;
- existing M1-M5 tests and demo behavior remain green.

Live evidence is opt-in. The first live comparison will use the existing dedicated
ChatGPT subscription profile for direct Codex and will stop at the candidate's
separate approval gate. Claude live evidence is a later, separately credentialed
exercise.

The live command is `npm run smoke:m6-comparison`. It can attach a supplied exact
M5b Atomic run through `VALKYRIE_M6_ATOMIC_RUN_ID`, or create a fresh Atomic
candidate when that variable is absent. In either case it creates a fresh direct
Codex candidate, reopens four governed artifacts, persists an immutable comparison
snapshot, and leaves both approval gates unresolved. The command sends the fixed
fixture objective, source, immutable test, candidate output, checks, and verifier
prompts to the external ChatGPT subscription service; it therefore requires an
explicit operator acknowledgment of that data flow.

## Routing and efficiency follow-up

The fixed comparison demonstrates that the tested tiny edit belongs on the
Direct path; it does not establish Atomic's overhead for all work. The Atomic
candidate's eight requests were amplified by a stateless subscription bridge that
opened a fresh Codex thread and replayed the large context for each scoped tool
call. Before a representative follow-up:

- keep one persistent provider session per Atomic stage;
- use forked continuation for implementer repair and fresh context only for a
  genuinely independent reviewer;
- pass artifact paths and deltas instead of full transcripts/contracts;
- keep tests, lint, schemas, hashes, and exact-output checks model-free;
- skip a final reviewer when no changed evidence creates a new failure surface;
- compare Direct, Atomic Lite, and Atomic Full with identical model/provider/cache
  posture and report request count plus cached and uncached tokens.

ADR-P009 proposes that Hermes submit the literal request and an optional
preference while the control plane owns the explainable, policy-enforced shape
decision. The current fixed pilots do not yet implement arbitrary live routing.

## Recorded live result

Wesley explicitly approved the fixed external payload and the live smoke passed
on 13 August 2026. Comparison `compare_493a626ad2e583bff275ffc343bb495e`
contains Atomic run `run_2592e612-7f6d-46ab-bf7d-b786de72e62f` and direct Codex
run `run_ee9b00bd-52af-4006-bd81-a00c9b6aa5b2`. Both passed the deterministic
checks and fresh verifier without repair, produced 11 governed artifacts, and
cleaned their independent writer boundaries. Atomic used 134,670 input/934 output
tokens in 83,188 ms; direct Codex used 34,933 input/349 output tokens in 27,267
ms. Subscription dollar cost remains unknown/recorded as zero. Both approvals
remain pending. See `docs/VERIFICATION.md` for exact IDs, limitations, and hashes.
