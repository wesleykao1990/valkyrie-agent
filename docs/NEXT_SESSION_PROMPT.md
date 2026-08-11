# Copy-paste continuation prompt for the next session

```text
You are continuing Wesley's mobile-first multi-agent Project OS / Agent Control
Plane in the existing public valkyrie-agent repository and draft PR #1. Do not
create another repository, substitute a generic agent framework, or redesign the
accepted architecture.

CURRENT STATE

- Milestone 0 inventory/plan: complete.
- Milestone 1 transactional SQLite/PostgreSQL storage: complete and verified.
- Milestone 2 Atomic Workflow Architect module integration: complete under
  packages/atomic-workflow-architect/; its nested license remains UNLICENSED.
- Milestone 3a authenticated minimum connectivity: complete for Atomic offline
  discovery, direct read-only Codex/optional Claude Code, isolated Hermes MCP,
  bounded Project Brain context, and governed memory review. It is not a writer.
- Milestone 4 deterministic contract slice: implemented but not live-complete.
  It includes migration 004 fenced leases, idempotent artifact batches, a private
  shallow bare Git store plus one relative worktree, disabled Docker-compatible
  provider, explicit owner/fencing labels, effective-policy inspection, host-
  owned heartbeat/stop-on-loss, bounded baseline secret scan, atomic export, and
  cleanup/quarantine orchestration.
- The writer fixture is internal only (`workflow=sandbox-fixture`). It is not a
  runtime adapter, HTTP route, MCP tool, or Hermes capability. Atomic, Codex, and
  Claude Code remain read-only/analysis-only.
- This macOS host had no Docker, Podman, nerdctl, Colima/Lima, Apple container
  CLI, OrbStack, Finch, Multipass, devcontainer CLI, or detected VM engine.
  `npm run smoke:sandbox` therefore skipped honestly. A fake CLI pass is not
  isolation evidence.
- Proposed ADR-P001 through ADR-P004 require Wesley's acceptance/amendment.

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
13. docs/IMPLEMENTATION_PLAN_M4.md
14. docs/adr/ADR-P004-external-writer-boundary.md

For Atomic-specific work, then read the package START_HERE, complete SKILL.md,
CONTROL_PLANE_INTEGRATION.md, CODEX_CLAUDE_HANDOFF.md,
INSTALLATION_AND_OPERATIONS.md, ATOMIC_EXPERT_RESEARCH.md, and
VIDEO_MASTERCLASS_FINDINGS.md in their documented order.

Run `npm ci` and `npm run verify` before editing. Record the exact baseline; full
verification needs PostgreSQL 16 initdb/pg_ctl. `npm test` deliberately strips
live-sandbox variables. Run `npm run smoke:sandbox` only with an explicitly
selected local engine and reviewed digest-pinned image.

MISSION — FINISH MILESTONE 4 LIVE VERIFICATION AND RESTART SAFETY

Do not enable a model writer until every required live boundary check passes on
the actual deployment host.

1. Re-inventory the host for a supported external container/VM engine. Do not
   treat macOS sandbox-exec as the accepted boundary.
2. If Wesley has installed/selected a Docker-compatible engine, require:
   - absolute `VALKYRIE_OCI_LIVE_ENGINE`;
   - an already-present reviewed image as immutable
     `VALKYRIE_OCI_LIVE_IMAGE=...@sha256:<64 hex>`;
   - optionally one explicit local `VALKYRIE_OCI_LIVE_SOCKET=unix:///...`;
   - the derived current non-root host UID:GID, or an explicitly reviewed
     `VALKYRIE_OCI_LIVE_USER=uid:gid` that owns the strict bind roots;
   - no TCP daemon, implicit pull, ambient Docker config, or production secret.
3. Run and strengthen `npm run smoke:sandbox` until it positively proves on the
   real engine: exact image/owner/fence labels; one isolated run-root mount;
   context read-only; root read-only; candidate writes work; unrelated host paths
   absent; network none/no default route; numeric non-root UID/GID; built-in
   seccomp; all capabilities dropped; no-new-privileges; resource limits; host
   secret canary absent; bounded stop/kill; artifact export; owned cleanup and
   positive engine proof that the container no longer exists.
4. Add durable sandbox-instance lifecycle state if it is still absent:
   provisioning → ready → running → freezing → exporting → cleaned/quarantined.
   Bind engine ID, run, workspace, lease owner/token, image digest/ID, policy hash,
   timestamps, cleanup attempts, and bounded quarantine reason. Use forward
   SQLite/PostgreSQL migrations and parity tests.
5. Add restart reconciliation by immutable engine ID and exact ownership labels:
   active non-resumable writer, expired lease, terminal run with live container,
   DB-only instance, engine-only Valkyrie-labeled instance, missing workspace,
   malformed marker, engine outage, and cleanup retry exhaustion. Never kill by
   name prefix and never touch unrelated containers.
6. Make the context stager independently contained/read-only and checksummed if
   caller-supplied staging remains the only path. Never leave authoritative
   context writable inside the candidate worktree.
7. Re-check export crash recovery: exact filesystem replay, idempotent atomic
   artifact batch, tamper detection after export, partial-registration recovery,
   secret finding with no secret-value retention, and cleanup only after durable
   checksums.
8. Preserve the zero-service SQLite/mock demo and all Milestone 3 read-only
   behavior. HTTP/MCP/Hermes must receive no raw Git/container/filesystem tools.
9. If no engine is installed, do not claim Milestone 4 live-complete and do not
   enable writers. Continue only safe deterministic restart/state work, record the
   exact manual engine/image requirement, and stop before Milestone 5.

Only after the full live pass and fresh independent review may the next session
propose a separately flagged, disposable, non-production Milestone 5 writer
fixture. Do not run Atomic's model workflow, accept arbitrary Codex/Claude writing
objectives, create a PR, or inject provider credentials as part of merely closing
Milestone 4.

NON-NEGOTIABLES

- Hermes is an interface, not a system of record.
- Linear, Git/checks, and accepted Markdown retain domain authority.
- One task has exactly one root runtime; Atomic owns its native graph/session.
- Never let Atomic and a direct candidate write the same worktree.
- The control plane owns the top-level run root, worktree, container, fence, and
  artifact boundary; Atomic must not create a duplicate top-level worktree.
- A database fence does not stop raw filesystem writes: stop/inspect the exact
  container before release or reuse.
- Agents propose canonical knowledge but never silently promote it.
- Keep PR creation, merge, deploy, destructive DB change, expanded secret access,
  and canonical promotion as separate exact human/policy actions.
- Never commit credentials, tokens, provider output containing secrets, local
  runtime data, or generated private Project Brain content.
- Public repository visibility does not override the Atomic subtree license.

METHOD AND REPORT

- Update the short implementation/migration/rollback/security plan first.
- Add tests before/with code; run narrow checks, then `npm run verify`.
- Use a fresh reviewer that did not author the implementation and cap repairs to
  evidence-backed findings.
- Keep fake, skipped, unavailable, and positively live-tested evidence distinct.
- Report: milestone status, architecture preserved, exact files changed, tests
  and verification, live integrations exercised, limitations/risks, manual
  setup, Wesley decisions, exact next commands, and a new continuation prompt.
```
