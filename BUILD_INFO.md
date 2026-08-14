# Build information

- Package: Wesley Agent Control Plane Prototype
- Repository release: 0.3.0
- Built: 14 August 2026
- Minimum runtime: Node.js 22.16
- Full-verification database: disposable PostgreSQL 16
- External credentials bundled: none
- Default data store: local SQLite
- Production-candidate data store: opt-in PostgreSQL
- Default runtimes: deterministic, explicitly labelled lifecycle simulations
- Atomic module: integrated source 0.2.0, repository derivative 0.2.1
- Atomic writer posture: fixed tool-only fixture and fixed M5b model fixture are
  live-verified behind default-off flags. M5b used the dedicated ChatGPT-
  subscription broker and stopped at its evidence-bound operator gate.
- Automatic episodic memory capture: disabled

## Completed milestones

- Milestone 0: inventory, architecture/package comparison, implementation plan,
  rollback/security analysis, and evidence-backed review notes.
- Milestone 1: async store boundary, SQLite/PostgreSQL adapters, checksummed
  migrations, transactional lifecycle aggregates/outbox, idempotency, exclusive
  claims, restart reconciliation, and shared contract evidence.
- Milestone 2: discoverable, inert Atomic Workflow Architect module with
  provenance, launch schema, package bootstrap, and independent verification.
- Milestone 3a: authenticated, disabled-by-default native connectivity for
  Atomic offline discovery, direct marker-only Codex/Claude Code probes,
  isolated Hermes MCP, and governed Project Brain retrieval/preview/rejection.
- Milestone 4: fenced writer leases, a private per-run Git root, a disabled
  digest-pinned OCI provider, host-owned lease heartbeat, checksummed read-only
  context, governed artifact export, durable sandbox-instance lifecycle/restart
  reconciliation, and cleanup/quarantine orchestration. The local Colima/Docker
  provider passed the opt-in live smoke with an immutable Alpine fixture digest.
- Milestone 5a integration slice: one authenticated, literal Atomic fixture path
  composes real Atomic 0.9.12 with the M4 OCI writer, deterministic checks and a
  fresh deterministic verifier, frozen governed evidence, terminal cleanup, an
  evidence-bound operator-intended gate, a safe mock acceptance receipt, and a proposed-only
  memory record. It has no model/provider credential, inference, real PR, merge,
  deploy, promotion, or cross-process Atomic durability. The opt-in live runner
  completed successfully; exact IDs and evidence are in `docs/VERIFICATION.md`.

Milestone 5b is live-verified through the separate approval boundary:
scoped capability/storage, private gateway/bridge topology, fixed model workflow,
fresh verifier, one-repair contracts, substantive evidence validation, and
frozen-export rebinding plus authenticated service/Hermes admission, cancellation,
restart, expiry, artifact review, approval, safe receipt, and SQLite/PostgreSQL
parity are deterministic-test green. A pinned Codex broker can use a dedicated
ChatGPT profile without an API key or OAuth export, and migration 008 supports
bounded native tool-loop turns. The live disposable run used real subscription
inference, passed deterministic checks and two fresh verification stages, exported
governed evidence, cleaned its writer, and stopped without approval or external
action. Exact IDs and usage are in `docs/VERIFICATION.md`.

Milestone 6 is deterministically implemented, live-verified, and default-off. Direct Codex is a
separate root writer using an independent worktree/container/fenced lease and the
same fixed task/model/check/verifier/approval policy as Atomic. Raw provider JSONL
and normalized inference events are retained, migration 009 persists comparison
metrics, and Claude Code remains separately unavailable rather than falling back.
Wesley approved the fixed disposable payload and the Atomic/direct Codex live
comparison passed. Both candidates produced correct, separately governed evidence
and stopped at unresolved approval gates. The result does not select a default
runtime; exact IDs and metrics are in `docs/VERIFICATION.md`.

Post-M6 routing remains proposed for execution, but its pre-M7 contracts are now
implemented. Authenticated HTTP/MCP assessment persists the literal Hermes
request, source provenance, final-action intent, and control-plane-owned Direct /
Atomic Lite / Atomic Full decision under migration 010; it fails closed with no
run while live Linear/Git authority is unavailable. The package-level
`atomic-lite-writer` implements one retained implementer, model-free checks, one
forked repair, and conditional fresh review without being registered as a general
writer. Migration 011 records process-local Codex provider-thread continuity;
same-role turns append deltas, role lineages are isolated, and restart resume is
refused.

Milestone 7 is deterministically implemented and default-off. Migration 012 adds
revision-bound Linear/Git authority plus per-consumer fenced delivery; migration
013 adds evidence-bound external-action plans and receipts. The host-side Linear,
Git, and GitHub gateways use exact digest-pinned project policy, private
credential files, stable provider markers, dead letters, and ambiguous-result
reconciliation. Linear issue/comment writes and GitHub draft-PR creation require
their own immutable plan and exact approval; ordinary task intake never writes
to Linear. GitHub may create only a separately approved draft PR from an
already-existing remote head. Local Markdown remains Project Brain authority;
the OpenViking candidate is read-only/evaluation-only. A private, team-scoped
Linear read key and digest-pinned Ovalo policy were exercised successfully by
the opt-in M7 read smoke on 13 August 2026; no credential is bundled, GitHub
remains disabled/unexercised, and no connector write was performed.

Milestone 8a's managed skill-suite foundation is implemented without enabling
third-party execution. It admits one exact local suite generation under an exact
policy, discovers and classifies skills automatically, preserves private
content-addressed generations, quarantines capability expansion, supports
activation/rollback, produces immutable runtime packs, and exposes authenticated
path-opaque status. Native Codex/Claude projections, Atomic delegation, a general
launcher, and web/browser brokers remain pending; admitted skills are not yet
executed.

## Verification entry point

```bash
npm ci
npm run verify
```

See `docs/VERIFICATION.md` for the recorded baseline/final evidence and
`docs/SESSION_HANDOFF_v0.3.0.md` for the implementation handoff.

## Next entry points

1. `START_HERE.md`
2. `docs/CONTINUATION_PLAN.md`
3. `docs/NEXT_SESSION_PROMPT.md`
4. `docs/STORAGE.md`
5. `docs/ATOMIC_PACKAGE_PROVENANCE.md`
6. `docs/adr/ADR-P001-transactional-storage-boundary.md`
7. `docs/adr/ADR-P002-atomic-package-boundary.md`
8. `docs/adr/ADR-P003-read-only-native-runtime-pilot.md`
9. `docs/IMPLEMENTATION_PLAN_M4.md`
10. `docs/adr/ADR-P004-external-writer-boundary.md`
11. `docs/IMPLEMENTATION_PLAN_M5.md`
12. `docs/adr/ADR-P005-atomic-writer-pilot.md`
13. `docs/IMPLEMENTATION_PLAN_M5B_PRELIVE.md`
14. `docs/adr/ADR-P006-scoped-inference-boundary.md`
15. `docs/IMPLEMENTATION_PLAN_M5B_SUBSCRIPTION.md`
16. `docs/adr/ADR-P007-subscription-inference-broker.md`
17. `docs/IMPLEMENTATION_PLAN_M6.md`
18. `docs/adr/ADR-P008-direct-runtime-comparison.md`
19. `docs/IMPLEMENTATION_PLAN_M7.md`
20. `docs/adr/ADR-P010-production-connector-boundary.md`
21. `docs/M7_CONNECTOR_SETUP.md`
22. `docs/IMPLEMENTATION_PLAN_M8.md`
23. `docs/adr/ADR-P011-managed-skill-suite-plane.md`
