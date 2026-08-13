# Continuation prompt — M7 live authority acceptance and general-launch design

Continue the existing public `valkyrie-agent` repository and draft PR #1. Do not
create a new repository, substitute another framework, expose generic network/
filesystem/process tools, or redesign the accepted architecture.

Read `START_HERE.md`, `AGENTS.md`, `.project-context.yaml`, `CLAUDE.md`,
`docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`,
`docs/CONTINUATION_PLAN.md`, `docs/VERIFICATION.md`,
`docs/SESSION_HANDOFF_v0.3.0.md`, `docs/IMPLEMENTATION_PLAN_M7.md`,
`docs/adr/ADR-P010-production-connector-boundary.md`, and
`docs/M7_CONNECTOR_SETUP.md`. Run `npm run verify` before changing code.

## Current state

Milestones 0–7 are deterministically implemented for their documented default-
off scope. M7 adds:

- digest-pinned per-project Linear/Git/GitHub authority policy;
- bounded Linear project/issue reads and idempotent task/evidence writes;
- read-only Git commit/tree/patch/check-policy evidence;
- migration 012 authority bindings and fenced per-consumer outbox delivery with
  retry, dead letters, replay, retention, and status;
- migration 013 immutable evidence-bound external-action plans, approvals,
  receipts, and ambiguous-effect reconciliation;
- GitHub draft-PR creation from a pre-existing remote head only;
- deterministic local Project Brain evaluation and an inert, namespace-bound
  OpenViking candidate provider;
- authenticated bounded HTTP/MCP operations and a read-only live smoke.

Normal verification uses deterministic fakes and no connector credential. No
live Linear or GitHub request may be claimed until the opt-in record is run.
General Direct/Atomic Lite/Atomic Full assessment remains launch-unsupported;
fixed pilots must not be substituted. Branch publication, merge, deploy,
canonical-memory promotion, and multi-user actor attestation remain absent.

## Next objective

1. Review and accept/amend ADR-P010 and one exact project connector policy.
2. Obtain only the credential needed for the next exercise. Start with a
   dedicated Linear read credential and `LINEAR_CONNECTOR_MODE=read-only`; do not
   reuse Hermes ambient tool state.
3. Run `npm run smoke:m7-read`, record the exact authority revisions/digests, and
   verify it launched no runtime and made no external write.
4. If Wesley separately authorizes a disposable write, exercise exactly one
   approved Linear issue/comment action or one GitHub draft PR from a pre-existing disposable
   remote head. Stop before merge/deploy/status changes and retain the provider
   receipt.
5. Design the next separate change: a trusted general project launcher that
   consumes an unexpired assessment and rechecks authority, but cannot broaden
   project/command/credential/final-action policy. Do not implement it by mapping
   arbitrary requests onto fixed M5/M6 fixtures.
6. Before any shared/mobile deployment, replace the static operator bearer with
   authenticated actor provenance and scoped authorization.

## Non-negotiable checks

- Linear remains roadmap/status authority; never mirror its full roadmap.
- Git/GitHub and executable checks remain implementation/delivery authority.
- Credentials stay host-side in private regular files and never enter Hermes,
  model context, writer mounts, artifacts, events, or logs.
- Callers never choose provider URL, repository path, ref, command, issue target,
  or raw request body.
- External writes require a separate exact evidence/policy/expiry-bound plan and
  approval. Ambiguous effects reconcile by stable marker and are never blindly
  retried.
- GitHub is draft-only from a pre-existing matching head. Branch publication,
  merge, deploy, destructive database changes, expanded secret access, and memory
  promotion remain separate approvals/actions.
- Local accepted Markdown remains active Project Brain authority; OpenViking is
  evaluation-only until an accepted live retrieval result exists.

## Exact starting commands

```bash
npm ci
npm run verify
cp config/m7-connectors.example.json /absolute/private/accepted-m7-connectors.json
# Review and edit outside the repository, then compute:
shasum -a 256 /absolute/private/accepted-m7-connectors.json
```

Follow `docs/M7_CONNECTOR_SETUP.md` for private token files and the read-only
server/smoke commands. Do not request a GitHub write token for the Linear read
exercise, and do not enable `read-write`/`draft-pr` until Wesley authorizes that
specific external effect.
