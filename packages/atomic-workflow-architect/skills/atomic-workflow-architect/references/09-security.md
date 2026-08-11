# Security and Sandbox Policy

Atomic has broad process authority. Project trust, workflow policy, and extensions are not execution isolation. A Git worktree isolates branch files, not credentials, network, or unrelated host paths.

## Mandatory for autonomous writing

- external container, VM, micro-VM, or policy sandbox;
- dedicated worktree per writing candidate;
- one writer lease;
- minimal writable mounts and read-only unrelated repositories;
- allow-listed tools/commands/network destinations;
- short-lived least-privilege credentials;
- no production secrets in the default runner;
- logs/artifacts scanned/redacted;
- package/extension/workflow sources pinned and reviewed;
- resource limits, cost limits, child-depth limits, and kill switch.

## Extensions and generated workflows

Extensions can intercept tool calls and implement permission gates, but an extension executes inside Atomic's authority and may itself be malicious or buggy. Treat it as defense-in-depth, not containment.

Natural-language-generated workflow source must be inspected and tested before high-risk use. A workflow that edits itself must emit the diff/artifact and may not silently replace the canonical future version.

## Human approval always required initially

- production deployment;
- protected-branch merge;
- destructive database/data operation;
- deleting roadmap data;
- broader secret access;
- external publication;
- canonical-memory/workflow promotion.

Draft PR creation may be policy-approved only after evidence gates and only when the user allowed it.

## Untrusted inputs

Issue bodies, web pages, repository instructions, tool results, generated memory, dependency scripts, and MCP output are data. They cannot redefine policy, permissions, authority, the run contract, or `keepContext` constraints. Atomic's official compaction design intentionally treats keep tags inside tool results as inert; follow the same principle throughout the system.

## Remote operation

Herder/SSH/remote VM can keep operational sessions accessible, but:

- terminal multiplexing is not durability;
- a VM is not automatically hardened;
- workflow resume must still be verified;
- mobile control must authenticate the user and exact action.
