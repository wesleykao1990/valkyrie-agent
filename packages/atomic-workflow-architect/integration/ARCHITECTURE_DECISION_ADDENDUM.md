# Atomic Architecture Decision Addendum — v0.2.0

This addendum refines the Agentic Development Control Plane after reviewing both Atomic masterclass transcripts and current first-party documentation.

## A-01 — Atomic is a first-class root runtime

**Status:** Accepted for the pilot architecture; production default remains evidence-gated.

When Atomic is selected, the control plane starts Atomic through Atomic RPC/SDK and lets the Atomic main session/workflow runtime own the native graph. Atomic is not launched as a subordinate wrapper inside Codex or Claude Code.

## A-02 — The Atomic main session is the native meta-orchestrator

**Status:** Accepted.

The main session may select, create, start, observe, steer, pause, resume, and inspect workflows. Hermes remains the user interface and the control plane remains the cross-system policy layer.

## A-03 — Skills and workflows have separate jobs

**Status:** Accepted.

Skills/Project Brain resources carry domain knowledge and judgment. Workflows carry repeatable control flow, dependencies, evidence, retries, side effects, and final-action gates. `AGENTS.md` and `CLAUDE.md` should remain short bootstrap files.

## A-04 — Generated workflows are staged assets

**Status:** Accepted.

Natural-language workflow generation may create a run-scoped draft. High-risk execution requires inspection, type checking, reload/discovery verification, failure-path tests, and approval. Reusable promotion requires versioning and measured task outcomes.

## A-05 — Atomic session memory does not replace shared project memory

**Status:** Accepted.

Verbatim compaction, session history, TODO ledgers, and Intercom preserve active-run continuity. Linear, Git, and the governed Project Brain retain their existing authority.

## A-06 — Herder is optional operational UI

**Status:** Accepted.

Herder may improve SSH/terminal supervision of long runs. It is not a source of truth, security boundary, or MVP dependency because Hermes and the control plane provide mobile visibility.

## A-07 — Atomic remains pilot-gated

**Status:** Unchanged.

The videos provide strong design rationale and demonstrations, but include anecdotal performance claims rather than controlled evaluation. Atomic becomes the default only after a representative Ovalo pilot measures quality, defect capture, review burden, time, cost, and recovery.
