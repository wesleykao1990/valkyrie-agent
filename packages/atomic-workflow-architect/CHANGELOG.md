# Changelog

## Unreleased — 2026-08-12

- Bumped the launch-manifest wire schema to `1.1.0`; every exclusive writer lease now carries its exact `owner_id` and positive integer `fencing_token` so runner handoff cannot collapse lease identity into run/workspace identity.
- Updated the schema-valid template, structural verifier, rejection cases, and control-plane connectivity producer while keeping the package version at `0.2.1` pending the completed Milestone 5 release boundary.
- Added the fixed `atomic-fixture-model-pilot` pre-live workflow, bounded custom fixture tools, fresh initial/final verifier contexts, one optional implementer-continuity repair, deterministic evidence core, and a separate model-launch schema. This is contract evidence only; no provider credential or live model compatibility is claimed.

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
