# Masterclass-Derived Operating Rules

These rules distill the two supplied Atomic masterclass transcripts and reconcile them with the official documentation.

## Runtime ownership

- Atomic is a first-class runtime, not a wrapper under Codex or Claude Code.
- The Atomic main session is the native meta-orchestrator and controls workflow runs through the workflow tool.
- Hermes launches and observes Atomic through the control plane; it does not steer individual graph nodes itself.
- Codex and Claude Code are alternative direct runtimes, comparison candidates, or explicit specialist integrations—not owners of an Atomic root run.

## Intent before autonomy

- Use structured questions, Prompt Engineer, and Create Spec discipline when ambiguity could waste a long run.
- Ask only questions that change user behavior, public contracts, compatibility, security, architecture, irreversible effects, evidence, or material spend.
- Preserve the literal run contract and final-action boundary with `<keepContext>` when compaction/long duration makes loss costly.

## Context and handoffs

- Fresh context for reviewers/evaluators.
- Forked continuity for implementation/repair.
- Artifacts and typed outputs across stages, not transcript dumping.
- File-backed TODO/run ledger for working continuity.
- Session history is advisory working memory; Project Brain is canonical project knowledge.

## Skills versus workflows

- Skill: domain knowledge, reusable judgment, references, how to interpret the project.
- Workflow: repeated process, dependencies, gates, retries, evidence, side effects, and final actions.
- Convert mature step-by-step skills/Jobs into workflows.
- Keep `AGENTS.md` and `CLAUDE.md` thin; move process into locally scoped workflows.

## Generated workflow policy

Natural-language workflow generation is a draft path, not automatic trust:

1. author in a run/project-scoped path;
2. inspect the generated source;
3. type-check and reload;
4. inspect discovered inputs;
5. test success/failure/bound exhaustion;
6. require high-risk launch approval;
7. promote to reusable only after measured success.

## Workflow boundary

Use a workflow for production assurance, non-trivial dependencies, multiple candidate paths, long-running execution, evidence, repair loops, approvals, or resumability. Use direct execution for tiny deterministic low-risk work. Treat "quickly" as a latency preference, not a waiver of necessary safety.

## Intercom

Use Intercom for live, ad-hoc session handoffs or human steering. Use workflow edges, artifacts, and schemas for repeatable orchestration. Avoid large free-form agent chat swarms that spend context and tokens without stable state.
