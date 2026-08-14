# Changelog

## Unreleased — 2026-08-12

- Bumped the launch-manifest wire schema to `1.1.0`; every exclusive writer lease now carries its exact `owner_id` and positive integer `fencing_token` so runner handoff cannot collapse lease identity into run/workspace identity.
- Updated the schema-valid template, structural verifier, rejection cases, and control-plane connectivity producer while keeping the package version at `0.2.1` pending the completed Milestone 5 release boundary.
- Added the fixed `atomic-fixture-model-pilot` workflow, bounded custom fixture tools, fresh initial/final verifier contexts, one optional implementer-continuity repair, deterministic evidence core, and model-launch schema 1.1. The launch now binds whether a live provider is expected; the control plane may treat it as verified only after durable scoped-gateway usage agrees. Normal package verification remains credential-free and claims no live model compatibility.
- Raised the model launch capability from four single requests to 16 total request-hash-distinct turns so Atomic custom tools can complete their native read/write/result/structured-output loop. Exact replays remain rejected and the four workflow roles are unchanged.
- Added the reusable `atomic-lite-writer` contract: hash-bound `/run-context` contract/policy validation, allowlisted custom file tools, model-free literal checks, one retained implementer with at most one forked repair, policy-gated fresh review, and bounded checksummed delta/evidence artifacts. It remains package-local and is not wired to HTTP/MCP/runtime.
- Tightened Atomic Lite with exact context binding/copies, policy-derived custom-tool schemas, readable write targets, fixed Git-worktree preflight, reviewable bounded `git diff --binary` patches, and separate implementer/reviewer model-execution evidence.
- Made the workflow custom-tool parameters TypeBox-backed and bounded each in-flight deterministic check, including a post-kill close grace period.
- Hardened Atomic Lite output and candidate integrity with pre-created exact artifact inodes, `O_NOFOLLOW` descriptor/path identity checks, a completely clean admitted worktree, bound Git commit/tree/index identities, and post-check/pre-evidence rejection of ordinary or committed undeclared mutations.

## 0.2.1 — 2026-08-11

- Integrated the exact 0.2.0 source package under `packages/atomic-workflow-architect/` in the whole-system repository.
- Added lightweight package-local `AGENTS.md` and `CLAUDE.md` bootstrap files.
- Clarified domain-specific authority instead of implying one global source precedence.
- Added a versioned launch-manifest JSON Schema and a schema-valid example with stable IDs, budget, workspace/writer lease, resume posture, and turn bounds.
- Declared the previously omitted `@bastani/workflows` host peer; all peer ranges remain unpinned pending a live compatibility test.
- Expanded structural verification for the derived package and launch contract.
- Kept live Atomic execution disabled and preserved the nested private license.

## 0.2.0 — 2026-08-11

- Incorporated both supplied Atomic masterclass transcripts and reconciled them with first-party docs/source.
- Clarified that Atomic is a first-class root runtime, not a wrapper under Codex or Claude Code.
- Added main-session meta-orchestrator and native workflow-tool policy.
- Added Create Spec/Prompt Engineer intent-alignment behavior.
- Added natural-language generated-workflow inspection, test, and promotion lifecycle.
- Added verbatim compaction, `keepContext`, session working-memory, and Intercom guidance.
- Added minimal `AGENTS.md`/`CLAUDE.md` bootstrap and skills-to-workflows policy.
- Added `request-preflight` read-only workflow.
- Added masterclass findings, architecture decision addendum, and new integration references.
- Added launch-manifest assets and stronger verification checks.
- Removed the pending-video limitation.

## 0.1.0 — 2026-08-11

- Added natural-language auto-routing extension.
- Added `atomic-workflow-architect` skill and detailed references.
- Added read-only idea and project-planning workflows.
- Added templates for feature delivery, bug-fix proof, migration waves, and workflow pre-launch decisions.
- Added control-plane, Hermes, Codex, Claude Code, Linear, Git, and Project Brain integration guidance.
- Added initial official Atomic research dossier.
