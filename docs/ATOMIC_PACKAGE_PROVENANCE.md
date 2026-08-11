# Atomic package provenance

## Integrated module

- Repository path: `packages/atomic-workflow-architect/`
- Role: Atomic-specific execution module; not the whole Project OS or control plane
- Imported source version: `0.2.0`
- Repository-derived package version: `0.2.1`
- Integration date: 2026-08-11
- Live runtime status: disabled and not exercised

## Source identity

The 65-file source tree was copied from:

```text
Wesley_Project_OS_Continuation_Bundle_v0.3.0/
  Wesley_Atomic_Workflow_Architect_v0.2.0.zip
```

The source archive SHA-256 was verified against the continuation bundle before modification:

```text
9188e5d4326092d4782795ac39a13ff28274643c67bfac0e14d2314022754178
```

Related standalone documents were byte-identical to the copies retained inside the package:

| Source artifact | SHA-256 | Package copy |
|---|---|---|
| `Atomic_Architecture_Decision_Addendum_v0.2.0.md` | `423dd2f0b629145ad0d8bd062e47ec2671ab7475471779938d5b956acdd72044` | `integration/ARCHITECTURE_DECISION_ADDENDUM.md` |
| `Atomic_Expert_Research_Dossier_v0.2.0.md` | `b922d664cf90b9bd16ae4148ea3230c8a4c8e41b0534565156aa5917affe2f81` | `research/ATOMIC_EXPERT_RESEARCH.md` |

The full transcript inputs are not redistributed. The source manifest retains their identifiers and hashes.

## Derived 0.2.1 changes

The source tree was verified byte-for-byte before these repository-local changes:

- added lightweight package-local `AGENTS.md` and `CLAUDE.md` bootstrap files;
- clarified that source authority is domain-specific rather than one global precedence chain;
- added and structurally tested `launch-manifest.schema.json`;
- expanded the manifest template with stable run/project/task IDs, context/contract references, budget, final-action boundary, workspace and writer-lease identity, `crossProcessResume`, and maximum turns;
- set the template's `crossProcessResume` default to `false` until durable DBOS/PostgreSQL state is positively verified at runner startup;
- declared the previously omitted `@bastani/workflows` peer dependency;
- corrected compatibility language so researched Atomic 0.9.12-era sources are
  not presented as a live-validated host version;
- updated integrated install paths, package metadata, changelog, and structural verification for version `0.2.1`.

No runtime adapter was enabled, no Atomic process was started, no external connector was configured, and no credential was added.

## Dependency and compatibility caveat

The source package was researched against Atomic 0.9.12-era documentation, but its host peer ranges are `*` and no exact compatible published set was recorded in the bundle. The wildcard ranges are discovery metadata, not production pins. Before live use, the runner image must pin and contract-test exact versions of:

- `@bastani/atomic`;
- `@bastani/workflows`;
- `typebox`.

Until that succeeds, the real Atomic adapter must remain disabled and cross-process resume must remain unadvertised.

## License boundary

The package retains its nested `LICENSE.md` and `package.json` value `UNLICENSED`. Its private, all-rights-reserved notice is not replaced by the containing repository's root license.

## Verification

The original 0.2.0 source passed its dependency-free structural verification before import. The derived 0.2.1 package then passed:

```text
npm run verify
  28 required files
  3 workflows
  16 routing cases
  5 prompt templates
  launch-manifest template validation
  5 invalid launch-manifest rejection cases

npm run typecheck
  tsc --noEmit: passed

npm run verify:all
  passed
```

The type check used the containing repository's installed TypeScript toolchain. No dependency was installed by this integration, and no live Atomic process or provider was exercised.
