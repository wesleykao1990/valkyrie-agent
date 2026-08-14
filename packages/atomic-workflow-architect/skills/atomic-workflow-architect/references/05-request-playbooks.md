# Request Playbooks

## Idea

Default intent: explore and decide.

```text
capture exact idea
→ resolve project + duplicate/overlap check
→ parallel: user value / technical feasibility / strategic fit / risks and cost
→ evidence-backed synthesis
→ smallest validation experiment
→ human decision: park / research / promote / design MVP
```

Use the bundled `idea-to-decision` workflow when available. Do not edit source code unless the user explicitly promotes the idea to implementation.

## Project

Default intent: blueprint and first executable slice.

```text
objective + users + non-goals + constraints
→ existing assets and dependencies
→ architecture options
→ workstream/dependency DAG
→ risks/security/data/evaluation
→ milestones and acceptance criteria
→ first vertical slice
→ human approval
→ separate top-level runs per independent item/cluster
```

Use `project-blueprint` or `request-preflight` first. Do not create one monolithic implementation workflow for an entire project.

## Feature

```text
Prompt Engineer/Create Spec discipline when needed
→ literal run contract + compatibility posture
→ focused codebase/product research
→ plan/spec artifact
→ implementation in isolated worktree/sandbox
→ targeted tests + type/lint/build + behavior proof
→ fresh reviewer(s) by distinct risk surface
→ reducer and bounded repair
→ same checks rerun
→ human/final-action gate
→ optional draft PR
```

Use Goal when the objective is clear and durable autonomous execution is the main need. Use Ralph when research/refinement and adversarial review are central. Otherwise author a task-specific parent/composition.

For large changes, split into dependency-aware vertical slices or stacked PRs, and prove each phase before advancing.

## Bug

```text
reproduce with evidence
→ isolate root cause
→ failing regression test when feasible
→ smallest correct fix
→ rerun focused reproduction/test
→ broader regression checks
→ fresh verifier inspects root cause and side effects
→ bounded repair
```

Never start broad speculative edits before reproduction/root-cause evidence unless reproduction is impossible and the limitation is explicit.

## Migration or refactor

```text
inventory call sites/contracts/data
→ classify dependency clusters and compatibility windows
→ define rollback/invariants
→ partition into bounded waves/stacks
→ execute each wave with separate evidence gates
→ compatibility/dual-read/dual-write checks as required
→ human gate per irreversible transition
→ final audit and cleanup only after migration proof
```

High failure cost implies deterministic and adversarial gates even for a small diff.

## Review or research

```text
question + evidence standard
→ independent source/code slices
→ artifact-backed findings with citations/paths
→ contradictions and missing evidence
→ synthesis/recommendation with confidence
→ optional adversarial verification or candidate comparison
```

Use fresh contexts and avoid agents merely rephrasing one another.

## Design

Use `open-claude-design` when installed and suited:

```text
guided requirements
→ reference/design-system research
→ generated visual artifact
→ human visual feedback
→ bounded refinement
→ export + engineering handoff
```

Visual approval is a product/human gate; screenshot generation alone is not design acceptance.

## Queue

```text
enumerate
→ inspect material dependency evidence
→ independent / dependent / clustered classification
→ bounded wave of top-level runs
→ one worktree and failure boundary per independent writer
→ read-only evaluator for candidate comparison
→ item → run → branch → PR/result map
```
