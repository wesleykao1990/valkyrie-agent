# Atomic Masterclass Transcript Findings

**Reviewed:** 2026-08-11  
**Sources:** `XPQaoEZa9Y4.transcript.txt` and `pKzG2h5J7e0.transcript.txt`, supplied directly by Wesley.  
**Method:** The transcripts were reconciled against Atomic's official documentation and repository. Demonstrations and creator statements are separated from externally verified guarantees.

## Executive conclusion

The videos materially sharpen the operating model for this package:

1. Atomic should run as a **first-class verifiable agent runtime**, not as a thin wrapper inside Codex, Claude Code, or another coding-agent SDK.
2. The Atomic main session should act as the native meta-orchestrator and use the workflow tool to create, launch, observe, steer, pause, resume, and inspect workflow runs.
3. Skills and project context remain useful, but repeatable control flow, gates, retries, evidence, and final actions belong in versioned workflows.
4. Natural-language workflow generation is a strong bootstrap path, but the generated workflow is a draft that must be type-checked, reloaded, inspected, and tested before high-risk use.
5. Fresh reviewer contexts, artifact handoffs, deterministic probes, bounded repair, and explicit human gates are the central reliability pattern.
6. Atomic's session continuity features solve runtime working-memory problems; they do not replace Linear, Git, or the governed Project Brain.
7. The user should be able to state an idea, project, feature, bug, or review request in ordinary language. The skill should decide whether to explore, specify, execute directly, use a built-in workflow, or author a custom/composed workflow.

## Masterclass 1: architecture and theory

### Runtime, not another prompt wrapper

The first session defines Atomic as an environment that owns agent sessions, tools, models, state, workflow execution, durability, rate-limit handling, and model fallbacks. "Verifiable" means completion claims are backed by inspectable evidence such as checks, artifacts, and checkpoints rather than the implementing model's self-report.

**Package implication:** When Atomic is selected as root, Hermes or the control plane should launch an Atomic session and let Atomic own the graph. Codex and Claude Code remain alternative runtimes, comparison candidates, or explicitly integrated specialist tools; they should not drive Atomic node-by-node.

### Control theory as the workflow model

The speaker maps:

- acceptance criteria → desired set point;
- workflow policy → controller;
- agent and tools → actuator;
- repository/application → plant;
- tests, type checks, probes, and independent review → sensors;
- pass, repair, fail, and budget exhaustion → explicit controller states.

This is more useful than the slogan "use graphs." The design objective is stable feedback and inspectable control, not visual complexity.

**Package implication:** Every generated graph begins with a literal contract and explicit terminal states. A repair bound exhausted is a visible failure, never an implied success.

### Graph topology carries reliability

A transcript records what happened; a graph coordinates what may happen next. Stages are nodes, handoffs are edges, independent branches can run concurrently, evidence stays attached to the work that produced it, and human participation can pause or redirect execution.

**Package implication:** The workflow architect must prove dependencies instead of serializing everything. It should use bounded concurrency, fail-fast only when a failed branch invalidates the remaining graph, and isolate independent writers in separate worktrees.

### Verification as a system property

The sessions describe a recurring pipeline:

```text
proposal
→ deterministic measurement
→ fresh reviewer
→ decision/reducer
→ bounded repair
→ repeated measurement
→ human judgment where needed
```

TypeBox validates stage-output shape, but shape validity does not prove behavioral correctness. Tests, builds, runtime probes, browser automation, screenshots, recordings, and fresh reviewers serve different evidence roles.

**Package implication:** The skill must never count an author summary as evidence. It should derive task-specific probes from the contract and risk profile, run them through workflow-owned deterministic tools, and feed actual results—not paraphrases—to a fresh evaluator.

### Context engineering

The first session gives three important distinctions:

- **fresh context:** use for skeptical review and evaluation;
- **forked context:** use for implementers and repairs that benefit from continuity;
- **artifact handoff:** use files and structured outputs rather than dumping previous transcript tokens into the next stage.

The speaker argues that an author reviewing in the same context is biased toward its prior trace. Artifacts preserve useful evidence while avoiding irrelevant context and inherited assumptions.

**Package implication:** The default feature graph uses a forked implementation lineage, fresh verification contexts, and file-backed handoffs. Reviewer prompts receive the literal contract, relevant diff/files, and observed evidence—not the author's whole conversation.

