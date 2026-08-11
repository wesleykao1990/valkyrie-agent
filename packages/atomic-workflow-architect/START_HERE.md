# Start Here

## 1. Verify

```bash
npm run verify
```

## 2. Install or try

```bash
# Project-local
cd /absolute/path/to/valkyrie-agent/packages/atomic-workflow-architect
atomic install -l "$PWD"

# One session only
atomic -e "$PWD"
```

Ensure skill commands are enabled:

```json
{
  "enableSkillCommands": true
}
```

## 3. Confirm discovery

Inside Atomic:

```text
/workflow list
/skill:atomic-workflow-architect Explain how you would route a medium-risk feature. Do not implement.
```

Test routing without launching:

```text
/atomic-routing test Build a feature that adds a project dashboard
/atomic-routing test Build me a meal plan
```

Expected package workflows:

```text
idea-to-decision
project-blueprint
request-preflight
```

## 4. Use ordinary language

```text
I have an idea for Ovalo: turn any short-form video into a listening lesson.
```

Expected: read-only idea decision graph, no code.

```text
Plan a project that creates personalized live language role-play games.
```

Expected: blueprint, dependency graph, first vertical slice, human planning decision.

```text
Build live interruption handling for the role-play feature. Stop after checks; do not create a PR.
```

Expected: contract/spec if needed, implementation workflow, deterministic proof, fresh verifier, bounded repair, stop at checks.

```text
Fix the Signal Ledger Threads ingestion bug. Reproduce it first and prove the fix with a regression test.
```

Expected: reproduce → root cause → regression test → minimal repair → broader checks → fresh verifier.

## 5. Explicit controls

```text
direct: fix this README typo
```

```text
atomic: compare three pronunciation-scoring implementations
```

```text
/atomic-plan Design the workflow without launching it.
```

```text
/workflow request-preflight
```

## 6. For long/background runs

Before promising cross-process resume, confirm a durable Atomic DBOS/PostgreSQL backend. Terminal multiplexing alone is not durability.

Workspace ownership:

- control-plane run → control plane owns top-level worktree/container/lease;
- standalone run → Atomic may own worktree inside an external sandbox.

## 7. From Hermes

Hermes sends the exact request, project/task IDs, context-pack reference, budget, and final-action policy to the authenticated control plane. The control plane starts one Atomic main session, and the auto-router invokes the skill.

Hermes never manages OS processes, worktrees, model credentials, or individual graph stages directly.

Read:

```text
integration/INSTALLATION_AND_OPERATIONS.md
integration/HERMES_USAGE.md
integration/CONTROL_PLANE_INTEGRATION.md
integration/ARCHITECTURE_DECISION_ADDENDUM.md
```

## 8. From Codex or Claude Code

Use the skill to review/author/test the Atomic package or workflow. Do not treat an Atomic provider stage as identical to a Codex/Claude Code runtime run.

Read:

```text
integration/CODEX_CLAUDE_HANDOFF.md
```

## 9. Research basis

```text
research/ATOMIC_EXPERT_RESEARCH.md
research/VIDEO_MASTERCLASS_FINDINGS.md
```
