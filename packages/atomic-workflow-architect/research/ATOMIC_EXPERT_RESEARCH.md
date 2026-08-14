# Atomic Expert Research Dossier

**Version:** 0.2.0  
**Reviewed:** 2026-08-11  
**Basis:** Bastani product site, `llms.txt`, official documentation, `bastani-inc/atomic` repository/source, current release metadata, and both supplied masterclass transcripts.  
**Architecture context:** Wesley's Agentic Development Control Plane decisions remain authoritative for Hermes, Linear, Git, Project Brain, security, and cross-runtime ownership.

## Executive conclusion

Atomic is best understood as a **verifiable coding-agent runtime and engineering control-loop engine**. It is not merely a CLI coding agent, a bag of prompts, a generic graph library, or a project-management system.

Its distinctive value is that the engineering process becomes executable and inspectable:

- literal run contracts;
- TypeScript workflow policy;
- dynamic acyclic graphs;
- independent/forked stage contexts;
- typed inputs/outputs;
- deterministic tools/checks;
- file-backed artifacts;
- fresh verification;
- bounded repair;
- human input and final-action gates;
- pause/quit/resume and durable checkpoints;
- model/provider routing and fallbacks.

For Wesley's stack, Atomic should be a **first-class root runtime** for non-trivial engineering work. Hermes remains the mobile interface, Linear owns roadmap/work status, Git/checks own implementation truth, the Project Brain owns accepted rationale, and the thin control plane owns stable cross-runtime IDs, authentication, budgets, workspace leases, containment, and approval records.

Atomic remains pilot-gated. The videos provide detailed creator rationale and demonstrations, but some performance claims are anecdotal. Default adoption should follow a representative Ovalo evaluation.

## 1. What Atomic is

### 1.1 Runtime ownership

Atomic owns the environment in which agent work executes: sessions, tools, models, context state, workflow graph, checkpoints, and native control. The masterclass frames this like Node/Bun for agent work rather than another prompt template.

The creator explains that early attempts to implement Atomic by wrapping OpenCode, Claude Code, Codex, or Copilot CLI were insufficient because the design required control over the full runtime. Atomic was therefore built as a Pi-derived/superset runtime.

This statement does **not** mean Atomic has no SDK. Official Atomic provides both:

- a TypeScript SDK for embedding;
- strict JSONL RPC for process integration.

The correct interpretation is:

> Use Atomic's own SDK/RPC to run Atomic. Do not try to recreate Atomic as a thin wrapper around another agent SDK.

### 1.2 Verifiable runtime

A model's completion claim is a proposal, not proof. Atomic provides primitives for evidence such as:

- tests, type checks, lint, builds;
- runtime/API/CLI probes;
- browser automation, screenshots, recordings;
- typed stage results;
- diff/commit/worktree state;
- independent reviewers and reducers;
- artifacts and checkpoints;
- human approval.

Correctness remains task-specific. Atomic makes verification structural; it does not magically know the right acceptance criteria.

### 1.3 Control theory and graph topology

The masterclass maps software-agent workflows to a control system:

| Control concept | Agent engineering equivalent |
|---|---|
| set point | acceptance criteria |
| controller | workflow policy |
| actuator | agent and tools |
| plant | repository/application/environment |
| sensor | tests, checks, probes, independent review |
| feedback | pass/failure/evidence |
| controller state | repair, fail, await human, stop at budget |

A transcript records work; a graph coordinates dependencies, readiness, evidence, parallelism, and control. Reliability comes from the topology and sensors, not from drawing a graph for its own sake.

## 2. Atomic's execution shapes

Atomic should not use the same shape for every request.

1. **Direct/inline:** tiny deterministic low-risk work.
2. **Inline plus bounded subagents:** parent-controlled independent research or analysis that does not need a durable graph.
3. **Named built-in/installed workflow:** whole-task contract matches an existing workflow.
4. **Custom workflow:** task-specific control/evidence is required.
5. **Composed/nested workflow:** reusable child workflows solve parts of a larger process.

Official workflow guidance defaults to workflows for non-trivial work with inherent structure and a verifiable objective, while reserving direct chat for tiny deterministic low-risk tasks.

The masterclass adds a pragmatic cue: a simple operation such as a rebase may not justify a workflow when the user explicitly wants it done quickly. This remains a soft latency preference, not a waiver of required safety.

## 3. Built-ins and reusable patterns

Current documentation/source includes composable patterns such as:

- classify-and-act;
- fan-out-and-synthesize;
- adversarial verification;
- generate-and-filter;
- tournament;
- loop-until-done;
- Goal;
- Ralph;
- Open Claude Design.