### Verbatim compaction and durable continuation

The sessions explain Atomic's verbatim compaction: older lines are selectively removed while surviving lines remain mechanically unchanged, rather than being rewritten into a lossy summary. Atomic also supports protected `keepContext` spans and durable workflow/session continuation.

**Package implication:** Put only short, load-bearing constraints in `<keepContext>`: immutable acceptance criteria, non-goals, compatibility posture, and the final-action boundary. Do not protect large documents. Use artifacts for durable knowledge and let the Project Brain remain the canonical cross-run store.

### Steering and human control

The first session emphasizes that steering a long workflow is not the same as chatting with a model. Atomic uses deterministic continuation hooks so a stage does not answer a steering question and then silently stop. Pause, quit, resume, and stage connection are native workflow concerns.

**Package implication:** Hermes may collect a steering instruction, but the control plane must send it to the native Atomic run. It should not launch a second root workflow or reconstruct continuation logic itself.

### Intercom

Intercom provides peer-to-peer session messaging and model-generated handoffs. It can be useful when a human wants to connect active sessions or create an ad-hoc handoff without copying the whole context.

**Package implication:** Intercom is an operational communication primitive, not the default data plane for repeatable workflows. Stable workflow edges should use typed outputs and artifacts; Intercom is for live coordination where the topology is genuinely ad hoc.

## Masterclass 2: practical operation

### Low-friction setup and remote operation

The second session recommends running long tasks on a remote machine and using Herder, a terminal multiplexer oriented toward agent sessions, so an SSH disconnect does not end the operational view. This is a convenience layer, not a durability or security guarantee.

**Package implication:** For Wesley's architecture, Hermes remains the mobile front door and the control plane owns run state. Herder is optional for hands-on terminal supervision. A remote VM/container remains valuable for containment and uninterrupted execution.

### Base-agent features that matter to the workflow architect

The demonstration includes:

- file references and shell output injection;
- hashline editing;
- structured `ask_user_question` interaction;
- file-backed TODOs/working plans across compaction;
- session tree/fork/clone;
- session export and historical analysis;
- extensions, custom tools, commands, UI, and policy hooks.

**Package implication:** Use the structured question tool for contrastive decisions that materially change the contract. Use a run-local ledger/TODO artifact for long implementations. Treat session history as advisory working memory, not canonical project truth.

### The main chat as meta-orchestrator

The second session explicitly frames the main Atomic session as the orchestrator that can spawn and steer workflow sessions through Atomic's own workflow tool. Atomic does not need Claude Code or Codex to manage it.

**Package implication:** The full package's auto-router should invoke this skill inside Atomic's main session. The skill then selects or authors the workflow and launches it natively. In the Hermes path, the control plane starts one Atomic root session and forwards native events; Hermes remains the interface, not the orchestrator of individual stages.

### Skills and workflows are complementary

The sessions describe an evolution from prompts to skills to workflows/graphs. A skill is still useful for domain knowledge, judgment rules, and reusable instructions. A repeated "first do X, then Y, if failure Z" procedure is naturally a workflow because execution and evidence become inspectable and enforceable.

**Package implication:**

- Keep `AGENTS.md` and `CLAUDE.md` small: identity, project mapping, source precedence, and non-negotiable policy.
- Put domain knowledge and reusable judgment in skills/Project Brain resources.
- Put repeated process, gates, retries, side effects, and final actions in workflows.
- Convert mature Jobs/skills into versioned Atomic workflows when determinism and auditability matter.

### Create Spec and Prompt Engineer are the intent-alignment front end

The demonstrations repeatedly recommend using Atomic's Prompt Engineer and Create Spec skills to turn vague requests into precise objectives, constraints, compatibility posture, success criteria, and open questions. The ask-user interface allows the agent to present structured choices.

**Package implication:** For a high-cost or ambiguous implementation, the workflow architect first invokes or reproduces the Create Spec/Prompt Engineer discipline. It asks only questions whose answers change user behavior, public contracts, risk, architecture, irreversible effects, or material cost.

### Natural-language workflow generation

A live example asks Atomic in ordinary language to create a release-risk workflow. Atomic asks about scope, approval timing, and rejection behavior, writes the TypeScript workflow, and reloads it. The speaker characterizes natural-language generation as a strong "zero to 80%" path while acknowledging handcrafted workflows can be better.

