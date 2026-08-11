# Copy-paste continuation prompt for the next session

```text
You are continuing Wesley's mobile-first multi-agent Project OS / Agent Control
Plane in the existing valkyrie-agent repository. Do not create a new repository,
replace it with a generic agent framework, or redesign accepted architecture.

CURRENT STATE

- Repository release: 0.3.0.
- Milestone 0 (inventory/plan): complete.
- Milestone 1 (transactional SQLite/PostgreSQL storage): complete and verified.
- Milestone 2 (non-live Atomic Workflow Architect package integration): complete
  and verified at packages/atomic-workflow-architect/.
- All registered runtimes remain explicit scripted mocks.
- No Linear, GitHub, OpenViking, live Atomic, Codex, or Claude connector is enabled.
- Proposed ADR-P001 and ADR-P002 still require Wesley's acceptance/amendment.
- The repository is public by Wesley's explicit 2026-08-11 decision. The nested
  Atomic package remains UNLICENSED/private-use/all-rights-reserved; public source
  visibility does not extend the root MIT grant to that subtree.

READ BEFORE CHANGING CODE

1. START_HERE.md
2. AGENTS.md
3. .project-context.yaml
4. CLAUDE.md
5. docs/DECISIONS.md
6. docs/ARCHITECTURE.md
7. docs/CONTINUATION_PLAN.md
8. docs/PROTOTYPE_SCOPE.md
9. docs/IMPLEMENTATION_BACKLOG.md
10. SECURITY.md
11. docs/VERIFICATION.md
12. docs/SESSION_HANDOFF_v0.3.0.md
13. docs/STORAGE.md
14. docs/REVIEW_NOTES_v0.3.0.md
15. docs/adr/ADR-P001-transactional-storage-boundary.md
16. docs/adr/ADR-P002-atomic-package-boundary.md

For Atomic-specific work, then read in order:

1. packages/atomic-workflow-architect/START_HERE.md
2. packages/atomic-workflow-architect/skills/atomic-workflow-architect/SKILL.md
3. packages/atomic-workflow-architect/integration/CONTROL_PLANE_INTEGRATION.md
4. packages/atomic-workflow-architect/integration/CODEX_CLAUDE_HANDOFF.md
5. packages/atomic-workflow-architect/integration/INSTALLATION_AND_OPERATIONS.md
6. packages/atomic-workflow-architect/research/ATOMIC_EXPERT_RESEARCH.md
7. packages/atomic-workflow-architect/research/VIDEO_MASTERCLASS_FINDINGS.md

Run `npm ci` and `npm run verify` before editing. Record the exact baseline and do
not hide failures. Full verification creates a disposable PostgreSQL 16 cluster
and requires `initdb` and `pg_ctl` on PATH.

MISSION: MILESTONE 3 — REAL ATOMIC ADAPTER, DISABLED BY DEFAULT

First write a short implementation plan with changed files, tests, rollback,
security impact, feature flag, and exact unverified assumptions. Inspect
apps/control-plane/src/atomic-rpc-client.ts and the integrated launch-manifest
schema. Preserve current HTTP/MCP contracts unless a proposed ADR explicitly
justifies an additive change.

Implement the smallest secure non-live vertical slice:

1. Add a real Atomic RuntimeAdapter behind an explicit disabled-by-default flag.
2. Use strict LF-delimited JSONL RPC first. Do not make Codex/Claude orchestrate
   Atomic's internal graph; one Atomic main session owns the native workflow.
3. Add a deterministic fake Atomic subprocess for contract tests. Test fragmented
   frames, multiple frames, invalid JSON, CRLF policy, stdout contamination,
   child exit, timeout/cancel, cursors, backpressure, and secret-filtered env.
4. Validate every launch against the package launch-manifest schema. Include the
   exact request/task contract, stable project/task/run IDs, bounded Project Brain
   context-pack reference, budget/turn/time/concurrency bounds, final-action
   boundary, workspace owner, and writer-lease reference.
5. Preserve raw native payloads plus normalized events and stable native IDs.
6. Expose only capabilities positively confirmed for the installed, pinned
   Atomic/peer version: start, native IDs, status/state, event cursoring, steering,
   pause/resume/quit/cancel, human input, artifacts, model/cost metadata, and
   durability. Unconfirmed capabilities must remain false/unavailable.
7. Keep `crossProcessResume=false` unless runner startup proves the selected
   Atomic version is using durable DBOS/PostgreSQL state and a restart contract
   test succeeds.
8. Make live Atomic tests opt-in and skip honestly when exact packages and
   disposable credentials are absent. Do not install a floating/latest host or
   claim 0.9.12 is compatible merely because research used that era's sources.

Before live execution, pin and contract-test an exact compatible set of
@bastani/atomic, @bastani/workflows, and typebox. If no verifiable published set is
available, finish the fake-process adapter/contracts and report the live pin as a
blocker; do not simulate success.

NON-NEGOTIABLES

- Hermes is an interface, not a record authority.
- Do not mirror the Linear roadmap locally.
- Do not build a workflow engine above Atomic.
- One task has exactly one root runtime.
- Preserve direct Codex and Claude paths.
- A worktree/lease is not a sandbox; do not launch a real writer until the external
  container/VM boundary exists.
- Agents propose memory; they never silently promote it. Automatic episodic capture
  stays disabled.
- Keep raw native events alongside normalized events.
- No production secrets, PR creation, merge, deploy, destructive DB operation,
  expanded secret access, or canonical-memory promotion without its separate
  policy/approval boundary.
- Do not claim any external integration works unless actually exercised.

METHOD AND DONE CRITERIA

- Add tests before/with code and keep commits reviewable.
- Run narrow checks, then `npm run verify`.
- Use a fresh reviewer that did not author the implementation; repair only
  evidence-backed findings and cap repair rounds.
- Update documentation, environment examples, failure/rollback behavior, security
  assumptions, and proposed ADRs.
- Preserve the SQLite demo and PostgreSQL suite.
- Report exact live integrations exercised, skipped tests, remaining credentials,
  manual setup, files changed, commands, and risks.
- Do not begin Milestone 4 until Milestone 3's non-live contracts are green.
- Generate the next copy-paste continuation prompt.
```
