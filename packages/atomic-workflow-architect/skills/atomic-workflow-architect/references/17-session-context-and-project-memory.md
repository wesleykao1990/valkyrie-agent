# Atomic Session Context versus Project Memory

Atomic and the Project Brain solve different persistence problems.

## Atomic session/run state

Use for:

- current implementation trace;
- file-backed TODO/run ledger;
- branch/fork/tree state;
- workflow stages/checkpoints;
- active steering and Intercom messages;
- verbatim compaction of the live session;
- run-local artifacts and evidence.

This state is authoritative for the native Atomic run, not for roadmap or durable architecture decisions.

## Project Brain

Use for:

- accepted product/architecture decisions;
- verified specifications and constraints;
- durable research summaries;
- project glossary and operating principles;
- reviewed reusable Jobs/skills/workflow rationale.

## Operational truth

- Linear: current work status and priority.
- Git/checks: current code and observed behavior.
- Atomic: current native workflow/run state.
- Project Brain: accepted rationale.
- Episodic memory: prior observations, ranked below canonical sources.

## Compaction policy

`<keepContext>` is for short constraints whose loss would silently change behavior:

```text
<keepContext>
Do not change the public API. Stop after checks; do not create or merge a PR.
</keepContext>
```

Do not place large specs, logs, or whole context packs inside protected spans. Store them as artifacts and pass their references. Note that a configured fallback planner may receive the compactable transcript during compaction; credential/provider privacy policy must account for that.

## Session-history reuse

Atomic can inspect prior sessions and derive a handoff, but a prior session is evidence of what an agent attempted—not automatically a rule. When a prior approach should become reusable:

1. create a structured memory/workflow proposal;
2. attach source run and evidence;
3. compare with current project truth;
4. approve and version the resulting Job/skill/workflow.
