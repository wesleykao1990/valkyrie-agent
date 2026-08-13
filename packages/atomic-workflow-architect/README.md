# Wesley Atomic Workflow Architect

A private-use Atomic package that lets Wesley make an ordinary request such as:

- “I have an idea for Ovalo…”
- “Plan this project…”
- “Build this feature…”
- “Fix this bug…”
- “Compare two implementations…”

without learning Atomic's graph syntax, setup details, built-ins, model routing, context modes, or verification design.

This directory is the Atomic-specific execution module inside Wesley's larger Project OS repository. It is not the whole control plane, does not replace the repository's storage, runtime-adapter, Project Brain, or workspace boundaries, and does not enable a live Atomic runtime merely by being present.

The package automatically routes actionable input into the `atomic-workflow-architect` skill. The skill resolves intent and project truth, creates a run contract, chooses the smallest complete execution shape, designs evidence and human gates, and launches through Atomic or produces an exact control-plane handoff.

## What happens to each request

| Request | Default behavior |
|---|---|
| Idea | Read-only value/feasibility/risk decision workflow; no code |
| Project | Blueprint, dependency DAG, risks, and first vertical slice; no monolithic build |
| Explicit feature | Spec/contract as needed, then smallest complete Atomic implementation workflow |
| Bug | Reproduce, root-cause, regression proof, minimal repair, fresh verification |
| Migration/refactor | Inventory, compatibility/rollback contract, bounded waves, per-wave gates |
| Review/research | Independent evidence branches and synthesis/adversarial review |
| Competing implementations | Separate writer worktrees plus read-only evaluator/tournament |
| Tiny deterministic edit | Direct/inline path |

Use `direct:` or `inline:` to bypass. Use `atomic:` or `workflow:` to force the architect.

For general control-plane routing, these map to three profiles: Direct (one root
session plus deterministic checks), Atomic Lite (one retained implementer stage,
model-free checks, forked repair, conditional fresh review), and Atomic Full
(multi-stage evidence, bounded repair/reduction, durability, and gates). Hermes
may express a preference; the control plane makes and records the final decision.
The package auto-router runs after Atomic has already been selected, so it cannot
by itself choose a direct Codex/Claude root runtime.

## Package contents

- natural-language input-routing extension;
- `atomic-workflow-architect` Agent Skill;
- `idea-to-decision`, `project-blueprint`, `request-preflight`, and the reusable
  package-local `atomic-lite-writer` workflow;
- feature, bug, migration, idea, and project workflow templates;
- run-contract, pre-launch, launch-manifest, and memory-proposal assets;
- Hermes/control-plane/Codex/Claude integration guidance;
- official Atomic research dossier;
- completed synthesis of both supplied masterclass transcripts;
- native durability, worktree ownership, compaction, Intercom, and workflow-promotion policy.

## Install locally

```bash
cd /absolute/path/to/valkyrie-agent/packages/atomic-workflow-architect
npm run verify
atomic install -l "$PWD"
```

`-l` writes to project settings. Omit it for a user-global install.

One-session trial:

```bash
atomic -e "$PWD"
```

Then type a normal request. Qualifying external input is transformed into:

```text
/skill:atomic-workflow-architect <original request>
```

The router skips slash/shell commands, extension-generated input, active-run steering/follow-ups, greetings, and informational questions.

## First-class runtime boundary

When Atomic is selected:

```text
Hermes → control plane → Atomic main session → Atomic workflow tool → native workflow graph
```

The control plane may invoke Atomic through Atomic's SDK or JSONL RPC. It must not recreate Atomic as a thin wrapper under Codex/Claude Code or own its internal graph.

## Safety

Atomic packages, extensions, workflows, and tools execute with the Atomic process's authority. The bundled auto-router itself only transforms input, but autonomous writing still requires:

- external container/VM/micro-VM/policy sandbox;
- one writer lease and worktree per candidate;
- scoped credentials and network/tools;
- budget/loop limits;
- typed human approval for high-risk final actions;
- pinned/reviewed workflow/package sources.

## Status

Version 0.2.1 is a repository-integrated derivative of the verified 0.2.0 source package. Its research remains grounded in Atomic 0.9.12-era first-party documentation/source plus the two supplied masterclass transcripts. Atomic changes quickly. Pin the production version and rerun contract tests after upgrades.

The package now explicitly declares all three host modules imported by its code. Their peer ranges remain `*` because the source bundle did not record a verified published version set. Do not treat those ranges as production pins: the disabled-by-default pilot runner must supply and contract-test exact versions before live use.

The package has been structurally and TypeScript-checked and its fixed M5a/M5b
workflows were live-exercised with the repository's pinned Atomic 0.9.12 runner.
The package-local `atomic-lite-writer` is contract-tested but is not registered
as a general runtime and has not received a live model-backed task. Any future
deployment must remain bounded by an accepted project policy, the external
writer sandbox, and the control-plane approval/evidence boundary.
