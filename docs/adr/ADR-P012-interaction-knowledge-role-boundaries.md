# ADR-P012 — Interaction, knowledge, role, and communication boundaries

Status: proposed

## Context

Valkyrie's governed execution foundation predates Wesley's active LINE surface
and the proposed Buzz, GBrain, Personal Profile, Commitment Ledger, and visible
agent roles. Treating any interface, memory provider, or runtime as the whole
agent would collapse authority boundaries already preserved by Linear, Git,
Project Brain, the control plane, and native runtimes.

## Proposal

1. LINE is the active first mobile surface through Hermes. Hermes is an
   interaction gateway; it does not become identity, roadmap, runtime, memory, or
   commitment authority.
2. Buzz is a proposed graphical operations and signed-event workspace. LINE and
   Buzz will project the same stable Valkyrie conversation and run IDs after an
   actor/channel identity foundation exists.
3. Project Brain remains the accepted canonical project-rationale authority.
   GBrain is evaluated through a separate future `KnowledgeProvider` as broad,
   advisory knowledge and may not write or override Project Brain.
4. Personal Profile stores explicitly curated personal preferences under its own
   authority. A Commitment Ledger separately owns promises and follow-up state.
5. The existing OpenViking adapter remains an alternative read-only Project Brain
   provider candidate. OpenViking and GBrain are not enabled as simultaneous
   production memory systems without an explicit evaluation and gap decision.
6. A requested capability selects a role before a runtime. Research Lead may use
   Hermes tools, Atomic, Prime, or a future worker; the word “research” alone does
   not select Prime. Engineering uses the Direct / Atomic Lite / Atomic Full risk
   assessment before runtime launch.
7. Codex and Claude implementers and fresh reviewers are normally transient
   participants. Persistent visible roles do not imply persistent model sessions.
8. Communication/delegation permission is independent of tool permission.
   Channel membership grants neither. Unrestricted DMs, recursive delegation,
   and ambient inter-agent authority remain disabled; each delegation becomes a
   governed bounded child task/run.

## PR #1 boundary

PR #1 records and reconciles these decisions only. It does not add actor tables,
remote mutating ingress, Buzz, GBrain, meeting intelligence, commitments,
conversation synchronization, role agents, or a general launcher.

## Consequences

- M9 must add authenticated actor/channel/conversation identity before remote
  LINE or Buzz mutations and must preserve the local bearer only as a compatibility
  mechanism, not human identity.
- The General Governed Launcher must consume a fresh engineering assessment,
  current Linear/Git/Project Brain authority, and verified capability packs while
  selecting exactly one root runtime.
- Later Knowledge, Meeting, Commitment, and Buzz milestones remain separate,
  reviewable branches with final external actions behind exact plans and approval.
- No current provider, runtime, mobile surface, or synchronization path is claimed
  live merely because its architectural role is accepted.