The videos also demonstrate or discuss installable/reusable workflows for PR babysitting, migrations, skill-to-workflow conversion, release gates, and stacked/incremental delivery.

Operational mapping:

- **Goal:** durable objective-driven implementation when the target is clear.
- **Ralph:** research/spec refinement, orchestration/implementation, and bounded multi-model review.
- **Adversarial verification:** prove/reject a candidate or diff.
- **Fan-out/synthesis:** broad repository/research uncertainty.
- **Tournament:** compare whole candidate approaches/implementations.
- **Open Claude Design:** human-guided visual design/refinement.
- **Custom parent:** when no built-in covers the entire contract.

Workflow contracts must be inspected at runtime. Names, packages, and inputs evolve.

## 4. Natural-language workflow generation

The second masterclass demonstrates asking Atomic in natural language to create a release-risk workflow with a deterministic human gate. Atomic asks about:

- what pending changes mean;
- when approval fires;
- what rejection produces;
- risk classification and outputs.

It then authors TypeScript and reloads the workflow. The speaker describes this as a strong zero-to-80-percent bootstrap while noting handcrafted workflows can be better.

Recommended governance:

```text
natural-language draft
→ project/run-scoped workflow source
→ inspect diff
→ TypeScript validation
→ /workflow reload
→ inspect discovered inputs
→ test success/failure/HIL/bound exhaustion
→ approved project workflow
→ repeated evals
→ reusable package release
```

A self-modifying workflow may repair a run-scoped draft, but it must surface the source diff. It cannot silently rewrite the canonical future workflow.

## 5. Intent alignment and specification

The videos place unusual emphasis on precise intent before long autonomy. Relevant native resources include:

- structured `ask_user_question` UI;
- Prompt Engineer skill;
- Create Spec skill;
- codebase research skills/subagents;
- file-backed plans/TODOs.

The Create Spec discipline is particularly valuable for:

- compatibility posture;
- public doors/entrypoints;
- non-goals;
- irreversible effects;
- success criteria;
- constraints and open questions.

The workflow architect should ask only material questions. A question is material when it changes product behavior, public contracts, security/privacy, compatibility, architecture lock-in, irreversible effects, proof, final action, or significant spend.

## 6. Context engineering

### 6.1 Fresh versus forked

- **Fresh context:** reviewer/evaluator sees only the contract, relevant files/diff, and evidence. This reduces authorship/trace bias.
- **Forked context:** implementer/repair stage retains its own continuity and avoids rediscovery.

### 6.2 Artifact handoffs

The strongest handoff is not "copy all tokens into the next prompt." It is:

```text
contract artifact
research artifact
implementation notes
deterministic check results
review report
repair payload
```

Downstream stages read only what they need. This reduces context noise and makes evidence inspectable.

### 6.3 Verbatim compaction

Official Atomic compaction mechanically reconstructs retained transcript lines. The planner selects deletion ranges; surviving lines are not rewritten. Important features include:

- configurable `compression_ratio`;
- `preserve_recent` message tail;
- automatic/manual compaction;
- fallback planner models;
- mechanically protected `<keepContext>` spans.

Use `keepContext` for short constraints/invariants, not whole documents. A fallback planner may receive the compactable transcript, so privacy/provider policy matters.

### 6.4 Session working memory

Atomic includes session tree/fork/clone, session export/history analysis, file-based TODOs, and Intercom messaging.

These solve active-run continuity, not project authority:

- Atomic session → what this run is doing/attempted;
- Linear → current work state;
- Git/checks → current behavior;
- Project Brain → accepted durable rationale.

## 7. Verification and repair

Recommended consequential-work loop:

```text
literal contract
→ candidate implementation
→ fresh verifier derives probes
→ deterministic tools run probes
→ fresh evaluator reads actual evidence
→ reducer creates one repair payload
→ forked implementer repairs
→ same probes rerun
→ pass or visible bound exhaustion
→ separate final-action gate
```

Type/schema validation proves shape, not behavior. Different reviewer personas should target distinct risk surfaces rather than repeat one another.

Final actions—PR creation, merge, release, deploy, publication—must be separable from implementation acceptance. Once implementation criteria pass, the repair loop should stop and expose the remaining action as a gate.

## 8. Model routing

Atomic publishes role-based model guidance tied to coding-agent and intelligence benchmarks. The durable policy is:

- spend on high-accuracy judgment/planning/debugging where a wrong decision is expensive;
- use cost-efficient workhorses for research, implementation, orchestration, and repair;
- use cheap models for mechanical work backed by deterministic checks;
- use provider diversity for independent review when it decorrelates errors;
- treat unmeasured as unmeasured;
- update policy from workflow-specific project evals.

Separate fields must record:

