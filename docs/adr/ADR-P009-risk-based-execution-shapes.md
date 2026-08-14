# ADR-P009: risk-based engineering execution shapes

Status: proposed

## Context

The fixed M6 comparison used the same small disposable edit for Atomic and direct
Codex. Both candidates were correct, but Atomic used eight stateless subscription
requests and 134,670 input tokens versus three requests and 34,933 input tokens
for direct Codex. The Atomic path also took 83.2 seconds versus 27.3 seconds.

That result is evidence about the tested Valkyrie workflow and broker, not a
universal Atomic tax. Atomic 0.9.12 supports direct chat, one-stage workflows,
model-free durable tool nodes, retained stage sessions, and forked continuation.
Its own guidance reserves workflows for work whose stages, proof, retries,
resumability, or gates justify their cost.

Hermes sees the natural-language request first, but it does not own runtime
policy, current Linear/Git/Project Brain truth, writer isolation, budgets, or
final-action authorization. Letting its model silently choose a runtime would
make routing non-repeatable and allow prompt wording to weaken safety policy.

## Proposed decision

1. Use three engineering execution shapes:

   - **Direct** — one Codex or Claude Code root session, deterministic checks, and
     no model reviewer unless risk or failed evidence justifies one.
   - **Atomic Lite** — one persistent Atomic implementer stage, model-free
     deterministic checks, forked repair continuity when needed, and at most one
     fresh verifier when the rubric requires it.
   - **Atomic Full** — an explicit multi-stage graph for independent research or
     candidates, fresh reviewers, bounded repair/reducer logic, durable evidence,
     resumability, and approval gates.

2. Hermes submits the literal request, resolved project/task identity, optional
   latency/rigor preference, and any user-authorized final action. It may explain
   or recommend a shape, but the control plane makes the authoritative decision
   after resolving current domain authorities.
3. Score Structure, Verifiability, Iteration, Risk, Duration, and Isolation from
   zero to two. Scores 0–3 select Direct; 4–6 select Atomic Lite; 7+ select Atomic
   Full. Iteration=2, Risk=2, or any explicit loop, durable/background request,
   evidence/approval gate, or multiple-candidate request selects Atomic Full.
4. A caller preference may increase rigor but cannot reduce the policy-selected
   shape. `direct:` is a latency preference, not permission to bypass isolation,
   deterministic checks, approval, or another hard gate.
5. Persist the selected shape, score, dimensions, hard signals, preference,
   final-action intent, source provenance/digest, policy version, and
   human-readable reasons before any run contract. A runtime start must fail
   closed when the chosen shape has no verified implementation.
6. Preserve one root runtime per run. Atomic Lite is still an Atomic root run;
   direct Codex/Claude is not an Atomic stage. Hermes never drives Atomic's
   internal graph node by node.
7. Optimize every Atomic graph before adding model calls:

   - retain one stage session and use forked continuation for repairs;
   - pass artifact paths and deltas instead of replaying the full contract;
   - implement tests, lint, schemas, hashes, and exact-output checks as model-free
     tool nodes;
   - add fresh reviewers only for a distinct failure surface;
   - do not rerun an unchanged final reviewer merely for ceremony;
   - bound retries, fallbacks, concurrency, elapsed time, and provider requests.

## Current implementation boundary

`recommendEngineeringExecution()` and the control-plane-owned context classifier
implement the deterministic rubric. Authenticated HTTP/MCP assessment operations
now persist the literal request, project/task binding, source freshness,
dimensions, hard signals, upward-only preference, final-action intent, decision,
reasons, policy version, and TTL under migration 010. Hermes cannot send scores.

The assessment deliberately reports execution unsupported and creates no run,
workspace, lease, or container because current Linear data is a prototype
projection, Git authority is not connected, and no trusted general project
execution policy exists. There is no general launch endpoint and fixed M5/M6
pilots are never substituted.

The Atomic package now includes an independently testable `atomic-lite-writer`
contract with one retained implementer stage, model-free checks, at most one
forked repair, and policy-conditional fresh review. It remains package-local and
unregistered until a reviewed general project launcher consumes and revalidates
current authority. M7 can supply a narrow revision-bound authority path but does
not itself authorize launch.

Migration 011 and the subscription broker retain one live Codex provider thread
per capability/role and send only appended conversation deltas. Different roles
remain isolated. The durable thread ID is audit evidence only: a replacement
process refuses continuation and `crossProcessResume=false` remains truthful.

The next representative benchmark should compare Direct, Atomic Lite, and Atomic
Full with the same provider/model, immutable task contract, cache posture,
workspace policy, deterministic checks, and approval boundary. It must report
provider request count, cached/uncached tokens, defects caught, repair behavior,
elapsed time, recovery, and human-review burden—not completion time alone.

## Consequences

Small tasks avoid unnecessary workflow ceremony, while high-consequence tasks
cannot opt out of evidence because of casual wording. Atomic is evaluated where
its durable structure can create value, and routing remains inspectable rather
than an unrecorded Hermes-model judgment.

This policy adds a third execution profile. The assessment and package workflow
contracts now exist, but arbitrary live work still requires M7's live Linear/Git
context and an accepted project execution policy. Until those exist, the control
plane reports the route as unsupported rather than silently substituting a fixed
pilot.
