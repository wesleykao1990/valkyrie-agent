# Next-session prompt — M9 after PR #1 merges

Do not use this prompt until draft PR #1 is merged and `main` contains the exact
green stabilization head. Do not continue from the stale pre-merge branch.

```text
Continue wesleykao1990/valkyrie-agent after PR #1 has merged.

Confirm PR #1 CI is green at the merge commit, then:

git switch main
git pull --ff-only
git switch -c agent/m9-identity-general-launcher

Read START_HERE.md, AGENTS.md, .project-context.yaml, CLAUDE.md, README.md,
docs/DECISIONS.md, docs/ARCHITECTURE.md, SECURITY.md, docs/VERIFICATION.md,
docs/SESSION_HANDOFF_v0.3.0.md, docs/CONTINUATION_PLAN.md,
docs/PR1_REVIEW_MAP.md, and docs/adr/ADR-P012-interaction-knowledge-role-boundaries.md.
Run npm ci and npm run verify before changing code.

Implement M9 only:

1. Actor/channel identity and authorization state for Actor, ExternalIdentity,
   ChannelBinding, AuthorizationGrant, ServicePrincipal, Conversation,
   ConversationParticipant, MessageCorrelation, and ApprovalNonce.
2. AuthenticatedRequestContext on every new mutating operation, with actor,
   service principal, surface, conversation/correlation, idempotency, scopes,
   expiry/revocation, and approval replay protection. Keep the existing bearer
   only as local compatibility; it is not human identity.
3. Presentation-safe operator/mobile/Buzz DTOs that redact host paths, command
   paths, engine/provider internals, credential-profile locations, raw errors,
   policy paths, and secret-adjacent metadata.
4. A separate General Governed Launcher that consumes a non-expired engineering
   assessment, re-fetches/revalidates Linear/Git/Project Brain and skill packs,
   confirms project/task ownership, selects one Direct/Atomic Lite/Atomic Full
   root, creates one run/workspace/fenced lease transaction, stages bounded
   context, records exact runtime/model/workflow/skills, retains raw native plus
   normalized events, reconciles cancellation/restart, and stops before every
   external final action.
5. Role/runtime separation: Research Lead and Engineering Lead are roles; Prime,
   Atomic, Codex, and Claude are runtimes. Never restore research-keyword-to-Prime.

Do not add GBrain, meeting intelligence, Commitment Ledger, Buzz implementation,
LINE/Buzz synchronization, managed-skill native projection, unrestricted agent
DMs/delegation, merge, deployment, or autonomous external writes in M9.

Preserve one root runtime per run, Linear/Git/Project Brain authority, exact
fencing and sandbox ownership, raw native evidence, separate approvals/final
actions, no ambient credentials, no native-to-mock fallback, project isolation,
and the nested Atomic license boundary. Add migrations forward-only behind the
existing store contract, deterministic SQLite/PostgreSQL parity, proposed ADRs,
rollback/failure docs, and least-privilege CI coverage. Ask Wesley only for an
irreversible product decision, a credential, or authorization for a high-risk
external action.
```