```text
runtime = atomic / codex / claude-code
provider = openai / anthropic / ...
model = provider-specific ID
reasoning level
role = planner / worker / verifier / reducer
```

An Anthropic model stage inside Atomic is not automatically a Claude Code CLI run.

## 9. Skills, workflows, and bootstrap files

The masterclasses describe an evolution from prompts to skills to workflows/graphs.

Recommended split:

- `AGENTS.md`/`CLAUDE.md`: small bootstrap, project mapping, authority, non-negotiable policy.
- Skill/Project Brain: domain knowledge, references, interpretation, quality standards.
- Workflow: repeated procedure, dependencies, gates, retries, side effects, final actions.

A mature step-by-step skill or Obsidian Job is a candidate workflow source. The skill remains useful as context within the workflow.

## 10. Intercom and multi-agent communication

Intercom is useful for ad-hoc peer-to-peer session handoffs and live steering. It can generate a concise handoff from a long session and send it to another active session.

Do not use free-form multi-agent conversation as the default orchestration model. The transcript notes high messaging/context overhead in agent chat swarms. Repeatable work should use explicit graph edges, artifacts, schemas, and bounded stages.

## 11. Durability and workspace management

Atomic workflows can use DBOS/PostgreSQL for durable checkpoints. The first pilot must verify the actual durable backend; a process-local fallback cannot support cross-process recovery claims.

Atomic can bind workflows/stages to worktrees. Our boundary:

- **Standalone Atomic:** Atomic may own worktree setup inside an external sandbox.
- **Control-plane run:** control plane owns top-level worktree/container/writer lease; Atomic runs inside it and may create only authorized child candidate worktrees.

Herder or another multiplexer helps maintain/reattach terminal sessions on a remote machine. It is optional operator UX, not durability, authority, or security.

## 12. Security

Atomic packages, extensions, workflows, and tools run with process authority. Required external controls:

- sandbox/container/VM;
- scoped mounts and one writer lease;
- short-lived credentials;
- network/tool/command policy;
- secret scanning/redaction;
- package/workflow pinning and provenance;
- cost/time/child-depth limits;
- authenticated human approval.

Extensions can block commands and provide policy hooks, but remain defense-in-depth because extension code itself is privileged.

## 13. Integration with Wesley's control plane

```text
Wesley on mobile
→ Hermes resolves request/project/task
→ control plane builds context pack and policy
→ control plane creates isolated workspace + stable run ID
→ Atomic RPC starts main session
→ auto-router invokes atomic-workflow-architect
→ skill selects/authors/launches native workflow
→ native events/artifacts projected to Hermes/Linear
→ user approvals/steering sent to native run
→ result/PR/evidence
→ governed memory/workflow proposal
```

The control plane must preserve native events and capabilities; it must not reconstruct graph state from prose.

## 14. Automatic behavior for Wesley

The package implements these defaults:

| Request | Default action |
|---|---|
| Rough idea | `idea-to-decision`, no code |
| New project | `project-blueprint`/`request-preflight`, first slice only |
| Explicit non-trivial feature | contract/spec → smallest complete Atomic workflow |
| Bug | reproduce → regression proof → repair → fresh verification |
| Migration/refactor | inventory → compatibility/rollback → bounded waves |
| Review/research | fan-out evidence → synthesis/adversarial review |
| Compare implementations | separate writer worktrees → read-only tournament/reducer |
| Tiny deterministic edit | direct path |

`direct:`/`inline:` bypasses the workflow architect. `atomic:`/`workflow:` forces it.

## 15. Evaluation plan

Before promoting Atomic from proposed to default, compare an Atomic path with direct Codex/Claude execution on representative tasks.

Measure:

- contract adherence;
- seeded/real defect catch rate;
- test/evidence completeness;
- merge/readiness rate;
- reviewer time and cognitive load;
- elapsed time;
- token/monetary cost;
- repair iterations;
- resume/recovery success;
- workflow-authoring and maintenance effort;
- cross-project context leakage;
- unsafe/unauthorized action rate.

Anecdotal stream metrics—merge rate, hours saved, cost per ticket, defects/outages caught—are not accepted as baseline truth.

## 16. Package changes in 0.2.0

- Incorporated both masterclass transcripts.
- Reframed Atomic as a first-class root runtime.
- Added main-session meta-orchestrator guidance.
- Added Create Spec/Prompt Engineer intent alignment.
- Added generated-workflow trust/promotion lifecycle.
- Added keepContext/session-memory/Intercom policy.
- Added skill-to-workflow and minimal-bootstrap guidance.
- Added `request-preflight` workflow.
- Added architecture decision addendum and transcript findings.
- Removed the pending-video limitation.
