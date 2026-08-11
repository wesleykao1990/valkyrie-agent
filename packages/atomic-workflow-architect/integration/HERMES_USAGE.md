# Hermes Usage

Hermes is Wesley's mobile interface. It should call constrained control-plane tools rather than manage Atomic processes, model credentials, containers, or worktrees directly.

## Natural mobile requests

```text
Add an Ovalo idea: turn any short video into a listening lesson. Check duplicates, evaluate it, and do not build it.
```

```text
Plan a project for live language-learning game shows. Give me the first vertical slice and risks.
```

```text
Build OVA-388 with Atomic. Stop after checks and show me the evidence before any PR.
```

```text
Show current Atomic stage, elapsed time, cost, evidence, and anything that needs me.
```

## Hermes-to-control-plane request

Hermes sends:

- authenticated user/channel;
- stable project/task ID;
- exact user request;
- explicit intent when known;
- context-pack reference and freshness;
- allowed root runtime/workflows/models/tools;
- budget, duration, child depth, concurrency, and repair limits;
- workspace/sandbox policy;
- final-action boundary;
- idempotency/correlation key.

Example:

```json
{
  "project_id": "ovalo",
  "task_id": "OVA-388",
  "request": "Build live interruption handling. Stop after checks; do not create a PR.",
  "root_runtime": "atomic",
  "context_pack_ref": "context://ovalo/OVA-388/v17",
  "policy": {
    "max_cost_usd": 8,
    "max_repairs": 2,
    "allow_pr_creation": false,
    "allow_merge": false
  }
}
```

The control plane starts one Atomic main session. The package's input router invokes `atomic-workflow-architect`, which selects/authors/launches the native workflow.

## Default automation levels

| Request | Hermes may start automatically? |
|---|---|
| Idea evaluation | Yes, read-only |
| Project blueprint/preflight | Yes, read-only |
| Explicit scoped feature/bug implementation | Yes when context is sufficient and policy allows |
| Materially ambiguous/high-risk generated workflow | No; show preflight/approval |
| Draft PR | Only when explicitly allowed or policy-approved |
| Merge/deploy/destructive data/secret expansion | Always human approval initially |
| Canonical memory/workflow promotion | Human review initially |

## Mobile status

Hermes should summarize a structured projection:

```text
OVA-388 · Atomic · running
Current stage: fresh verifier
Elapsed: 38m
Cost: $2.14 / $8
Evidence: typecheck ✓, unit tests ✓, browser proof pending
Needs Wesley: none
Final action: stop after checks
```

Deep links may point to Linear, GitHub, artifacts, or an optional operator console.

## Steering

A steering message amends the existing native run only when policy allows:

```text
Keep the public API unchanged. Add a regression test for the reconnect path.
```

The control plane sends it to the Atomic native session/workflow. It must not create a second root run. Short load-bearing amendments should be preserved in the Atomic session contract/`keepContext` span.

## Completion

Hermes reports:

- stable and Atomic native run IDs;
- terminal status;
- exact checks/evidence;
- changed files/commits/PR;
- cost/time/repair count;
- remaining risk and requested next action;
- any memory/workflow proposal requiring review.
