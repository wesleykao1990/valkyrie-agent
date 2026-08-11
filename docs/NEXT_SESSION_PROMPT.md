# Copy-paste continuation prompt for the next session

```text
You are continuing Wesley's mobile-first multi-agent Project OS / Agent Control
Plane in the existing public valkyrie-agent repository. Do not create another
repository, substitute a generic agent framework, or redesign accepted
architecture.

CURRENT STATE

- Milestone 0 inventory/plan: complete.
- Milestone 1 transactional SQLite/PostgreSQL storage: complete and verified.
- Milestone 2 Atomic Workflow Architect module integration: complete at
  packages/atomic-workflow-architect/; its nested license remains UNLICENSED.
- Milestone 3a minimum native connectivity: implemented behind disabled-by-default
  flags and bearer-authenticated loopback pilot wrappers.
- Atomic 0.9.12 is verified only for credential-free offline LF-JSONL/package
  discovery. It does not run a model workflow.
- Direct Codex/Claude adapters accept only `Return exactly MARKER and nothing
  else.` marker objectives, run read-only/bare, and stop at analysis_only.
- Live Codex connectivity passed. Live Claude remains unexercised without an
  explicitly allow-listed ANTHROPIC_API_KEY.
- Hermes isolated-profile MCP test passed with 11 restricted tools and all
  built-in CLI tools plus built-in/user-profile memory disabled. A supported
  `gpt-5.6-sol`/`openai-codex` Hermes conversation exercised runtime status and
  Project Brain search; phone/mobile gateway remains unimplemented.
- Project Brain creates accepted-only bounded context packs; search, proposal,
  exact promotion preview, promotion, and rejection are separate. Pilot MCP cannot
  promote and automatic episodic capture remains disabled.
- crossProcessResume=false for every native pilot path.
- Proposed ADR-P001, ADR-P002, and ADR-P003 require Wesley's acceptance/amendment.

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
13. docs/IMPLEMENTATION_PLAN_M3_MINIMUM.md
14. docs/adr/ADR-P003-read-only-native-runtime-pilot.md

For Atomic-specific work, then read the package START_HERE, complete SKILL.md,
CONTROL_PLANE_INTEGRATION.md, CODEX_CLAUDE_HANDOFF.md,
INSTALLATION_AND_OPERATIONS.md, ATOMIC_EXPERT_RESEARCH.md, and
VIDEO_MASTERCLASS_FINDINGS.md in their documented order.

Run `npm ci` and `npm run verify` before editing. Record the exact baseline; full
verification requires PostgreSQL 16 initdb/pg_ctl. Run `npm run smoke:native` only
against an explicitly started authenticated local pilot and do not reinterpret an
unavailable Claude preflight as a pass.

MISSION — MILESTONE 4: REAL WORKSPACE SECURITY BOUNDARY

Implement one container/devcontainer or VM provider for a disposable fixture so a
future real writer can be enabled safely. Do not enable writer/model execution in
Atomic or direct runtimes until the provider and its tests are green.

Required outcomes:

1. One Git worktree per candidate and no duplicate Atomic top-level worktree.
2. One writer lease with heartbeat/renewal, fencing token, expiry kill, and orphan
   reconciliation/quarantine.
3. One external container/devcontainer or VM per real writing run; a worktree alone
   never counts as a sandbox.
4. Mount only the candidate worktree and bounded context. No production
   credentials; use disposable fixture secrets only when a test requires them.
5. Enforce and test filesystem and outbound-network policy, including symlink/path
   escapes and denial of unrelated host material.
6. Kill the runtime when lease ownership is lost. Bound start, execution, output,
   cleanup, and force-kill paths.
7. Export checksummed artifacts, secret-scan before storage/display, and clean up
   after terminal states while preserving quarantine evidence on unsafe failure.
8. Keep current read-only connectivity behavior and the zero-service mock/SQLite
   demo unchanged.
9. Preserve raw native records plus normalized events. Do not claim a capability
   that was not exercised on the pinned version.
10. Add deterministic fake/provider tests first, then one disposable live sandbox
    test if the required local engine is present. Skip honestly when absent.

Do not begin the end-to-end implementation/PR pilot until Milestone 4 is verified.
Do not make Atomic the default, run Atomic's model workflow, or permit arbitrary
Codex/Claude objectives as part of workspace-provider work.

NON-NEGOTIABLES

- Hermes is an interface, not a system of record.
- Linear, Git/checks, and accepted Markdown retain domain authority.
- One task has exactly one root runtime; Atomic owns its native graph/session.
- Never let Atomic and a direct candidate write the same worktree.
- Agents propose canonical knowledge but never silently promote it.
- Keep PR creation, merge, deploy, destructive DB change, expanded secret access,
  and canonical promotion as separate exact human/policy actions.
- Never commit credentials, tokens, provider output containing secrets, local
  runtime data, or generated private Project Brain content.
- Public repository visibility does not override the Atomic subtree license.

METHOD AND REPORT

- Update a short implementation/migration/rollback/security plan.
- Add tests before/with code; run narrow checks, then npm run verify.
- Use a fresh reviewer that did not author the implementation and cap repair rounds.
- Update setup, failure behavior, threat model, feature flags, and proposed ADRs.
- Report: milestone completed, architecture preserved, exact files changed, tests
  and verification, live integrations actually exercised, limitations/risks,
  manual setup, Wesley decisions, exact next commands, and the next continuation
  prompt.
```
