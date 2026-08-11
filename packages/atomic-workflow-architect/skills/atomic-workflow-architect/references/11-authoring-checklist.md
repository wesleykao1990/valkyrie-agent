# Workflow Authoring Checklist

## Fit

- What concrete outcome is produced?
- Why is a workflow better than direct/subagents?
- Is a built-in whole-task fit available?
- What is explicitly out of scope?

## Intent and contract

- Exact user request and intent?
- Compatibility posture resolved?
- Inputs and narrow schemas?
- Required outputs and final-action fields?
- Acceptance criteria/invariants/evidence matrix?
- Stop/ask conditions and bounds?
- Short load-bearing clauses protected with `<keepContext>` where needed?

## Graph

- Which standard pattern fits?
- What are stages and dependencies?
- Is topology acyclic under every runtime branch?
- Are loops distinct tracked iterations with stable order?
- Are independent queue items/candidates separate top-level writers/worktrees?
- Are nested workflow boundaries modular rather than copied?

## Stage contracts

For each stage:

- objective and literal success criteria;
- inputs/artifacts/reads;
- tools/MCP/permissions;
- fresh/fork context mode;
- output schema/artifact;
- evidence;
- blocker/stop rules;
- model/fallback.

## Context

- Large content passed by file/`reads`?
- One canonical contract?
- Reviewer isolated from author trace?
- Run-local TODO/ledger present for long work?
- Intercom used only when ad-hoc messaging is actually needed?
- Output size/context budget bounded?

## Verification

- Deterministic checks owned by `ctx.tool`?
- Fresh verifier derives/uses probes?
- Evidence reaches reducer and repair?
- Same probes rerun after repair?
- Repair bound and visible exhaustion?
- Final action separated from implementation acceptance?

## Generated-source trust

- Generated source diff inspected?
- Type check passes?
- `/workflow reload` succeeds?
- `/workflow list` and inputs confirmed?
- Success, expected failure, HIL/cancel, and bound exhaustion tested?
- Run-scoped versus promoted status recorded?

## Safety and operations

- Worktree owner and external sandbox?
- Tool/path/network/credential scope?
- Human approval actions?
- Durable backend verified for resume promises?
- Workflow/Atomic/package versions and hashes recorded?
- Native and normalized events retained?
