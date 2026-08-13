# Post-M6 routing and efficiency gap plan

Date: 2026-08-13
Status: implemented for the assessment, package-contract, and process-local
session-continuity slice; general execution remains fail-closed

## Objective

Close the pre-M7 gaps identified by the M6 comparison without turning a fixed
pilot into a generic writer or claiming current Linear/Git authority that the
control plane does not yet have:

1. accept a literal Hermes engineering request through an authenticated,
   explainable assessment surface;
2. persist the control-plane-owned Direct / Atomic Lite / Atomic Full decision;
3. make a reusable, independently testable Atomic Lite package workflow
   available for a later reviewed launcher; and
4. retain one Codex provider thread per live capability/role so Atomic stage
   turns append deltas instead of replaying the full conversation.

## Changed contracts

- Migration 010 adds immutable engineering-routing assessments, source
  provenance, policy inputs/outputs, final-action intent, TTL, idempotency, and
  outbox evidence in SQLite and PostgreSQL.
- `engineering_assess` and `engineering_assessment_get` are authenticated
  HTTP/MCP operations. Hermes supplies project/task identity, the literal
  request, an optional upward-only preference, and final-action intent. It
  cannot supply rubric scores or hard signals.
- Migration 011 records provider session/thread identity and reuse on each
  inference request and permits only one active request per capability role.
  The subscription broker resumes the exact live process-owned Codex thread
  with only appended messages. A replacement process fails closed because
  `crossProcessResume` remains false.
- The Atomic package contains `atomic-lite-writer`: one fresh implementer,
  workflow-owned deterministic checks, at most one repair forked from the
  implementer session, and a fresh reviewer only when policy requires a
  distinct review surface. Its contract, policy, accepted context, diff, checks,
  review decision, and evidence are bounded and checksummed.

## Deliberate non-goals

- No assessment launches a run. Current Linear data is a prototype projection,
  Git freshness/check policy is unavailable, and no general project execution
  allowlist has been accepted. The assessment is durably marked unsupported and
  creates no run, workspace, lease, container, or fixed-pilot substitution.
- Atomic Lite is package-local and not registered as an HTTP/MCP/runtime writer.
- Provider session continuity is process-local. Durable session IDs are audit
  evidence, not permission to resume after restart.
- This slice does not select a default runtime, re-benchmark the three shapes,
  add Linear/GitHub connectors, create a PR, merge, deploy, or promote memory.

## Security and failure behavior

- Engineering intake returns 403 unless a control-plane bearer is configured,
  even on loopback. The MCP wrapper forwards only to its validated loopback API.
- The literal request is stored in the assessment row but omitted from outbox
  payloads. Storage validates bounds, cross-project task ownership, hashes,
  score totals, final-action intent, policy version, timestamps, and replay.
- One idempotency key with changed input conflicts; concurrent equal requests
  return one durable assessment.
- Each provider lineage is scoped to one capability and role, bounded in count
  and idle lifetime, serialized in-process, and poisoned after an ambiguous
  failure. Different reviewer/repair roles cannot inherit the implementer
  thread. The private Codex profile is never mounted into a writer.
- Atomic Lite accepts no caller command, repository path, credential, or final
  action. Policy allowlists existing readable/writeable files and reviewed
  absolute check executables; native shell/web/MCP/subagent tools are excluded.
  Workflow-owned artifact files are created before any model/check executes and
  later writes use `O_NOFOLLOW` descriptors with path/descriptor identity and
  workspace-containment checks. The complete Git worktree is clean at admission
  and its exact `HEAD`, tree, and index identities are bound. Those identities
  and the complete Git-visible worktree state are re-inspected after
  deterministic checks and before patch evidence; an undeclared change or
  history/index mutation fails the run. These checks narrow the package contract
  but do not turn a worktree into a hostile-process sandbox: a real launcher must
  still supply the accepted external container/VM boundary and one writer lease.

## Tests and verification

Focused coverage includes deterministic routing and escalation, score-injection
rejection, cross-project isolation, assessment idempotency/expiry/no-launch,
authenticated HTTP/MCP schemas, SQLite/PostgreSQL migration and concurrency
parity, one-active-role inference, first-turn/resumed-thread behavior, role
isolation, process-loss refusal, Atomic Lite contract/path/link/output/time
bounds, descriptor/path-swap refusal, committed and uncommitted undeclared-change
detection, real patch evidence, conditional review, and no-op rejection.

Run the narrow checks first, then `npm run verify`. The subscription smoke is
opt-in and performs two bounded external turns to prove that the second uses the
same native thread. It is not part of normal verification.

## Rollback

Migrations 010 and 011 are forward-only and checksummed. A binary that does not
understand schema v11 must fail closed. Rollback requires a verified pre-v10 or
pre-v11 backup, as appropriate, or a separate compatible SQLite data set; there
is no destructive down migration. Disabling or removing the new MCP tools does
not remove retained assessment or inference audit records.
