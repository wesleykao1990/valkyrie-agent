# Atomic Mental Model

## Atomic is a first-class runtime

Atomic owns the native agent execution environment: sessions, tools, models, context state, workflow graph, checkpoints, human-input nodes, and native run control. It is not merely a prompt wrapper around Codex, Claude Code, or another coding-agent SDK.

Our control plane may start and observe Atomic through Atomic's own JSONL RPC or TypeScript SDK. It must not recreate Atomic's scheduler or make another coding agent the owner of an Atomic root run.

```text
Hermes/mobile request
  ↓
Control plane: identity, project, policy, budget, sandbox, workspace lease
  ↓
Atomic main session: native meta-orchestrator
  ↓ workflow tool
Atomic workflow graph
  ├─ model stages
  ├─ deterministic tools/checks
  ├─ artifacts and schemas
  ├─ fresh reviewers
  ├─ bounded repair
  └─ human gates
  ↓
Evidence-backed result
```

## Loop, graph, and workflow

- **Loop:** compare observed state with desired state, repair, repeat under an explicit bound.
- **Graph:** the live dependency/readiness/evidence/control topology of a run.
- **Workflow:** versioned TypeScript policy that materializes the graph and makes the loop inspectable.

Control-theory mapping:

```text
acceptance criteria → set point
workflow policy → controller
agent/tools → actuator
repository/application → plant
tests/probes/review → sensors
pass/repair/fail/budget/awaiting-input → controller states
```

The graph is not the goal. Reliable, reviewable software is the goal.

## Resource hierarchy

- Extensions: code-level hooks, tools, commands, UI, policy interception.
- Skills: domain knowledge, interpretation, reusable instructions, scripts/references.
- Prompt templates: reusable user prompts.
- Subagents: bounded specialist children while a parent retains control.
- Workflows: tracked execution graphs, evidence, gates, repair, and durable state.
- Packages: distribution unit for extensions/skills/prompts/themes/workflows.
- SDK/RPC/JSON: first-party integration surfaces.

## Skills versus workflows

Use a skill for knowledge and judgment. Use a workflow for repeatable control flow.

```text
"What does good look like here?" → skill / Project Brain
"Do A, then B, prove C, repair twice, ask before D" → workflow
```

Keep `AGENTS.md`/`CLAUDE.md` as small bootstraps. Locally scope repeatable process in workflows instead of accumulating giant always-loaded instruction files.

## Authority boundaries

```text
Hermes       → mobile conversation, notifications, approvals
Linear       → roadmap and work state
Git/GitHub   → code, checks, PRs, delivery history
Project Brain/Obsidian → accepted decisions and durable rationale
Atomic       → native workflow graph, checkpoints, session state
Control plane → stable cross-runtime IDs, policy, budget, lease, approvals
```

Atomic session history, TODOs, compaction, and Intercom are working memory. They do not override Linear, Git, or accepted Project Brain knowledge.

## Native state versus containment

Atomic can own workflow-bound worktrees and DBOS/PostgreSQL checkpoints. It still runs with the permissions of its process. Native durability and worktrees do not replace external sandboxing, credential policy, or a cross-runtime run registry.
