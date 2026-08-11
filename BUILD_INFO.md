# Build information

- Package: Wesley Agent Control Plane Prototype
- Version: 0.2.2
- Built: 11 August 2026
- Minimum runtime: Node.js 22.16
- External credentials bundled: none
- Default runtimes: local lifecycle simulations
- Default data store: local SQLite prototype adapter
- Production target: PostgreSQL, authenticated Hermes MCP, Linear integration, read-only OpenViking evaluation, real isolated runtime adapters

## Verification performed before packaging

```bash
npm run verify
```

This runs 10 automated tests, the full HTTP lifecycle smoke test, and the Hermes MCP smoke test from clean temporary data directories. The source also passed `tsc --noEmit`; the included Git bundle was cloned cleanly and the clone passed the same verification command.

## Continuation entry points

1. `START_HERE.md`
2. `.project-context.yaml`
3. `AGENTS.md` and `CLAUDE.md`
4. `docs/DECISIONS.md`
5. `docs/CONTINUATION_PLAN.md`
6. `docs/PROMPT_FOR_CODEX_OR_CLAUDE.md`
7. `docs/GIT_HANDOFF.md`

The first recommended implementation milestone is the PostgreSQL adapter, retaining SQLite as the zero-dependency demo backend.
