# Runtime Integration and Workflow Promotion

## First-class Atomic root

```text
Hermes/mobile
  ↓ authenticated control-plane MCP
Control plane: stable IDs, policy, budget, sandbox, workspace lease
  ↓ Atomic RPC or Atomic SDK
Atomic main session: native meta-orchestrator
  ↓ workflow tool
Atomic workflow runs/stages/tools/artifacts/HIL/checkpoints
```

The control plane may embed or invoke Atomic through Atomic's own SDK/RPC. It must not try to recreate Atomic as a wrapper around another coding-agent SDK or own Atomic's internal stage scheduler.

## Model and worker mapping

When a request says "use Claude to implement and Codex to review," resolve it against available capabilities:

1. Prefer Atomic-native Anthropic/OpenAI model providers inside separate stage contexts when that meets the request.
2. Use external Claude Code/Codex CLI adapters only when the user specifically wants those runtimes or the task needs their native environment.
3. For external runtime comparisons, launch separate top-level candidates/worktrees and evaluate them read-only.
4. Never imply that a model-provider stage is the same thing as a Claude Code or Codex CLI run.

## Dynamic workflow lifecycle

Generated workflow states:

```text
run-scoped draft
→ source inspection
→ type/check/reload
→ smoke tests
→ approved project workflow
→ repeated task evals
→ reusable package candidate
→ reviewed/pinned release
```

A workflow that self-corrects during a run may update a run-scoped draft, but that change must be captured as a diff/artifact. It does not silently replace the canonical workflow used by future runs.

## Version and provenance

Record:

- Atomic version/commit;
- workflow path, version, and content hash;
- package sources and pinned refs;
- generated-by model/provider/session;
- user/policy approval;
- success/failure eval results;
- superseded workflow version.

## Handoff contract

A launch manifest must validate against `../assets/launch-manifest.schema.json`. Populate `../assets/launch-manifest-template.json` rather than maintaining an abbreviated second shape here.

The schema requires the stable control-plane run/project/task IDs, exact request, context/contract references, workflow identity and hash, budget, final-action boundary, workspace identity and owner, exclusive writer lease, durability requirement, `crossProcessResume`, time/turn/repair/child/concurrency bounds, approvals, and correlation/idempotency keys.

A valid manifest is a handoff record, not proof that Atomic started and not authorization for a gated final action. Default `crossProcessResume` to `false` unless the runner positively verifies the durable Atomic backend at startup.
