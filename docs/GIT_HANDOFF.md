# Git handoff

## Hosted repository

The continuation target is:

```text
https://github.com/wesleykao1990/valkyrie-agent
```

Wesley explicitly selected public visibility on 2026-08-11. The nested Atomic
module retains its separate all-rights-reserved notice; public visibility does not
extend the root MIT license to that subtree.

The `0.3.0` work is developed on:

```text
agent/postgres-atomic-integration
```

The restored `0.2.2` handoff history is the base of `main`; the feature branch is
intended for a draft pull request after final verification.

## Original offline history

The continuation input included the verified Git bundle:

```text
handoff/Wesley_Agent_Control_Plane_Prototype_v0.2.2.bundle
```

It preserved the complete three-commit `0.2.2` history and was used to restore this
working repository rather than starting a new project.

## Fresh checkout verification

```bash
git clone https://github.com/wesleykao1990/valkyrie-agent.git
cd valkyrie-agent
npm ci
npm run verify
```

Full verification requires PostgreSQL 16 `initdb` and `pg_ctl` for its disposable
local cluster.

Do not commit provider tokens, `.env`, local SQLite databases, temporary PostgreSQL
clusters, generated workspaces, or run artifacts.
