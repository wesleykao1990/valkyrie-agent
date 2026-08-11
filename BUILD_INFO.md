# Build information

- Package: Wesley Agent Control Plane Prototype
- Repository release: 0.3.0
- Built: 11 August 2026
- Minimum runtime: Node.js 22.16
- Full-verification database: disposable PostgreSQL 16
- External credentials bundled: none
- Default data store: local SQLite
- Production-candidate data store: opt-in PostgreSQL
- Default runtimes: deterministic, explicitly labelled lifecycle simulations
- Atomic module: integrated source 0.2.0, repository derivative 0.2.1, live disabled
- Automatic episodic memory capture: disabled

## Completed milestones

- Milestone 0: inventory, architecture/package comparison, implementation plan,
  rollback/security analysis, and evidence-backed review notes.
- Milestone 1: async store boundary, SQLite/PostgreSQL adapters, checksummed
  migrations, transactional lifecycle aggregates/outbox, idempotency, exclusive
  claims, restart reconciliation, and shared contract evidence.
- Milestone 2: discoverable, inert Atomic Workflow Architect module with
  provenance, launch schema, package bootstrap, and independent verification.

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
