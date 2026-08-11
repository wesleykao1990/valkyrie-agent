# Start here

1. Read `README.md` for the runnable demo.
2. Read `.project-context.yaml` for the repository bootstrap and current pilot posture.
3. Review `docs/Agentic_Development_Control_Plane_Architecture_Review_v0.2.2.docx` for the current decisions and reasoning.
4. Read `docs/DECISIONS.md` for accepted, proposed, and deferred architecture choices.
5. Read `docs/IMPLEMENTATION_PLAN_M1_M2.md` for the current milestone scope and rollback posture.
6. For Atomic-specific work only, then read `packages/atomic-workflow-architect/START_HERE.md`, its `skills/atomic-workflow-architect/SKILL.md`, and the relevant integration guide. That package is a module, not the whole Project OS, and it is not a live runtime.
7. Read `docs/STORAGE.md` before selecting PostgreSQL. Install locked dependencies
   with `npm ci`, then run `npm run verify` (full verification requires local
   PostgreSQL 16 `initdb`/`pg_ctl` tools for its disposable cluster).
8. Start the developer console with `./bin/project-os-server`.
9. Open `http://127.0.0.1:8787`.
10. For Hermes, register `bin/project-os-mcp` as a local stdio MCP server.
11. Read `docs/GIT_HANDOFF.md` to understand the original handoff history.
12. For continued implementation, use `docs/NEXT_SESSION_PROMPT.md` rather than
    the superseded package prompt.

The web page is a developer inspection console. Hermes remains the intended user interface and Linear remains the roadmap authority.
