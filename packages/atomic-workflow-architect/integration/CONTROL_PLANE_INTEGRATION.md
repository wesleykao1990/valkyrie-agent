# Control-Plane Integration

## Recommended placement

```text
Hermes
  ↓ authenticated MCP
Thin TypeScript control plane
  ↓ Atomic JSONL RPC initially; Atomic SDK later if pinned/tested
Atomic main session in a control-plane-owned isolated runner/worktree
  ↓ workflow tool
Atomic native workflow runs
```

Atomic is a first-class root runtime. The control plane starts/observes it; it does not recreate Atomic as a wrapper around Codex, Claude Code, or another agent SDK.

## Route before root-runtime launch

Hermes preserves the literal request and may attach an optional Direct / Atomic
Lite / Atomic Full preference. The control plane resolves authoritative context,
scores Structure, Verifiability, Iteration, Risk, Duration, and Isolation, applies
hard workflow signals, and records the final decision and reasons. A preference
may increase rigor but cannot reduce it.

This decision must happen before a root runtime starts. The Atomic package's
input auto-router can choose an Atomic skill/workflow after Atomic is selected;
it cannot turn that already-started session into a direct Codex or Claude root.
Atomic Lite should retain one implementer stage/session, use forked repair,
model-free checks, and conditional fresh review. Atomic Full is reserved for
multi-stage, high-risk, iterative, resumable, parallel, or gated work.

## Runner installation

Install/pin this package in the trusted runner image or project settings. The control plane supplies the exact request and project context. External RPC input is automatically transformed into the skill invocation.

```bash
atomic --mode rpc --session-dir /private/run/sessions
```

The adapter must implement strict LF-delimited JSONL. Avoid generic line parsing that treats Unicode line separators as record boundaries.

## Main-session launch

Suggested prompt payload:

```json
{
  "id": "run-start-01",
  "type": "prompt",
  "message": "Build OVA-388 using context pack context://ovalo/OVA-388/v17. Stop after checks. Max cost $8; max 2 repair rounds. Do not create or merge a PR."
}
```

The main Atomic session performs intent/routing and then owns the workflow tool interaction. The control plane should not select every internal stage itself.

## Required policy outside Atomic

- authenticated caller and correlation/idempotency key;
- stable project/task/run ID;
- one top-level worktree and writer lease;
- external sandbox/container/VM;
- credential, network, path, tool, and command policy;
- cost/time/turn/child/concurrency circuit breakers;
- typed approval resolution;
- event cursor and periodic native-state reconciliation;
- raw native event retention;
- artifact checksums/expiring links;
- package/workflow version pinning and provenance.

## Runtime capabilities

Discover rather than simulate:

```text
start
status/events
steer/follow-up
pause/resume/quit
cancel
human input/approval
workflow list/get/reload/run/connect
artifact collection
cost/model metadata
native durability state
```

Atomic remains authoritative for internal graph/checkpoint/session state.

## Launch manifest

Validate the stable control-plane handoff against `skills/atomic-workflow-architect/assets/launch-manifest.schema.json`, then populate it from `launch-manifest-template.json`. A valid manifest records intent and policy; it does not itself authorize or start execution. Important fields include:

- schema version and stable control-plane run ID;
- exact request and intent;
- stable project/task IDs and context/contract references;
- selected workflow/path/hash;
- workspace owner/ID/reference and the exclusive writer lease;
- final-action boundary;
- budget, turn/time/repair/child/concurrency bounds, and approvals;
- model-role policy;
- generated-workflow trust state.

Set `crossProcessResume=false` unless the runner has positively verified Atomic's durable DBOS/PostgreSQL backend at startup.

## Native versus normalized events

Preserve raw Atomic events and project a mobile-friendly timeline:

```text
run.started
workflow.authored/reloaded/started
stage.started/completed/failed
artifact.created
check.passed/failed
approval.requested/resolved
cost.updated
run.paused/resumed/completed/failed/cancelled
```

Atomic main-chat lifecycle notices are useful orchestration context but do not replace native event capture.

## Durability

For resumable production runs, verify DBOS/PostgreSQL at runner startup. If Atomic uses a non-durable process-local fallback, mark `crossProcessResume=false` and do not advertise recovery after process loss.

A terminal multiplexer/Herder may preserve terminal access but is not workflow durability.

## Workspace ownership

Normally:

```text
Control plane owns: top-level worktree, container, writer lease, cleanup.
Atomic owns: DAG, stage sessions, checkpoints, native HIL, artifacts, authorized child/candidate topology.
```

Do not create a duplicate Atomic top-level worktree. For standalone Atomic, native worktree binding is acceptable inside an external sandbox.

## Dynamic workflow generation

When Atomic authors a new workflow from natural language:

1. record source path/diff/hash/model/session;
2. type-check and `/workflow reload`;
3. inspect discovered inputs;
4. test success, expected failure, HIL/cancel, and bound exhaustion;
5. require approval before high-risk execution;
6. keep it run/project-scoped until evals justify reusable promotion.

The control plane stores promotion state separately from run completion.
