# Run Contract and Scope

## Canonical contract

```markdown
# Run Contract

## Request and intent
Exact user request and classified intent.

## Objective
What must be true when the run ends.

## Acceptance criteria / evidence matrix
- Observable behavior.
- Exact checks/commands/artifacts.
- Existing behavior that must remain unchanged.
- Which evidence is deterministic, reviewer-based, or human judgment.

## Scope
Files, modules, APIs, outputs, environments, and external systems allowed to change.

## Non-goals
Adjacent cleanup, redesign, or features explicitly excluded.

## Compatibility posture
Breaking changes allowed / backward compatibility required / unresolved.

## Invariants
Public API, security, data, compatibility, performance, or UX constraints.

## Stop conditions
Conditions that require user input rather than assumption.

## Final-action boundary
Analysis / spec / implementation / checks / draft PR / merge / deploy / publication.

## Bounds
Cost, time, turns, children, retries, repair iterations, concurrency.

## Approval gates
Typed actions requiring authenticated human approval.
```

## Contract rules

- Only the user or authenticated policy can change the contract.
- Workers may identify adjacent work but must not silently expand scope.
- A growing diff without new acceptance criteria is evidence of scope drift.
- Preserve exact clauses; do not rely on several paraphrased versions.
- Downstream reports name any accepted contract amendment.
- Separate implementation acceptance from optional final actions such as PR creation, merge, deployment, or publication.

## Long-run protection

Store the full contract as a file/artifact. Protect only short load-bearing clauses in the active session:

```text
<keepContext>
Backward compatibility is required. Stop after checks. Do not create, merge, or deploy a PR.
</keepContext>
```

Protected content consumes context budget, so do not tag large specs or logs.

## Clarification threshold

Ask when missing information materially affects:

- product behavior/user intent;
- public API/schema/wire format;
- compatibility/migration safety;
- security/privacy/permissions;
- destructive or irreversible data changes;
- architecture with meaningful lock-in;
- acceptance proof;
- final-action permission;
- significant cost/resource commitment.

Otherwise record a reversible assumption and proceed.
