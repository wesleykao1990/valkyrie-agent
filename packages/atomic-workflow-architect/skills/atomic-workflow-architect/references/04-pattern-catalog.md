# Workflow Pattern Catalog

Always inspect `/workflow list` and the exact installed input contract before launch. Built-ins and registry packages evolve.

| Pattern | Shape | Use |
|---|---|---|
| classify-and-act | classifier → deterministic branch | mixed request routing |
| fan-out-and-synthesize | partition → parallel artifact branches → synthesis | repository research, independent slices |
| adversarial-verification | worker → fresh verifiers → reducer → repair | prove/reject a candidate |
| generate-and-filter | candidate fan-out → dedupe/rubric → shortlist | ideas, names, hypotheses, approaches |
| tournament | whole attempts → pairwise/panel judges → winner | subjective or approach-sensitive alternatives |
| loop-until-done | ledger → iteration/evaluator → success/bound | explicit convergence condition |
| goal | durable objective ledger → bounded subagents → review/reducer | open-ended but contractable implementation |
| ralph | prompt/spec refinement → research → orchestrate/implement → multi-model review | research-first feature delivery |
| open-claude-design | discovery/reference → artifact → human feedback loop → export | UI/page/component/theme work |
| PR babysitting (when installed) | observe CI/review → repair → rerun → green/bound | draft PR maintenance under explicit merge policy |

## Common custom graph

```text
scope guard / contract
→ research artifact
→ plan/spec artifact
→ implementer (forked continuity)
→ deterministic checks
→ fresh skeptical verifier
→ reducer
→ bounded repair
→ rerun same checks
→ human/final-action gate
→ optional draft PR
```

## Built-in selection

- **Goal:** use when the objective is clear, implementation may be long, and durable tracked progress is valuable.
- **Ralph:** use when research/spec refinement and adversarial multi-model review are central.
- **Adversarial verification:** use to evaluate a candidate/diff independently.
- **Fan-out/synthesize:** use for broad codebase/research uncertainty.
- **Tournament:** use for several complete candidate approaches; isolate writers.
- **Open Claude Design:** use for visual design with human feedback.

Do not force-fit a built-in. Compose a matching child under a custom parent when it solves only one part.

## Pattern selection signals

- Broad codebase uncertainty → fan-out-and-synthesize.
- Independent slices → parallel branches or separate top-level worktrees.
- Plausible-but-wrong contract → adversarial verification.
- Competing architectures → generate/filter or tournament.
- Explicit repeat-until → bounded loop with stable iteration identity.
- Standard non-trivial feature → Goal, Ralph, or task-specific worker/reviewer graph.
- Exact API/build/schema contract → dedicated deterministic gates.
- Mature step-by-step skill/Job → convert to workflow; retain skill as domain context.
- Ad-hoc live handoff → Intercom, but persist repeatable process as a workflow.
