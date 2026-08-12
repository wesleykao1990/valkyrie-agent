# Build information

- Package: Wesley Agent Control Plane Prototype
- Repository release: 0.3.0
- Built: 12 August 2026
- Minimum runtime: Node.js 22.16
- Full-verification database: disposable PostgreSQL 16
- External credentials bundled: none
- Default data store: local SQLite
- Production-candidate data store: opt-in PostgreSQL
- Default runtimes: deterministic, explicitly labelled lifecycle simulations
- Atomic module: integrated source 0.2.0, repository derivative 0.2.1
- Atomic writer posture: fixed tool-only fixture implemented behind a default-off
  flag; provider/model execution remains disabled
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

The original model-backed Milestone 5 is not complete. It still requires a
reviewed local-model endpoint or scoped inference proxy plus real model/cost/token
and independent model-verifier evidence.

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
