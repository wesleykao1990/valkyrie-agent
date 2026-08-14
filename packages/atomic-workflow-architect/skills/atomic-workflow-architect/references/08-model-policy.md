# Model Policy by Role

Atomic's model-selection guidance and benchmark snapshots move quickly. This package encodes role policy, not permanent model IDs or transcript anecdotes.

## Role policy

| Role | Selection principle |
|---|---|
| Judgment/reviewer gate | Highest affordable measured accuracy; a wrong verdict wastes the loop |
| Planner/spec | High accuracy when the plan gates costly work; otherwise a strong value model |
| Debugger | Deep reasoning and strong real-world coding performance |
| Research | Long-context reliability, factuality, and reasonable cost |
| Orchestrator/worker | Efficient workhorse with good coding performance |
| Mechanical one-shot | Low-cost capable model plus deterministic checks |
| Design | Quality-first model plus human visual judgment |
| Reviewer B/C | Different provider/model family when it decorrelates error |

## Runtime versus provider terminology

- Atomic stage using an Anthropic model provider ≠ Claude Code CLI run.
- Atomic stage using an OpenAI model provider ≠ Codex CLI/cloud task.
- Use external runtime adapters only when the user/policy wants those native runtimes.
- Record provider, model, reasoning level, and runtime separately.

## Pareto rule

Prefer a model on the current cost/accuracy frontier. Use a dominated or unmeasured model only for an explicit reason:

- provider diversity;
- long-context behavior;
- subscription economics;
- local/private execution;
- design quality;
- workflow-specific eval wins;
- specialized tool/environment access.

## Runtime procedure

1. Query authenticated/available models.
2. Read current Atomic guidance/live benchmarks for costly work.
3. Mark missing benchmark data `unmeasured`.
4. Assign models by role and cost of being wrong.
5. Configure fallback diversity while respecting transcript/privacy policy.
6. Record cost, latency, failures, repair count, verifier outcome, and merge/review burden.
7. Update routing only from measured project outcomes.

Anecdotal stream claims such as merge rate, time saved, or cost per ticket are hypotheses—not policy inputs.
