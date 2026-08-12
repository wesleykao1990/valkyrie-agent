# ADR-P005: Atomic writer pilot through the governed external boundary

- Status: Proposed
- Date: 2026-08-12
- Decision owner: Wesley Kao
- Implementation status: M5a tool-only slice implemented and live-verified with
  no model/provider credential. M5b model-backed slice is not implemented.

## Context

Milestone 3 proves pinned Atomic RPC/package discovery but deliberately performs
no model work or repository write. Milestone 4 proves the separate fenced Git,
container, artifact, cleanup, and restart boundary but does not register a
runtime. Neither proof alone is an end-to-end Atomic pilot.

Atomic runs extensions, workflow definitions, tools, shell commands, and model-
requested actions with the authority of its process. Therefore the whole Atomic
main session must run inside the external boundary for a writing task. A Git
worktree alone is not a sandbox, and routing only some Atomic tools into a
container would leave extension and workflow code on the host.

## Proposed decision

1. Add one default-off, literal `atomic-fixture-pilot` path for a disposable
   repository and fixed acceptance criteria. Do not turn it into a generic
   command, repository, image, or workflow launcher.
2. The control plane owns the top-level Git workspace, fenced writer lease,
   container, bounded context pack, launch manifest, artifact export, approval,
   and final-action policy. Atomic owns one main session and its native workflow
   graph, stages, checkpoints, prompts, and internal repair state.
3. Run the entire Atomic process inside the M4 container. Add a provider-owned
   interactive JSONL exec boundary rather than allowing an adapter to bypass OCI
   ownership and policy inspection with raw engine commands.
4. First prove the composition with a real credential-free native `ctx.tool`
   workflow. Label it integration evidence, not model execution. Do not use a fake
   model or scripted inference response to claim a successful model pilot.
5. Enable model stages only behind a reviewed local inference endpoint or a
   credential-holding inference proxy outside the writer. The writer receives at
   most a run-scoped expiring capability. It never receives host Atomic/Codex/
   Claude homes, keychain/browser state, raw subscription OAuth, Docker socket,
   or a long-lived provider key.
6. Preserve every raw Atomic record and native identifier alongside normalized
   events. Treat prompt acceptance as transport acknowledgement, not workflow
   completion; terminal state comes from native workflow lifecycle/status.
7. Keep `crossProcessResume=false` until Atomic's own external PostgreSQL/DBOS
   durability passes a process-kill/restart/resume contract test.
8. Stop Atomic and the container, export and scan evidence, remove the worktree,
   and release the exact fence before asking for the control-plane final-action
   approval. The approval can create only a safe mock acceptance receipt.
9. A memory proposal may be generated from accepted evidence, but canonical
   promotion remains a separate preview-bound human action.
10. Direct Codex and Claude Code remain separate root candidates for Milestone 6;
    neither drives Atomic's internal stages or shares its worktree.
11. The M5a contract has zero repair rounds. Because the implementation bytes are
    reviewed and fixed, any preflight/check/verifier mismatch fails closed and a
    new candidate is required. Repair continuity belongs to the later model-backed
    variant, where evidence can justify a bounded repair.

## Consequences

- The first live proof can validate the hardest lifecycle boundaries without
  exposing a model credential or pretending that a scripted workflow measures
  agent quality.
- A full model-backed M5 run depends on a scoped inference boundary; plain Docker
  named-network egress is not sufficient.
- The pilot is intentionally fixture-specific. General repository-writing
  enablement follows evidence, not configuration convenience.
- Approval occurs after writer cleanup, so `request_changes` starts a new
  candidate instead of reviving a removed or stale worktree.
- Atomic workflow HIL may be contract-tested separately, but the final-action
  gate remains control-plane-owned and does not depend on an attached Atomic
  process.

## Approval requested

Accept, amend, or reject the split between native integration proof and model-
backed pilot proof, plus the requirement for scoped inference access before
model credentials enter a writer boundary.
