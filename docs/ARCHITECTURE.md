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
not the whole Project OS. Its presence alone does not install Atomic, register an
adapter, or alter routing. An explicitly configured pilot adapter can start pinned
Atomic 0.9.12 for credential-free offline RPC/package discovery. The control plane
continues to own stable run IDs, policy, budgets, approvals, context/workspace
references, normalized events, and artifacts; Atomic's main session owns native
session/workflow state. Model workflow, HIL mapping, and cross-process durability
remain unverified and disabled.

## Native connectivity boundary

Native adapters are disabled by default and require bearer-authenticated API/MCP.
The minimum pilot admits only `workflow=runtime-connectivity`: Atomic discovers
the pinned module offline; direct Codex/Claude accept fixed marker-only objectives
and use read-only/bare process modes. Complete native JSONL records are persisted
before normalized projections. Context packs and run contracts are bounded,
checksummed workspace artifacts. Every pilot final action is `analysis_only` and
`crossProcessResume=false`.

This boundary is not a writer sandbox. A later external container/VM provider,
lease heartbeat/fencing, network/filesystem policy, artifact secret scan, and
cleanup must be verified before any native adapter may edit a repository.

## Prototype substitution

The production architecture uses PostgreSQL and a read-only OpenViking trial. The
downloadable prototype defaults to SQLite and local Markdown retrieval so it can
run without external credentials. PostgreSQL now exists behind the store contract;
OpenViking and writer runtimes remain disabled continuation work. Read-only native
connectivity adapters exist only behind explicit feature flags and the proposed
ADR-P003 boundary.


## A/B pilot path

The prototype exposes `run_compare` to launch Atomic, Codex, and Claude candidates for one objective. Each candidate receives a separate workspace and writer lease, and every run carries the same comparison ID. Evidence and completion are recorded independently; a human selection remains a separate decision. This implements the current decision that Atomic is a proposed default rather than an untested assumption.
