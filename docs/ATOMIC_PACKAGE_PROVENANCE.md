# Atomic package provenance

## Integrated module

- Repository path: `packages/atomic-workflow-architect/`
- Role: Atomic-specific execution module; not the whole Project OS or control plane
- Imported source version: `0.2.0`
- Repository-derived package version: `0.2.1`
- Integration date: 2026-08-11
- Live runtime status: disabled by default; opt-in Atomic 0.9.12 offline
  RPC/package-discovery adapter plus one fixture-specific credential-free
  tool-only workflow integration. No provider/model execution is enabled.

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
- bumped the launch-manifest wire schema to `1.1.0`, requiring the exact writer
  lease owner and positive fencing token;
- added the fixed `atomic-fixture-pilot` workflow and independently testable core
  for the disposable M5a integration slice. It writes only the reviewed fixture
  implementation, runs deterministic checks and a fresh deterministic verifier,
  and emits a bounded artifact manifest. It contains no model stage.

At package-integration time no runtime adapter was enabled, no Atomic process was
started, no external connector was configured, and no credential was added. The
later M3 minimum pilot installs Atomic host 0.9.12 under ignored `data/runtime/`
and performs credential-free offline discovery through the control-plane adapter.
M5a adds the reviewed workflow/core above and runs it only inside the separate,
default-off OCI fixture runner. It does not enable the package router or general
workflows as repository writers.

## Dependency and compatibility caveat

The source package was researched against Atomic 0.9.12-era documentation, but its host peer ranges are `*` and no exact compatible published set was recorded in the bundle. The wildcard ranges are discovery metadata, not production pins. Before live use, the runner image must pin and contract-test exact versions of:

- `@bastani/atomic`;
- `@bastani/workflows`;
- `typebox`.

The committed M5a runner lock pins the exact Atomic 0.9.12 dependency graph used
for the tool-only fixture. Its real workflow execution can establish compatibility
only for that fixed no-model path. It does not validate an Atomic provider/model,
the general package workflows, native HIL, or DBOS/PostgreSQL durability. Those
capabilities remain disabled and `crossProcessResume=false` until separately
contract-tested.

## License boundary

The package retains its nested `LICENSE.md` and `package.json` value `UNLICENSED`. Its private, all-rights-reserved notice is not replaced by the containing repository's root license.

## Verification

The original 0.2.0 source passed its dependency-free structural verification
before import. Before M5a, the derived 0.2.1 package passed:

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

The type check used the containing repository's installed TypeScript toolchain. No
dependency was installed by the original package integration. M3's host pilot
installation remains ignored runtime state. M5a instead uses the lockfile and
pinned build inputs under `docker/atomic-runner/`; no provider/model execution is
claimed by this provenance record.

After adding the M5a workflow and manifest `1.1.0`, the narrow package command was
rerun on 2026-08-12:

```text
npm run verify:atomic
  31 required files
  4 workflows
  16 routing cases
  5 prompt templates
  11 invalid launch-manifest rejection cases
  tsc --noEmit: passed
```

This is source/contract evidence. It is not the separate live OCI/Atomic workflow
proof and it does not validate a provider/model.
