# Native Durability and Workspace Ownership

## Atomic durability

Atomic durable workflows use DBOS/PostgreSQL. An existing database can be supplied with `DBOS_SYSTEM_DATABASE_URL`. When no durable backend is active, a process-local fallback may keep the current process usable but does not satisfy cross-process resume.

For any background/resume promise:

1. verify durable backend state;
2. retain Atomic session/workflow IDs and workflow hash/version;
3. use stable serializable `ctx.tool` arguments;
4. make external side effects idempotent even when completed tool calls replay from cache;
5. reconcile native run state after control-plane restarts.

Terminal multiplexers such as Herder keep a terminal session accessible; they are not workflow durability.

## Dual continuity

Atomic may preserve both:

- graph/node checkpoint progress;
- active stage/session continuity.

The control plane should not attempt to reproduce either from summaries. It stores references and normalized projections.

## `ctx.tool` ownership

Use `ctx.tool` for workflow-owned deterministic work/side effects such as tests, builds, schema checks, API writes, artifact generation, or repository operations. Completed calls can replay from durable cache. Expected check failures should return structured evidence for repair rather than disappear into prose.

Do not use `ctx.tool` for pure transformations or ordinary model stages. Forward abort/cancellation signals for long operations.

## Worktree ownership

Choose exactly one top-level owner:

- **Standalone Atomic:** Atomic native worktree bindings inside an external sandbox.
- **Control-plane run:** control plane creates worktree/container/writer lease; Atomic runs inside it and may create only explicitly authorized child candidate worktrees.

Never let both layers believe they own cleanup or the same branch lifecycle.

## Nested candidates

```text
control-plane sandbox/root
  ├─ candidate worktree A → Atomic run A
  ├─ candidate worktree B → Atomic run B
  └─ read-only evaluator/reducer
```

or use Atomic-native candidate worktrees under one standalone sandbox. Every writer has a distinct branch/worktree and failure boundary.

## Incremental delivery

For large features/migrations, prefer dependency-aware slices or stacked PRs. Prove each slice before downstream work depends on it. Stop at draft PR unless merge was explicitly authorized.
