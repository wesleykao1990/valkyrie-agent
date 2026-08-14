# Codex and Claude Code Handoff

Use Codex or Claude Code to continue developing, reviewing, and testing this Atomic package. Do not put Atomic underneath either runtime as a thin wrapper.

## Correct roles

- **Atomic:** root runtime for native workflow graph/checkpoints/HIL when selected.
- **Codex/Claude Code:** direct alternative runtime, workflow/package author, reviewer, or explicitly configured specialist integration.
- **Atomic provider stage:** a model call through Atomic; not automatically a Codex/Claude Code CLI session.

## Continuation checklist

1. Read `README.md`, `START_HERE.md`, and `skills/atomic-workflow-architect/SKILL.md`.
2. Read `research/ATOMIC_EXPERT_RESEARCH.md` and `research/VIDEO_MASTERCLASS_FINDINGS.md`.
3. Read current installed Atomic docs/source; do not rely only on package snapshots.
4. Run `npm run verify` and `tsc --noEmit`.
5. Preserve the authority and security boundaries.
6. Do not enable real writing without external containment.
7. Keep generated workflows run/project-scoped until tested and approved.
8. Add contract tests before changing RPC framing or event normalization.

## Recommended next engineering work

- treat Atomic 0.9.12 as the first researched candidate and contract-test it with
  the full peer set in a disposable repository before calling any host version
  compatible;
- verify actual workflow discovery/input contracts;
- exercise idea/project/preflight workflows;
- implement a real Atomic RPC adapter in the control-plane prototype;
- capture native events and IDs;
- test steering, pause/quit/resume, HIL, cancellation, compaction, and process recovery;
- compare Goal/Ralph/custom feature workflow on one medium-risk Ovalo issue;
- measure quality, defect capture, review burden, time, cost, and recovery;
- promote only workflows that pass repeated evaluations.

## Suggested handoff prompt

```text
Continue the Wesley Atomic Workflow Architect package.

Preserve these decisions:
- Hermes is the mobile interface; Linear, Git, Project Brain, control plane, and Atomic keep separate authority.
- Atomic is a first-class root runtime, not a wrapper under Codex or Claude Code.
- The Atomic main session is the native meta-orchestrator.
- Ideas/projects default to read-only decision/spec workflows.
- Explicit non-trivial feature/bug requests use the smallest complete evidence-backed workflow.
- Fresh reviewer, forked implementer, artifact handoffs, deterministic probes, bounded repair, and final-action separation are defaults.
- Generated workflow source is inspected/tested/promoted separately.
- Atomic session memory does not become canonical project memory.
- External sandboxing and one writer lease remain mandatory.

First run the existing verification. Then propose the smallest next change with exact tests and no production credentials.
```
