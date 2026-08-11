# Verification record

Package version: 0.3.0
Current pilot date: 2026-08-12

## Untouched continuation baseline

Before the storage/package/native changes, the restored `0.2.2` whole-system
repository passed `npm run verify`:

- 10/10 automated tests passed.
- HTTP smoke ran three isolated scripted candidates and approval gates, stored
  artifacts, and promoted one reviewed proposal in a disposable Project Brain.
- MCP smoke discovered the original 15-tool surface and exercised portfolio and
  read-only memory.
- The untouched Atomic `0.2.0` source passed its dependency-free structural
  verifier: 23 required files, 3 workflows, 16 router cases, and 5 prompts. Its
  optional TypeScript check could not run until the containing repository installed
  TypeScript; that limitation was recorded, not hidden.

## Current automated verification

The final command passed:

```bash
npm run verify
```

It executes strict TypeScript, the general suite, a disposable PostgreSQL phase,
the imported Atomic package verifier/typecheck, HTTP lifecycle smoke, and stdio
MCP smoke. Current phase evidence:

- `npm run typecheck`: passed with TypeScript 5.8.3 and `noCheck=false`.
- `npm test`: 123 tests total; 121 passed, 0 failed, 2 honest opt-in cases
  skipped in this general phase (PostgreSQL contract and live OCI provider).
- `npm run test:postgres`: PostgreSQL 16.14 disposable cluster; 20 passed, 0
  failed/skipped. The script created a temporary cluster under `/tmp`, bound a
  random loopback port, supplied its own URL/sentinel, stopped PostgreSQL, and
  removed the cluster.
- `npm run verify:atomic`: package 0.2.1 passed TypeScript and verified 28 required
  files, 3 workflows, 16 routing cases, 5 prompt templates, one schema-valid
  launch manifest, and 5 invalid-manifest rejection cases.
- `npm run smoke:http`: passed with 3 projects, 3 isolated mock candidates, 3
  approvals, artifact counts 5/4/4, invalid/tampered memory decisions rejected,
  and one exact-preview promotion against a disposable Project Brain copy.
- `npm run smoke:mcp`: passed authenticated stdio MCP with 7 test-allowlisted
  tools, runtime status, proposal → exact preview → promotion, portfolio calls,
  and idempotent run replay.

The first general-suite attempt inside a restricted execution sandbox reached all
tests but the three loopback-listener cases received host `EPERM`. Rerunning with
local loopback permission produced the passing result above. This was an
environment permission failure, not hidden as an application pass.

## New contract coverage

### Authentication and Hermes/MCP

- Token source exclusivity, minimum/maximum length, whitespace/control rejection,
  regular non-symlink file, POSIX `0600`, and exact bearer comparison.
- Loopback recognition and fail-closed unauthenticated native/non-loopback startup.
- `/health` and static files public while all `/api/*`, including SSE, require the
  bearer when configured.
- MCP forwards bearer auth, validates/filter tools at startup, rejects disallowed
  calls, advertises `runtime-connectivity`, and binds promotion to a complete exact
  preview.

### Atomic transport/adapter

- UTF-8-safe LF-only framing, CRLF tolerance, U+2028/U+2029 safety, record-size
  bound, fragmented/coalesced frames, request correlation/out-of-order responses,
  pending bound, stdin backpressure, request timeout, stderr isolation, malformed
  JSON, trailing non-LF data, process exit/spawn failure, and bounded TERM/KILL.
- Credential-free exact-version preflight and offline package discovery.
- One Atomic main session, launch-manifest schema, exact context/run/workspace/
  lease/budget/final-action references, raw occurrence retention, stable native
  IDs, workflow/cursor/stats evidence, model-execution false, and
  `crossProcessResume=false`.

### Direct Codex/Claude adapters

- Exact version/auth preflight and explicit environment allow-list.
- Arbitrary objectives rejected before process spawn; only 3–64-character
  uppercase/digit/underscore connectivity markers are accepted.
- Prompt on stdin rather than argv, read-only Codex flags, bare/no-tools/no-MCP/
  no-settings Claude flags, bounded output/time/start, strict JSONL, raw-first
  records, session/result artifacts, cancellation, unexpected exit, and
  TERM-to-KILL lease ordering.

### Service, workspace, and Project Brain

- Native start receives real persisted workspace/lease plus checksummed accepted
  context pack and literal run contract before spawn.
- Workspace and `.control-plane` context directories must be contained regular
  non-symlink directories. A symlink escape is rejected before any context write
  or adapter start; the outside target remains untouched and the lease is released.
- Native orphan reconciliation fails conservatively and releases the lease when
  cross-process resume is false.
- Shutdown stops new requests, terminates open SSE/keep-alive connections, bounds
  adapter cleanup independently of HTTP drain, and then closes storage; an open
  SSE regression proves shutdown does not hang behind the client.
- Structural Markdown authority, deterministic accepted-only bounded context,
  stale/rejected/deprecated/superseded suppression, path containment, and file
  bounds.
