# Current architecture decisions — v0.2.2

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

## Proposed / pilot-gated

### D-15 — Atomic is the default non-trivial engineering runtime

Atomic is the leading candidate because of explicit graphs, evidence, fresh verification, gates, and resumability. It becomes the default only after an A/B pilot against direct Codex/Claude paths measures quality, time, cost, review burden, and recovery.

### D-16 — OpenViking is the first machine-memory candidate

Start behind the Project Brain interface in read-only mode. Promote it only if retrieval quality, project isolation, deletion, privacy, and operational reliability meet acceptance thresholds.

### D-17 — Docker/devcontainer is adequate for the first non-sensitive pilot

The pilot runner has no production secrets and handles a medium-risk repository task. Remote micro-VM isolation remains the escalation path for confidential or high-risk workloads.

## Deferred

- Prime Agent until long-horizon benchmark tasks show incremental value.
- Orca integration until live parallel-agent supervision is a repeated pain point.
- Buzz until multi-person and persistent-agent collaboration requires a shared event workspace.
- Linear AgentSession preview integration until ordinary issue/comment projection is reliable.
- Automatic canonical-memory promotion.