**Package implication:** Generated workflows are treated as untrusted source drafts:

1. write to a project/run-scoped path;
2. inspect the diff;
3. type-check and reload;
4. confirm the discovered input contract;
5. test success, expected failure, and bound exhaustion;
6. require approval before a high-risk generated workflow writes production code;
7. promote to a reusable package only after repeated evaluation.

### When to use a workflow

The second session's practical rule is nuanced:

- use workflows when the task is complex, production assurance matters, multiple paths should be explored, or a repeatable process needs evidence;
- do not force a workflow for a trivial action such as a simple rebase when the engineer explicitly wants it done quickly;
- over time, lower inference cost may shift the boundary, so the router should be evaluated rather than frozen.

**Package implication:** Keep the score-based routing rubric and explicit `direct:`/`inline:` bypass. Treat words such as "quickly" as a soft low-latency preference, not as permission to skip necessary safety gates.

### Built-ins before bespoke graphs

The videos recommend starting with built-in Goal and Ralph workflows, then customizing workflows for the codebase. Ralph is described as research/orchestration/adversarial-review oriented; Goal is a durable objective-driven workflow. Other demonstrated patterns include adversarial panels, candidate tournaments, UI/design flows, PR babysitting, migrations, and nested subworkflows.

**Package implication:** Inspect installed workflow contracts at runtime. Use Goal for open-ended but contractable implementation, Ralph for research-first implementation and review, adversarial verification for proof, fan-out/synthesis for research, and custom parents when a built-in only partially fits.

### First-class runtime, not an SDK wrapper

The creator explains that early attempts to build Atomic as an extension/wrapper around OpenCode, Claude Code, Codex, or Copilot CLI failed because the design needed control over the full runtime. He then forked Pi and redesigned the runtime. This statement must not be misread as "Atomic has no SDK": Atomic's official product does expose an SDK and JSONL RPC for embedding/control. The point is that **Atomic itself cannot be faithfully recreated as a thin wrapper around another agent's SDK**.

**Package implication:** Our control plane may use Atomic's SDK or RPC to start and observe Atomic. It must not reimplement Atomic's scheduler or place Atomic underneath a coding-agent wrapper that owns the root lifecycle.

### Incremental delivery and stacked changes

The sessions discuss splitting very large changes into smaller PRs/stacks and verifying each phase before advancing. This reduces review risk and prevents a huge, opaque diff from becoming the only integration unit.

**Package implication:** The feature/migration playbooks should prefer vertical slices or dependency-aware waves, with per-slice evidence and explicit compatibility contracts. A workflow should be able to stop after a draft PR/stack rather than automatically merge.

## Claims that are not treated as guarantees

The streams include anecdotal claims such as high merge rates, hours saved per ticket, low token cost per ticket, and defects/outages caught in particular projects. The speakers also describe proposed research framing such as recursive state machines outperforming RLMs.

These are useful hypotheses but are not product guarantees. The skill therefore requires project-specific measurements:

- completion and merge rate;
- seeded/real defect catch rate;
- review burden;
- time to useful result;
- token and monetary cost;
- number of repair loops;
- resume/recovery success;
- workflow-authoring maintenance cost.

## Decisions incorporated into version 0.2.0

1. Atomic is treated as a first-class root runtime.
2. The Atomic main session is the native meta-orchestrator.
3. Idea and project requests default to read-only decision/blueprint workflows.
4. Explicit feature/bug implementation requests launch the smallest complete workflow after contract resolution.
5. Prompt Engineer/Create Spec discipline is used for ambiguity and expensive work.
6. Acceptance criteria and final-action boundaries are protected with `keepContext` when needed.
7. Fresh reviewers, forked implementers, and artifact handoffs are mandatory defaults for consequential work.
8. Dynamic workflow source is gated, tested, and promoted separately from one run.
9. Intercom and session history are operational aids, not canonical memory.
10. `AGENTS.md`/`CLAUDE.md` remain small bootstraps; repeatable process moves into workflows.
11. Herder is optional; Hermes/control-plane visibility remains primary.
12. Anecdotal performance claims are excluded from routing policy until measured in Wesley's projects.
