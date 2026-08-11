# Context Engineering

A workflow is an information-flow system, not a list of prompts.

## Local stage prompt

Use only sections that change behavior:

```text
Role
Goal
Literal success criteria
Constraints / non-goals / compatibility posture
Inputs and artifact references
Tools and permission boundaries
Output schema/artifact
Checks/evidence
Stop and escalation rules
```

Ask for conclusions, commands, observed results, citations, and structured evidence—not hidden reasoning or generic “double-check yourself.”

## Context modes

- `fresh`: independent reviewer, evaluator, judge, reducer, architecture/security audit.
- `fork`: coherent implementation/repair that benefits from its previous work.
- explicit files/artifacts/`reads`: continuity across fresh stages.
- Intercom: ad-hoc live session handoff, not the default repeatable data plane.

Do not tell the model to “act fresh”; configure the context.

## Artifact-first handoff

Prefer:

```text
contract.md
research/*.md
implementation-notes.md
check-results.json
review-report.json
```

A downstream stage loads only the sections/files it needs. Avoid concatenating every prior response into the next prompt.

Use `outputMode: "file-only"` when downstream work needs the artifact rather than duplicate transcript text. Use structured schemas for decisions/gates/reducers.

## Long-run working state

- Keep a file-backed TODO/ledger for current objectives, completed items, blockers, and evidence.
- Preserve one canonical contract and reference it.
- Save reconnaissance to an artifact before it grows beyond a small inline investigation.
- Use session tree/fork/clone to correct or continue a trace intentionally.
- Analyze prior sessions as advisory evidence, not project policy.

## Verbatim compaction

Atomic mechanically preserves surviving lines rather than rewriting them into summary prose. Use `<keepContext>` only for short invariants and final-action boundaries. Large protected spans force more aggressive deletion elsewhere.

A configured fallback planner may receive the compactable transcript. Provider choice is therefore also a data-governance decision.

## Failure patterns

- lost in the middle: contract buried in long context;
- author bias: reviewer inherits the author's trace;
- distraction: unrelated logs/docs crowd the stage objective;
- duplicated contracts: several paraphrases disagree;
- stale memory: prior session treated as current project truth;
- unstructured swarm chat: token-heavy communication without durable edges/artifacts;
- compaction drift: important constraint not protected or stored as artifact.
