# Current architecture decisions — through v0.3.0

## Accepted

### D-01 — Hermes is the primary interface

Hermes is the mobile front door for idea capture, portfolio briefings, run control, notifications, and approvals. Chat is not a system of record; Hermes assembles answers from current sources.

### D-02 — Linear is the canonical roadmap

Linear owns initiatives, projects, issues, dependencies, priorities, owners, and statuses. Hermes Kanban may be used for temporary internal decomposition only.

### D-03 — Git/GitHub is code and delivery truth

The current branch, executable checks, PR review, and merge history determine what exists and what shipped.

### D-04 — Build a thin TypeScript modular monolith

The custom layer owns cross-system guarantees only: stable IDs, adapters, policy, budgets, approvals, workspace leases, artifacts, and event normalization. It does not invent another workflow DSL.

### D-05 — One root runtime per run

Atomic, Prime, Hermes, Codex, or Claude may own a root run, but only one controls the lifecycle. Child work is bounded and returns an artifact or structured result.

### D-06 — Direct Codex and Claude paths remain available

Small edits, focused reviews, or comparison candidates should not be forced through Atomic. They still use isolated workspaces and the same control-plane policy.

### D-07 — Two-layer project knowledge architecture

A Git-backed Obsidian vault stores reviewed canonical knowledge. A replaceable retrieval service supplies task-scoped context and episodic memory. The architecture is accepted; OpenViking is the first candidate backend, not an irreversible dependency.

### D-08 — Read-only retrieval comes before automatic capture

The first memory release indexes accepted vault notes and evaluates retrieval, namespace isolation, staleness, deletion, and context usefulness. Automatic episodic capture is deferred until those checks pass.

### D-09 — Agents propose; humans promote canonical knowledge

Agent run summaries and findings may create memory proposals. Architecture, product policy, API contract, and workflow-rule changes require evidence and explicit promotion.

### D-10 — Personal-memory authority is explicit

Current user instruction outranks the curated user profile, which outranks prior explicit preferences, which outrank inferred episodic memory. Inferred memory may not silently edit the curated profile.

### D-11 — Separate workspace and one writer lease per candidate

Each coding candidate receives its own worktree and external container or VM. A runtime must hold the writer lease before modifying the workspace.

### D-12 — Telegram first for the pilot

Telegram is the default first Hermes channel because it is a low-friction control surface. The channel is configurable and LINE can be added later without changing architecture.

### D-13 — No custom portfolio dashboard in the first production slice

Hermes chat supplies concise briefings and actions; Linear supplies the visual roadmap. This prototype includes a developer console for validation, not as the authoritative user interface.

### D-14 — Hybrid knowledge location

Cross-project vision, research, and product rationale live in the central private vault. Code-coupled ADRs, API contracts, runbooks, and repository instructions live near the code. The Project Brain indexes both with source and revision metadata.

### D-20 — Public repository with a nested license boundary

Wesley explicitly authorized public visibility for `wesleykao1990/valkyrie-agent`
on 2026-08-11. The root MIT license applies only within its grant. The nested
`packages/atomic-workflow-architect/` `UNLICENSED`/all-rights-reserved notice is
preserved, and public visibility does not grant additional use or redistribution
rights for that subtree.

## Proposed / pilot-gated

### D-15 — Atomic is the default non-trivial engineering runtime

Atomic is the leading candidate because of explicit graphs, evidence, fresh verification, gates, and resumability. It becomes the default only after an A/B pilot against direct Codex/Claude paths measures quality, time, cost, review burden, and recovery.

### D-16 — OpenViking is the first machine-memory candidate

Start behind the Project Brain interface in read-only mode. Promote it only if retrieval quality, project isolation, deletion, privacy, and operational reliability meet acceptance thresholds.

### D-17 — Docker/devcontainer is adequate for the first non-sensitive pilot

The pilot runner has no production secrets and handles a medium-risk repository task. Remote micro-VM isolation remains the escalation path for confidential or high-risk workloads.

### D-18 — Transactional asynchronous storage boundary

SQLite remains the default demo adapter and PostgreSQL is the opt-in production candidate. The proposed boundary, migration ownership, idempotency semantics, transactional outbox, and reconciliation behavior are detailed in `docs/adr/ADR-P001-transactional-storage-boundary.md`. This remains proposed until Wesley accepts the listed invariants and delivery semantics.

### D-19 — Imported Atomic module and decision reconciliation

The Atomic Workflow Architect source is integrated as an inert, independently testable module, not as the whole Project OS and not as an enabled runtime. Its imported addendum is evidence for reconciliation rather than a second canonical decision registry. See `docs/adr/ADR-P002-atomic-package-boundary.md`.

### D-21 — Read-only native connectivity before writer execution

Atomic offline discovery and direct Codex/Claude model connectivity may be tested
only behind disabled-by-default adapters, bearer-authenticated loopback API/MCP,
exact version gates, bounded context contracts, and `analysis_only` final actions.
Direct prompts are fixed connectivity markers. This does not authorize a writer,
Atomic model workflow, mobile ingress, PR, merge, deployment, or canonical-memory
promotion. See `docs/adr/ADR-P003-read-only-native-runtime-pilot.md`; the boundary
remains proposed until Wesley accepts or amends it.

### D-22 — Fenced external writer boundary before model writes

Every real writer uses a private per-run Git root, one exact owner/fencing-token
lease with host-owned heartbeat, and a disabled-by-default external container/VM
provider. The first Docker-compatible provider requires an immutable local image,
no network or ambient credentials, effective-policy inspection, bounded resource
use, explicit secret-scanned artifact export, and stop/cleanup before exact-fence
release. Contract tests do not authorize writer mode. The local Colima/Docker
fixture smoke and provider-aware restart contracts now pass, but runtime
composition still requires the separately reviewed Milestone 5 launch, egress,
and credential policy. See
`docs/adr/ADR-P004-external-writer-boundary.md`; the boundary remains proposed
until Wesley accepts or amends it.

### D-23 — Risk-based Direct, Atomic Lite, and Atomic Full routing

Hermes may collect the literal request and express a latency/rigor preference,
but the control plane owns the final execution-shape decision after resolving
current Linear, Git/check, and Project Brain context. The proposed deterministic
rubric selects the smallest complete shape: Direct for small low-risk work,
Atomic Lite for a persistent implementer plus deterministic checks and conditional
review, and Atomic Full for hard workflow signals, high risk, iteration,
independent candidates, durability, or evidence/approval gates. A preference may
increase rigor but cannot weaken policy. See
`docs/adr/ADR-P009-risk-based-execution-shapes.md`. The authenticated assessment
ledger and reusable package-level Lite contract are implemented, but general
execution remains fail-closed until live Linear/Git authority and a trusted
project launcher exist.

## Deferred

- Prime Agent until long-horizon benchmark tasks show incremental value.
- Orca integration until live parallel-agent supervision is a repeated pain point.
- Buzz until multi-person and persistent-agent collaboration requires a shared event workspace.
- Linear AgentSession preview integration until ordinary issue/comment projection is reliable.
- Automatic canonical-memory promotion.
