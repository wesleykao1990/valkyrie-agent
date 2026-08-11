# Architecture

## Recommended system

```text
Wesley on mobile
      |
      v
Hermes messaging and approvals
      |
      +---- Linear: roadmap and live work truth
      +---- Project Brain: accepted vault knowledge + read-only retrieval pilot
      +---- Control-plane MCP: runs, approvals, budgets, evidence
                         |
                         v
              Thin TypeScript control plane
              - stable IDs
              - routing policy
              - run registry
              - approval service
              - workspace leases
              - normalized events
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
     Atomic          Codex/Claude         Prime
 pilot workflow      bounded workers   long research
       |                 |                  |
       +-----------------+------------------+
                         |
                         v
              isolated workspaces / GitHub
```

## Authority boundaries

- **Hermes** owns conversation, mobile notification, and user-facing summaries.
- **Linear** owns initiatives, projects, issues, dependencies, and work status.
- **Git/GitHub** owns source code, PRs, CI, and accepted delivery history.
- **Control plane** owns cross-runtime run IDs, policies, approvals, budgets, workspace leases, and normalized event projections.
- **Native runtime** owns its internal workflow/session state.
- **Obsidian/Git vault** owns accepted project rationale and enduring knowledge.
- **Machine memory** supplies retrieved or episodic context but cannot override live or accepted sources.

These are domain authorities, not one global precedence list. Linear controls
roadmap and work state; Git and executable checks control implementation truth;
accepted Project Brain Markdown controls project rationale and decisions. Current
explicit user instruction controls intent but does not silently rewrite recorded
external state.

## Storage boundary

The control plane uses one asynchronous store contract with two adapters:

- SQLite is the local, zero-service demo backend.
- PostgreSQL is opt-in and supplies the production-candidate transaction and
  concurrency semantics.

Both adapters own explicit versioned migrations, lifecycle idempotency records,
and a transactional outbox. Selecting PostgreSQL never silently falls back to
SQLite, and there is no dual-write or automatic data copy between them. The
outbox is durable state in this milestone; an external broker/publisher is not.

## Atomic module boundary

`packages/atomic-workflow-architect/` contains the Atomic-specific skill, router,
prompts, launch contract, and workflows. It is independently verifiable source,
not the whole Project OS. Its presence does not install Atomic, register a live
adapter, or alter runtime routing. The control plane continues to own stable run
IDs, policy, budgets, approvals, context/workspace references, normalized events,
and artifacts; a future Atomic main session must own its native workflow graph,
stage sessions, checkpoints, human-input state, and verified resumability.

## Prototype substitution

The production architecture uses PostgreSQL and a read-only OpenViking trial. The
downloadable prototype defaults to SQLite and local Markdown retrieval so it can
run without external credentials. PostgreSQL now exists behind the store contract;
OpenViking and real runtime adapters remain disabled continuation work.


## A/B pilot path

The prototype exposes `run_compare` to launch Atomic, Codex, and Claude candidates for one objective. Each candidate receives a separate workspace and writer lease, and every run carries the same comparison ID. Evidence and completion are recorded independently; a human selection remains a separate decision. This implements the current decision that Atomic is a proposed default rather than an untested assumption.