- Proposal preview binds exact target/content/hash/reviewer/timestamp. Missing,
  tampered, cross-project, expired, excessive-future-skew, and changed previews
  fail without silent promotion. Preview lifetime is 15 minutes with 30 seconds
  of permitted future skew; identical-content retry is the only file-level
  idempotence case.

The existing shared SQLite/PostgreSQL suites still cover checksummed migrations,
atomic run/workspace/lease creation and rollback, idempotency, outbox atomicity,
approval transactions/replay/conflict, claims, ownership constraints, restart,
and reconciliation.

### Milestone 4 writer-boundary contracts

- Forward migrations 004 and 005 on SQLite/PostgreSQL: v3 lease backfill,
  owner/run/workspace
  constraints, monotonic fencing epochs, exact-fence renewal/release/quarantine,
  expired rotation, stale-owner/token rejection, quarantine persistence, and
  rollback/concurrency parity.
- Durable sandbox-instance state binds engine ID, run, workspace, lease owner and
  fence, immutable image, policy/path digests, context-content hash, lifecycle
  state, cleanup attempts, and bounded quarantine evidence. CAS transitions and
  outbox events cover provisioning, ready, running, freezing, exporting, cleaned,
  and quarantined states with adapter parity.
- Atomic/idempotent artifact batches: exact replay, every-field conflict,
  duplicate/mixed/foreign-run rejection, and late artifact/outbox rollback.
- Strict writer workspace: clean exact base commit, independent shallow bare Git
  store, one relative worktree, separate run roots/branches/changes, no source
  checkout hook or configured fsmonitor execution, no unrelated branch/history
  object, no simulated fallback, and exact-fence cleanup containment without
  invoking host Git on writer-controlled metadata.
- OCI provider: disabled default, absolute no-shell CLI, optional explicit local
  Unix socket only, immutable image digest with no pull, exact owner/fence labels,
  effective-policy reinspection, nested workdir, one writable run-root bind,
  disjoint read-only context, network/IPC none, read-only root, numeric non-root
  user, built-in seccomp, capability/no-new-privileges/resource bounds, no ambient
  credential/home environment, output/time/TERM/KILL bounds, emergency stop that
  bypasses a hung exec, and ownership-aware quarantine without unsafe removal.
- Host-owned heartbeat starts immediately after durable lease creation, retains
  its original fence, renews against store-observed time, retries failed loss
  handling without an unhandled rejection, rejects/cleans a late startup handle,
  and cannot mutate a rotated successor.
- Governed export: explicit manifest, traversal/symlink/hardlink/special-file,
  file/total-byte and permission bounds; exact filesystem replay; high-confidence
  private-key/provider/cloud/token scan with fingerprint-only evidence; no partial
  export on a finding; opaque artifact URIs.
- Internal coordinator: persisted queued-run authority, provider preflight before
  mutation, stop plus exact-fence cleanup freeze before scan/export, atomic
  artifact persistence before cleanup/release, disjoint durable artifact root,
  container/worktree terminal cleanup, and durable secret/persistence/unsafe-
  cleanup quarantine. It accepts only `workflow=sandbox-fixture` and is not
  registered through HTTP, MCP, or a runtime adapter.
- Restart reconciliation inventories only explicitly Valkyrie-labelled engine
  objects, then requires exact immutable ID, lease, image, policy, mount, network,
  privilege, and path ownership before cleanup. DB-only, engine-only, active,
  policy-drift, unmatched, and late-start/fence-rotation cases fail closed;
  unrelated or ambiguous engine objects are left untouched.

## Milestone 4 live provider evidence

```bash
npm run smoke:sandbox
```

Current outcome: **passed, 1/1 with no skip**, against a local Colima VM and its
Docker-compatible daemon. Installed and exercised versions were Colima `0.10.3`,
Lima `2.2.0`, Docker CLI `29.7.2`, and Docker Engine `29.5.2` on Linux/ARM64.
The reviewed fixture was official Alpine `3.22.5` pinned as:

```text
alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
```

The successful live invocation was:

```bash
env VALKYRIE_OCI_LIVE_ENGINE=/opt/homebrew/bin/docker \
  VALKYRIE_OCI_LIVE_IMAGE='alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce' \
  VALKYRIE_OCI_LIVE_ROOT="$HOME/.valkyrie/oci-live-tmp" \
  VALKYRIE_OCI_LIVE_SOCKET="unix://$HOME/.colima/default/docker.sock" \
  npm run smoke:sandbox
```

The opt-in test requires `VALKYRIE_OCI_LIVE_ENGINE` as an absolute CLI path,
`VALKYRIE_OCI_LIVE_IMAGE` as an already-present immutable digest, and an existing
owner-private, non-symlink `VALKYRIE_OCI_LIVE_ROOT` visible to the selected
engine; an explicit local `VALKYRIE_OCI_LIVE_SOCKET=unix:///...` is optional. It derives the current
non-root host UID:GID for strict bind ownership; on a host that cannot expose
those values, set a reviewed numeric `VALKYRIE_OCI_LIVE_USER=uid:gid`. When
configured it checks actual non-root execution, writable candidate path,
read-only root/context, no `eth0`/default route, absence of a host secret canary,
artifact export, and positive container absence after owned cleanup in addition
to inspected policy. Normal `npm test`/`npm run verify` strip all five variables
so inherited shell state cannot accidentally launch it.

