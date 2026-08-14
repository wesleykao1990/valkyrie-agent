# Control-Plane Integration

## Root ownership

One task has one root runtime. When Atomic is root:

- Atomic main session/workflow runtime owns the native graph, stage sessions, checkpoints, native HIL, and workflow control.
- Control plane owns stable cross-runtime ID, authenticated policy, budget, workspace lease, approval records, and normalized projection.
- Hermes owns conversation and mobile presentation.

Do not put Atomic underneath a Codex/Claude wrapper that owns its lifecycle. Atomic may be started and observed through Atomic's own RPC/SDK.

## Recommended adapter

Use JSONL RPC first for a process boundary and streamed events. Consider embedded TypeScript SDK after pinning and contract testing.

Store:

- stable run ID;
- Atomic native session/workflow IDs;
- workflow name/path/version/hash;
- Atomic version/commit;
- project/task IDs;
- context-pack/contract refs;
- workspace/container and lifecycle owner;
- policy/budget/final-action boundary;
- status projection and event cursor;
- raw native event reference;
- artifact/evidence refs.

Do not reconstruct Atomic's graph from prose.

## Hermes flow

```text
Wesley request
→ Hermes resolves project/task/intent
→ control plane validates policy and builds context pack
→ isolated workspace + lease
→ Atomic main-session RPC prompt
→ auto-router invokes atomic-workflow-architect
→ Atomic selects/authors/launches native workflow
→ native events projected to Hermes/Linear
→ typed approval/steering routed to native run
→ result/PR/evidence
→ Linear update + governed memory/workflow proposals
```

## Project context pack

```json
{
  "project": "ovalo",
  "task": {"source": "linear", "id": "OVA-388", "version": 17},
  "repository": {"sha": "...", "branch": "...", "dirty": false},
  "accepted_decisions": [],
  "relevant_resources": [],
  "advisory_memories": [],
  "policy": {
    "max_cost_usd": 8,
    "max_repairs": 2,
    "allow_pr_creation": false,
    "allow_merge": false
  },
  "freshness": {"linear": "...", "git": "...", "vault": "..."}
}
```

## Status projection

Normalize enough for mobile while preserving raw payloads:

```text
run.started
workflow.authored/reloaded
stage.started/completed/failed
artifact.created
check.passed/failed
approval.requested/resolved
cost.updated
run.paused/resumed/completed/failed/cancelled
```

Lifecycle notifications sent to Atomic's main chat are useful for orchestration but are not a substitute for native event capture/reconciliation.

## Avoid double orchestration

Recommended boundary:

```text
Control plane owns: identity, policy, sandbox/container, writer lease, top-level workspace, cross-system budgets/approvals.
Atomic owns: main-session orchestration, DAG, stage contexts, workflow prompts, checkpoints, native HIL, artifacts, and authorized child topology.
```

For standalone use, Atomic may own the top-level worktree inside an external sandbox.
