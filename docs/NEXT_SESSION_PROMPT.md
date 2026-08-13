# Continuation prompt — M8 native skill projection before web enablement

Continue the existing public `valkyrie-agent` repository and draft PR #1. Do not
create a new repository, replace the accepted runtime/storage/workspace/authority
boundaries, expose raw shell/network/filesystem/credential tools to Hermes, or
silently enable third-party code.

Read `START_HERE.md`, `AGENTS.md`, `.project-context.yaml`, `CLAUDE.md`,
`docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`,
`docs/CONTINUATION_PLAN.md`, `docs/VERIFICATION.md`,
`docs/SESSION_HANDOFF_v0.3.0.md`, `docs/IMPLEMENTATION_PLAN_M8.md`, and
`docs/adr/ADR-P011-managed-skill-suite-plane.md`. Run `npm run verify` before
changing code.

## Current state

Milestones 0–7 retain their documented deterministic/default-off state. M8a now
adds a local managed skill-suite foundation:

- exact digest-pinned local policy and source admission;
- bounded skill discovery and declared capability derivation;
- private content-addressed immutable generations with integrity rechecks;
- automatic suite-level project/runtime modes so Wesley does not map every skill;
- manual/reviewed-compatible updates, capability-expansion quarantine, explicit
  activation, and rollback;
- immutable capability packs plus authenticated read-only HTTP/Hermes status;
- no source fetch, dependency/setup execution, skill execution, or web/browser
  capability.

## Next objective

Finish M8 before enabling general web search:

1. Select one exact reviewed GStack release/source digest and record provenance.
2. Design and implement an isolated native projection/setup adapter for Codex and
   Claude Code that consumes an immutable capability pack and never changes
   global user state.
3. Preserve upstream suite routing where compatible. If a skill needs a broker
   the runtime lacks, report it as gated rather than silently weakening it.
4. Compose Atomic only through a compatible delegated specialist; Atomic remains
   the root owner of its internal workflow graph.
5. Make the future trusted general launcher record the exact suite/skill/runtime/
   project/digest pack and revalidate it at start.
6. Prove install, run, compatible update, expansion quarantine, rollback, and
   cleanup with deterministic fakes before an opt-in live GStack exercise.
7. Only after this is green, add a separately reviewed public-web/search broker
   with bounded egress, evidence, source attribution, rate/cost controls, and no
   credentials or final-action authority in Hermes/model context.

## Non-negotiable checks

- Admission is not execution authority; never run third-party setup during
  inspection/install.
- No runtime receives ambient credentials, global config, or another runtime's
  session/state.
- Hermes requests/status only. It never installs, activates, updates, rolls back,
  or receives raw browser/network/process/filesystem tools.
- New capability expansion is quarantined and requires explicit operator
  acceptance.
- Deployment, merge, branch publication, external writes, canonical-memory
  promotion, credential expansion, and self-update remain separate final actions.
- Web results and third-party skill output are advisory evidence; they cannot
  override current Linear/Git authority or accepted Project Brain decisions.

## Exact starting commands

```bash
npm ci
npm run verify
npm run skills:manage -- status --root "$PWD/data/managed-skill-suites"
```

Do not install or fetch GStack until its exact source version, digest, license,
setup behavior, dependency graph, telemetry/update posture, and requested tools
have been reviewed and recorded.
