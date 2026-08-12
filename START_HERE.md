# Start here

1. Read `README.md` for the runnable demo.
2. Read `.project-context.yaml` for the repository bootstrap and current pilot posture.
3. Review `docs/Agentic_Development_Control_Plane_Architecture_Review_v0.2.2.docx` for the current decisions and reasoning.
4. Read `docs/DECISIONS.md` for accepted, proposed, and deferred architecture choices.
5. Read `docs/IMPLEMENTATION_PLAN_M1_M2.md` for completed storage/package work,
   `docs/IMPLEMENTATION_PLAN_M3_MINIMUM.md` for the opt-in native connectivity
   slice, and `docs/IMPLEMENTATION_PLAN_M4.md` plus proposed ADR-P004 for the
   external-writer boundary and its completed local live/restart evidence. Read
   `docs/IMPLEMENTATION_PLAN_M5.md` and proposed ADR-P005 before touching the
   default-off Atomic fixture composition. Read
   `docs/IMPLEMENTATION_PLAN_M5B_PRELIVE.md` and proposed ADR-P006 before changing
   the scoped model-inference boundary.
6. For Atomic-specific work only, then read `packages/atomic-workflow-architect/START_HERE.md`, its `skills/atomic-workflow-architect/SKILL.md`, and the relevant integration guide. That package is a module, not the whole Project OS. Only its reviewed `atomic-fixture-pilot` workflow is connected to a live writer, behind an exact default-off fixture gate; the broader package is not generally enabled.
7. Read `docs/STORAGE.md` before selecting PostgreSQL. Install locked dependencies
   with `npm ci`, then run `npm run verify` (full verification requires local
   PostgreSQL 16 `initdb`/`pg_ctl` tools for its disposable cluster).
8. Start the mock developer console with `./bin/project-os-server`. For the
   authenticated read-only native pilot, follow the distinct setup in `README.md`
   and use `./bin/project-os-pilot-server`. The credential-free M5a writer uses a
   separately configured `npm start` plus immutable local runner digest; the
   credential-free M5b lifecycle is also registered default-off and needs the
   additional reviewed gateway/model configuration in `README.md`. Do not add
   either writer feature flag to a default wrapper.
9. Open `http://127.0.0.1:8787`.
10. For the isolated Hermes/native pilot, run `npm run setup:hermes`; it registers
    the authenticated, restricted `bin/project-os-pilot-mcp` wrapper. The generic
    `bin/project-os-mcp` remains for the disposable mock demo.
11. Read `docs/GIT_HANDOFF.md` to understand the original handoff history.
12. For continued implementation, use `docs/NEXT_SESSION_PROMPT.md` rather than
    the superseded package prompt.

The web page is a developer inspection console. Hermes remains the intended user interface and Linear remains the roadmap authority.