Fake-engine success is contract evidence only. No Atomic, Codex, or Claude Code
writer/model workflow was enabled or counted as a Milestone 4 live pass.

## Live native pilot evidence

Command, against `bin/project-os-pilot-server`:

```bash
npm run smoke:native
```

Recorded outcome:

- Bearer boundary: unauthenticated `/api/runtimes` returned `401`; the same route
  succeeded with the generated token.
- Atomic: pinned `0.9.12` real process, credential-free offline RPC/imported-package
  discovery, 10 retained raw native records, 4 checksummed artifacts,
  `modelExecutionAttempted=false`, no provider/model call. Latest evidence run:
  `run_0c3a55c4-aafb-4d60-a670-8d3ce46821ae`.
- Codex: `codex-cli 0.147.0-alpha.6.5`, existing ChatGPT authentication, real
  ephemeral read-only model response containing exact marker
  `VALKYRIE_CODEX_LIVE_OK`, 4 raw native records, and 3 checksummed artifacts.
  Latest evidence run: `run_299b4665-822d-4f45-ae1b-66d34bd96eb0`.
- Claude Code: installed `2.1.81` native adapter correctly reported unavailable and
  was skipped because no explicitly allow-listed `ANTHROPIC_API_KEY` was present.
  OAuth/keychain state was not substituted and the skip is not a pass.
- Project Brain: accepted canonical Ovalo search succeeded; a test proposal was
  created; exact target/content preview was verified; the proposal was rejected.
  No canonical promotion occurred.

The smoke also checked terminal normalized events, native occurrence ordinals,
local artifact existence/checksums, native adapter metadata, final-action bounds,
and non-resumability.

## Hermes evidence

An empty `valkyrieeval` Hermes 0.19.0 profile was created without cloning another
profile. The setup disabled every built-in CLI toolset plus built-in/user-profile
memory and registered the authenticated restricted pilot wrapper.

```bash
hermes -p valkyrieeval mcp test valkyrie_project_os
```

passed and discovered the 11 pilot tools. Configuration reads returned both
memory flags as `false`; `prompt-size --json` reported zero tools and zero bytes
for memory/user-profile contributions. With `gpt-5.6-sol` through the
`openai-codex` provider, Hermes successfully invoked `runtimes_status` and returned
the requested marker `VALKYRIE_HERMES_MCP_OK`; it then invoked `memory_search` and
returned `VALKYRIE_HERMES_MEMORY_OK`. This exercised model → restricted MCP →
authenticated control-plane reads without enabling a built-in Hermes toolset.

An earlier `gpt-5.3-codex` attempt returned HTTP 400 before any model response
because that model is unsupported by the ChatGPT-account Codex endpoint. The
failure was not counted as integration success; selecting the supported
`gpt-5.6-sol` model resolved it.

## Fresh-context review and repair

Independent runtime/storage reviews found and drove repairs for strict framing,
response/raw-event retention, spawn/cancel/finalization races, bounded output and
termination, ambient-secret inheritance, exact version/auth probes, objective
confinement, context artifact containment/checksums, launch schema validation,
native restart reconciliation, context-directory symlink escape, shutdown/SSE
drain, bearer/API/MCP gaps, and exact short-lived memory-preview binding.
Evidence-backed regressions were added for repaired findings. No
capability was upgraded merely on documentation or simulated evidence.

The Milestone 3 final review left non-blocking deployment advisories: earlier ignored local
state can retain permissive modes (new POSIX server state now uses umask `077`);
general memory search can return explicitly advisory results; the ignored Atomic
install lacks a committed transitive lock; and SIGKILL/descendant cleanup belongs
to the external container/VM boundary. Milestone 4 now adds bounded container
cleanup, durable sandbox-instance state, and provider-aware restart reconciliation
for the tracked local provider. A hard host/VM failure during a real model run and
descendant behavior under a broader writer workload remain Milestone 5 evidence.

## Live integrations not exercised

- Claude model call (manual dedicated API key still required).
- Atomic provider/model workflow, HIL answer mapping, steering, pause/resume, or
  durable DBOS/PostgreSQL native resume.
- Telegram/phone channel or remote Hermes gateway.
- Any model-backed repository writer, GitHub PR API, merge, deployment, Linear,
  OpenViking, or external outbox publisher.
- Production credentials, destructive database action, or canonical memory
  promotion in the live native smoke.

## Reproduction commands

```bash
npm ci
npm run verify

npm run setup:atomic
npm run setup:pilot
./bin/project-os-pilot-server
```

Then, in another terminal:

```bash
npm run smoke:native
npm run setup:hermes
hermes -p valkyrieeval mcp test valkyrie_project_os
```

The native and Hermes commands are intentionally outside default `npm run verify`
because they depend on installed user-owned CLIs/authentication and local ignored
state. Their results must always distinguish pass, skip, and unavailable.
