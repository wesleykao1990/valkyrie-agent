# Routing Rubric

## Judge risk and proof before raw effort

Five fast axes, with the worst axis dominating:

| Axis | Low | High |
|---|---|---|
| Blast radius | one file/function | shared APIs, schemas, migrations, packages |
| Uncertainty | exact edit known | location/root cause/requirements unknown |
| Verifiability cost | glance/type check | build + tests + runtime + artifact proof |
| Dependency structure | independent | ordered handoffs where early error propagates |
| Failure cost | reversible | published API, migration, release, user/security impact |

A short contract change can be complex. A large mechanical rename can be simple when deterministic tooling proves it.

A workflow is indicated when at least two are true, or any one is strongly true:

1. Two or more phases with a real handoff.
2. Completion needs proof.
3. Iteration/repair is expected.
4. Failure cost is high.
5. Work may outlive one attention span.
6. Independent candidate paths should be compared.
7. A human/final-action gate must be durable and inspectable.

## Six-dimension score

Score each 0–2:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Structure | one action | few sequential steps | dependencies/parallel slices |
| Verifiability | no objective check | spot-checkable | tests/builds/artifacts/review proof |
| Iteration | one pass | one likely repair | loop until evidence passes |
| Risk | trivial/reversible | scoped multi-file | regression/migration/release/user behavior |
| Duration | seconds/minutes | tens of minutes | background/resumable/multi-hour |
| Isolation | one context | one noisy investigation | clean/adversarial/multiple writer contexts |

Interpretation:

- 0–3: **Direct** — one direct root session plus deterministic checks.
- 4–6, iteration ≤1, no gate: **Atomic Lite** — one retained implementer stage,
  model-free checks, forked repair continuity when needed, and at most one fresh
  reviewer for a distinct failure surface.
- 7+, iteration=2, or verifiability=2 plus review/approval: **Atomic Full** — an
  explicit multi-stage graph with durable evidence and bounded repair/reduction.
- Explicit loop, evidence/approval gate, durable/background request, high risk,
  or candidate tournament: Atomic Full regardless of score.

Hermes may submit a latency/rigor preference, but the control plane owns the
recorded decision after resolving current project/task authority. A preference
may move upward from Direct to Atomic Lite/Full; it cannot move below the rubric
or waive workspace, checks, budget, or final-action policy.

## Model-call discipline

- Retain one provider/session lineage per implementer stage; use forked
  continuation for repair rather than opening an unrelated full-context turn.
- Use fresh context only for an independent reviewer or evaluator.
- Pass artifact paths, hashes, and deltas; do not replay the full contract or
  transcript on every turn.
- Put tests, lint, schemas, hashes, exact-output checks, and deterministic reducers
  in `ctx.tool` or pure TypeScript, not model stages.
- Do not add a final reviewer when no evidence changed and it examines no new
  failure surface.
- Bound model requests, retries, fallbacks, concurrency, time, and tokens. Parallel
  stages reduce wall time but do not reduce total provider work.

## Shape ladder

1. Direct
2. Atomic Lite (or inline + one bounded specialist when Atomic is unavailable)
3. Atomic Full with a named built-in/installed workflow
4. Atomic Full with a task-specific custom workflow
5. Atomic Full with composed/nested workflows

Choose the cheapest shape that covers the whole contract, not the most impressive graph.

## Natural-language cues

- “idea” → read-only decision workflow.
- “project” → blueprint/spec first.
- “build/add/implement” → scoped implementation workflow when non-trivial.
- “fix/debug” → reproduce/prove/repair workflow.
- “compare approaches” → parallel candidates + reducer/tournament.
- “until green”, “overnight”, “background”, “resumable”, “approval”, “evidence” → hard workflow signal.
- `direct:`/`inline:` → bypass unless safety policy requires a gate.
- “quickly” → soft latency preference, not automatic safety bypass.

## Queue rule

Do not serialize a list merely because the user listed it in order. Prove dependencies through shared unmerged APIs, schemas, migrations, branches, generated artifacts, decisions, or approvals.

```text
Independent item → independent top-level run + worktree
Dependent cluster → ordered/composed graph
Independent clusters → parallel bounded wave
Unclear material dependency → one grouped clarification
```
