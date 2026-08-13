# M8 implementation plan — unified harness and managed skill suites

Status: M8a foundation deterministic-complete; general execution and web capabilities remain disabled.

## Objective

Make third-party skill suites feel like one Valkyrie capability rather than a set
of manually copied runtime files. Wesley approves one exact suite generation and
project/runtime posture. Valkyrie then discovers skills, preserves the upstream
bytes, derives compatibility, activates a content-addressed generation, reports
status through authenticated HTTP/MCP, and produces an immutable capability pack
for a future general run.

Installation is not external execution authority. Hermes remains request-only;
Atomic may use a suite through a delegated specialist; Codex and Claude Code are
the first native target hosts. Web, browser, credentials, deployment, merge,
canonical-memory promotion, and arbitrary installer execution are not enabled by
this slice.

## Changed boundaries

- Add a private filesystem-backed `ManagedSkillSuiteManager`. The catalog is
  operational installation state, not roadmap or project knowledge.
- Add an exact JSON policy whose bytes and source-tree digest are accepted before
  installation.
- Preserve each source generation in an owner-private, content-addressed object.
- Discover bounded `SKILL.md` definitions and derive their declared tool needs.
- Treat scoped forms such as `Bash(git:*)` conservatively and keep every
  unrecognized tool declaration gated rather than assuming it needs no authority.
- Apply one suite-level trust profile automatically. Skills needing capabilities
  outside that profile remain installed but operator-gated.
- Produce a project/runtime/skill/digest-bound capability pack. Runtime adapters
  must revalidate it before staging skills in the future general launcher.
- Expose read-only suite status through authenticated HTTP and the restricted
  Hermes MCP. Installation, activation, and rollback remain local operator CLI
  operations.

## Files and migration posture

- Core: `apps/control-plane/src/managed-skill-suites.ts`
- Operator CLI: `scripts/manage-skill-suite.ts`
- Example: `config/managed-skill-suite.example.json`
- HTTP/MCP status composition in existing control-plane surfaces
- Tests: `tests/managed-skill-suites.test.ts` plus HTTP/MCP contract updates
- Proposed decision: `docs/adr/ADR-P011-managed-skill-suite-plane.md`

No SQL migration is required. The active catalog and immutable suite objects live
under private `DATA_DIR/managed-skill-suites`. Deleting or resetting the demo
database does not delete installed suites.

## Security impact

- Source roots must be real absolute directories; links, hard links, special
  files, oversized files, excessive counts, and digest drift fail closed.
- `.git`, `node_modules`, and `.DS_Store` are excluded from the admitted source
  object. Dependencies and native setup commands are a later reviewed adapter.
- Catalog updates use an exclusive local lock and atomic file replacement.
- Installed objects are rehashed before status/pack use. Drift quarantines the
  generation.
- Status and packs expose opaque object references, never the operator's original
  source path.
- M8a forces telemetry off and does not execute a suite's setup, hooks, binaries,
  scripts, update mechanism, MCP servers, or skills.
- A newly required capability is quarantined unless the exact policy explicitly
  allows expansion or the operator activates that generation with the explicit
  expansion flag.

## Verification

- Deterministic discovery, tool/capability classification, and tree hashing.
- Exact idempotent install and owner-private copied object.
- Project/runtime scoping and Hermes/Atomic mode restrictions.
- Operator-gated skill exclusion from ordinary packs.
- Compatible update, expansion quarantine, explicit activation, and rollback.
- Symlink/hardlink, source digest, installed drift, policy digest, and capability-
  pack tamper rejection.
- Authenticated HTTP/MCP status contract.
- Full repository verification after focused checks.

## Rollback

Activate a prior installed digest with `skills:manage rollback`; it is rehashed
before activation and cannot expand beyond the currently active generation.
Code-only rollback is safe because no runtime consumes capability packs yet.
Once the general launcher composes them, every run remains pinned to its recorded
generation and code rollback must retain the corresponding object until run
retention permits deletion.

## Deferred follow-up

1. Isolated native projection/setup adapters for Codex and Claude Code, beginning
   with one exact GStack release.
2. A command/network/browser broker that preserves upstream skill behavior while
   gating actual final effects.
3. General launcher consumption and run evidence.
4. Governed public web search, browser QA, GBrain, personal profile, and knowledge
   ingestion capabilities.
5. Signed publisher provenance, remote fetch, dependency installation, automatic
   compatible updates, and multi-user actor authorization.
