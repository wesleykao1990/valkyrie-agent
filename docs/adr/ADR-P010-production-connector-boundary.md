# ADR-P010: production connector authority and final-action boundary

Status: proposed

## Context

M1-M6 established transactional storage, isolated writers, governed artifacts,
bounded model access, and evidence-bound safe acceptance. Before M7, the control
plane used only a local Linear projection, had no external-effect consumer,
always read the local Markdown Project Brain, and stopped before a GitHub request.

Hermes already has its own Linear gateway, but that does not give the control
plane an authenticated, revision-bound authority source. Reusing an interface's
ambient tools would make task truth depend on an unrecorded conversation and
would expose a broader credential surface to runtime routing.

The completed M6 writers also delete their isolated workspaces after governed
export. Their local branches are not durable remote heads, so a PR creator cannot
honestly infer that it can publish one.

## Proposed decision

1. Keep connector credentials and network clients in the host control plane.
   Hermes and writer containers receive only bounded domain operations.
2. Treat Linear `updatedAt` plus a canonical bounded payload hash as the observed
   revision. Persist narrow authority bindings and snapshots, not a roadmap
   replica. Current reads always outrank the projection.
3. Treat Git commit/tree OIDs plus an accepted policy digest as implementation
   authority. Project policies map a known project to a repository identity,
   approved refs, and fixed deterministic checks; callers cannot provide paths
   or commands.
4. Deliver external effects through per-consumer, expiring fenced claims over the
   transactional outbox. Preserve the original outbox row and stable ID.
5. Make Linear issue/comment writes and GitHub draft-PR creation explicit
   external-action plans with separate exact approvals and receipts. Ordinary
   task creation remains local-only. Ambiguous outcomes reconcile
   by a stable marker and exact target; they are not blindly retried.
6. Create a GitHub draft PR only when the head already exists remotely and its
   current OID equals the approved plan. Branch publication, merge, deployment,
   destructive database work, credential expansion, and memory promotion remain
   different final actions.
7. Keep local Markdown as the Project Brain authority. Candidate retrieval is
   read-only, namespace-bound, evaluated against deterministic fixtures, and
   cannot promote memory or enable automatic episodic capture.
8. Do not depend on Linear AgentSession developer-preview APIs and do not expose
   raw GraphQL, arbitrary Git, generic webhooks, or generic external-action tools
   through Hermes.

## Consequences

Routing and final actions gain inspectable source revisions, durable retries, and
reconciliation evidence. A connector outage cannot silently advance local state,
and the same outbox event cannot be delivered concurrently by two workers.

This adds durable state and operational complexity. External effects cannot share
one database transaction with the provider, so ambiguous states and operator
runbooks are first-class. A draft PR still needs an independently published head;
M7 does not smuggle branch publication into PR approval.

The initial live credential setup is intentionally manual and least-privilege.
Multi-user remote Hermes still needs authenticated actor provenance and scoped
authorization beyond the prototype's static bearer before production exposure.
