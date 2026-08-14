# ADR-P002: Imported Atomic package boundary and decision reconciliation

- Status: Proposed
- Date: 2026-08-11
- Decision owner: Wesley Kao
- Implementation status: inert source integration

## Context

The Atomic Workflow Architect `0.2.0` package contains an Atomic-specific skill,
router, prompts, workflows, research, integration guidance, and a launch-manifest
template. It is not the whole Project OS. Its addendum labels several decisions as
accepted, but accepted whole-system decisions are canonically recorded in this
repository's `docs/DECISIONS.md`.

The package also has private, all-rights-reserved terms, while the repository root
uses MIT. Source availability must not accidentally enable a runtime or broaden the
nested package's license.

## Proposed decision

1. Integrate the package as an independently testable, inert module at
   `packages/atomic-workflow-architect/`.
2. Do not use npm workspaces or runtime auto-discovery yet. Presence of the module
   does not register Atomic, execute an extension, or change routing defaults.
3. Preserve the control-plane/native-runtime ownership boundary:
   - the control plane owns stable IDs, policy, budgets, approvals, context-pack
     references, workspace leases, normalized events, and artifact references;
   - Atomic's main session owns its workflow graph, child sessions, checkpoints,
     human-input state, and verified native resumability.
4. Keep one root runtime per task and retain direct Codex/Claude candidates.
5. Interpret authority by domain, not as one global list: current user instruction
   controls intent; Linear controls roadmap/work status; Git and executable checks
   control implementation truth; accepted Project Brain Markdown controls project
   rationale and decisions.
6. Treat the imported addendum as proposed evidence until its decisions are
   explicitly reconciled into the whole-system registry.
7. Preserve the package's nested private license. The root MIT grant does not
   supersede it.

## Consequences

- The module can be reviewed and structurally verified from the repository root
  without implying that Atomic is installed or live.
- A later live adapter must use a pinned and contract-tested JSONL RPC/SDK boundary
  behind a disabled-by-default flag.
- Package-local corrections require a derived integration version and provenance
  record; the original archive hash remains recorded separately.
- Wesley explicitly authorized public repository visibility on 2026-08-11. The
  public source remains subject to the nested all-rights-reserved notice; visibility
  does not extend the root MIT grant to the subtree.

## Approval requested

Wesley should confirm whether the imported A-01 through A-07 addendum decisions
become accepted whole-system decisions. Repository visibility has already been
decided: public, with the nested license preserved.
