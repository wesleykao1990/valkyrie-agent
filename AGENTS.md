# Agent instructions

This repository is a prototype of a mobile-first multi-agent project operating system.

## Authority rules

1. Linear will be authoritative for roadmap and issue status.
2. Git and executable checks are authoritative for code behavior.
3. Accepted Markdown under `project-brain/Projects/**/Decisions/` is authoritative for project rationale.
4. Episodic memory is advisory and must not override live status or accepted decisions.
5. The control plane owns stable run IDs, budgets, approvals, workspace leases, and normalized events.
6. A native runtime owns its internal stage/session state.

## Engineering rules

- Preserve one root runtime per run.
- Preserve the storage, runtime-adapter, project-brain, and workspace boundaries.
- Do not let Hermes receive raw process, container, credential, or filesystem-management tools.
- Do not silently promote agent findings into canonical project knowledge.
- Mutations must be idempotent or carry an idempotency key.
- Keep native runtime payloads alongside normalized events.
- Every writing candidate needs a separate workspace and one writer lease.
- Never add production secrets to demo data, prompts, artifacts, or memory.

## Prototype constraints

- The current demo is dependency-free and runs directly on Node 22 with TypeScript stripping.
- SQLite is a prototype adapter. Production target is PostgreSQL.
- Mock runtimes demonstrate lifecycle behavior. Real runtime adapters should be added behind the existing interface.
- Project-brain retrieval is read-only first. Automatic episodic capture is intentionally deferred.

## Before changing code

1. Read `.project-context.yaml`.
2. Read `docs/DECISIONS.md`.
3. Read `docs/ARCHITECTURE.md`.
4. Read `SECURITY.md` before enabling a real runtime.
5. Read the relevant section of `docs/CONTINUATION_PLAN.md`.
6. Run `npm run verify` before and after the change.
7. Record meaningful architectural changes as a proposed ADR; do not rewrite accepted decisions silently.
