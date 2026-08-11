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

## Prototype substitution

The production architecture uses PostgreSQL and a read-only OpenViking trial. This downloadable prototype uses SQLite and local Markdown retrieval so it can run with no external package installation or credentials. Both are behind explicit interfaces and are the first replacement tasks in the continuation backlog.


## A/B pilot path

The prototype exposes `run_compare` to launch Atomic, Codex, and Claude candidates for one objective. Each candidate receives a separate workspace and writer lease, and every run carries the same comparison ID. Evidence and completion are recorded independently; a human selection remains a separate decision. This implements the current decision that Atomic is a proposed default rather than an untested assumption.
