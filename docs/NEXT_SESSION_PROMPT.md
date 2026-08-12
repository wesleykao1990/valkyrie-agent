# Continuation prompt — compose M5b service lifecycle, then select a provider and run live

Continue the existing public `valkyrie-agent` repository and draft PR #1. Do not
create a new repository, substitute another agent framework, expose a generic
writer, or redesign the accepted architecture.

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
13. `docs/IMPLEMENTATION_PLAN_M5.md`
14. `docs/adr/ADR-P005-atomic-writer-pilot.md`
15. `docs/IMPLEMENTATION_PLAN_M5B_PRELIVE.md`
16. `docs/adr/ADR-P006-scoped-inference-boundary.md`

For Atomic-specific work, then read the package `START_HERE.md`, complete
`SKILL.md`, `CONTROL_PLANE_INTEGRATION.md`, `CODEX_CLAUDE_HANDOFF.md`,
`INSTALLATION_AND_OPERATIONS.md`, `ATOMIC_EXPERT_RESEARCH.md`, and
`VIDEO_MASTERCLASS_FINDINGS.md` in their documented order.

Run `npm run verify` before editing and compare its exact counts with the recorded
M5a result. Verify the live evidence record and immutable runner digest in
`docs/VERIFICATION.md`; reproduce the explicit M5a smoke from `README.md` only if
the local engine/image is available or a boundary change needs new live proof.
Do not replace the recorded IDs with deterministic-test output, and do not hide
or relabel an unresolved reproduction failure as a pass.

## Existing boundary

Milestones 0–4 are complete for the local non-production posture. M5a implements
one default-off, literal `atomic-fixture-pilot` path:

authenticated MCP → fixed project/task/run → bounded accepted Project Brain pack
→ private M4 worktree/fenced no-network container → real Atomic 0.9.12 main
session and native tool-only workflow → reviewed fixture edit → deterministic
checks → fresh deterministic verifier → frozen/secret-scanned checksummed evidence
→ Atomic/container/worktree/lease cleanup → evidence/policy/expiry-bound,
operator-intended approval gate → safe mock receipt → proposed-only memory.

The recorded live smoke resolved that gate automatically after its assertions; it
proved the transition, not human presence or independent human judgment.

M5a has no model/provider credential, no model verifier, zero repair rounds, no
real GitHub/PR/merge/deploy, no canonical promotion, and
`crossProcessResume=false`. It is integration evidence, not model-quality
evidence. Direct Codex and Claude Code remain separate read-only roots and never
orchestrate Atomic's internal workflow.

## Existing pre-live M5b boundary

Migration 007, four role-scoped capability/request accounting, the fixed Atomic
model workflow, final fresh verifier, one-repair path, accepted package/image
bindings, read-only model settings, private Unix gateway, no-secret internal
bridge topology, raw native evidence, revocation, and deterministic fakes are
implemented. Normal verification strips all model-pilot settings and makes no
provider request. The model coordinator remains unregistered so fake evidence
cannot be mistaken for a normal Hermes/live run.

## Mission — finish credential-free lifecycle composition, then exercise M5b live

First register the pre-live model coordinator behind the authenticated service
and restricted Hermes surface with durable admission, cancellation, restart,
capability-expiry maintenance, evidence-bound artifact review/approval, and safe
mock acceptance. Complete those paths with deterministic doubles before asking
for a provider credential. Then choose one provider/model or credential-free
local endpoint and exercise it under the **same disposable fixture contract**.
Do not generalize repository, objective, command, workflow, image, or final-action
selection.

The acceptable inference designs are:

1. a reviewed local model endpoint reachable without external provider credential;
   or
2. an inference proxy outside the writer that holds the provider credential and
   issues a run-scoped expiring capability while enforcing exact provider,
   endpoint, model, request, token, cost, elapsed-time, concurrency, and audit
   policy.

Plain internet egress, a host `~/.atomic`/`~/.codex`/`~/.claude`, browser/keychain
state, raw subscription OAuth, Docker socket, long-lived API key, broad cloud
configuration, or SSH agent inside the writer is not acceptable. Stop for Wesley
before choosing a provider/credential/egress design that is not already approved.

## Required outcomes

1. Keep the control-plane-owned workspace/container/lease/artifact/approval
   boundary and one Atomic root/main session. Atomic owns its native graph,
   implementer stage/checkpoints/repair state; Codex/Claude do not drive it.
2. Extend the exact launch contract with the reviewed inference capability and
   immutable provider/model/policy identifiers without exposing the credential.
3. Preserve the literal task contract and deterministic checks as the primary
   acceptance gate. The model may not rewrite tests or acceptance criteria.
4. Use implementer continuity for at most one evidence-backed repair. Run the
   independent model verifier with fresh context containing only the contract,
   frozen candidate, fixed acceptance tests, deterministic check evidence, and
   bounded handoff artifacts.
5. Preserve every raw Atomic/model record before normalized siblings and retain
   native session/workflow/stage/cursor/model/cost/token IDs only where Atomic
   0.9.12 actually exposes them. Do not synthesize unsupported capabilities.
6. Bound provider/model, cost, tokens, elapsed time, turns, repair rounds,
   concurrency, child depth, output, artifact count/bytes, lease lifetime, and
   termination. Budget exhaustion must stop the writer and fail closed.
7. Keep `crossProcessResume=false` unless a separate real Atomic
   DBOS/PostgreSQL process-kill/restart/resume contract passes at runner startup.
8. Retain post-workflow frozen export rebinding, secret scanning, atomic artifact
   registration, exact cleanup, approval digest/policy/expiry binding, and proposed-
   only memory. Model output cannot bypass those deterministic gates.
9. Keep implementation acceptance separate from PR creation. M5b still defaults
   to the safe mock receipt. A real GitHub draft PR requires a new exact approval/
   policy action and actually exercised connector; merge/deploy remain out of scope.
10. Preserve the zero-service SQLite/mock demo, M3 connectivity, M4 provider, and
    M5a credential-free path. All new model behavior is default off.

## Tests and evidence

Add deterministic proxy/local-model doubles for credential non-disclosure,
destination/model/request scope, expiry/replay, rate/cost/token/timeout enforcement,
malformed/provider failure, model output tamper, deterministic-check failure,
one-repair continuity/exhaustion, verifier independence, cancellation, restart,
secret finding, frozen-export tamper, cleanup/quarantine, approval expiry/denial,
and no external final action. Run SQLite and PostgreSQL lifecycle parity.

Live evidence must make a real model request through the selected scoped boundary
and record exact provider/model, Atomic/native IDs, token/cost, checks, repair
count, verifier, artifacts, approval, cleanup, and proposed-memory state. A fake
model is contract evidence only. Never call an external integration a pass unless
it was actually exercised.

Run narrow checks, then `npm run verify`, then the explicit M4/M5a/M5b live smokes.
Use a fresh reviewer that did not author the implementation. Repair only evidence-
backed findings and cap review/repair rounds.

## Stop and approval boundaries

Stop for Wesley for the inference/provider credential choice, scoped network
policy, remote micro-VM decision, or before any real GitHub PR/final action. Do not
request production secrets, bind the prototype broadly, or silently promote
memory.

Return the standard ten-part report: milestone completed, architecture preserved,
files changed, tests/evidence, live integrations actually exercised, limitations,
manual setup, Wesley decisions, exact next commands, and the next copy-paste
continuation prompt.
