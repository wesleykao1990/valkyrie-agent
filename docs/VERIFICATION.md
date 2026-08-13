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

## Last recorded repository-wide verification before M5a

The pre-M5a command passed:

```bash
npm run verify
```

It executed strict TypeScript, the general suite, a disposable PostgreSQL phase,
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

## Repository-wide verification with M5a

The repository-wide command passed on 12 August 2026:

```bash
npm run verify
```

- `npm run typecheck`: passed.
- `npm test`: 214 tests total; 212 passed, 0 failed, and 2 honest opt-in
  cases skipped in this general phase (the PostgreSQL contract and live OCI
  provider).
- `npm run test:postgres`: disposable PostgreSQL 16.14; 22/22 passed with no
  skip, followed by a clean server stop.
- `npm run verify:atomic`: passed TypeScript and verified 36 required files, 5
  workflows, 16 routing cases, 5 prompt templates, and 11 invalid-manifest
  rejection cases.
- `npm run smoke:http`: passed with 3 projects, 3 isolated candidates, 3
  approvals, artifact counts 5/4/4, and one exact-preview memory promotion in
  the disposable smoke data.
- `npm run smoke:mcp`: passed with 7 allowlisted authenticated tools, runtime
  status, governed memory preview/promotion, portfolio calls, and idempotent run
  replay.

The live M5a Docker/Atomic proof below is a separate explicit command because it
requires an installed engine, a local registry, and an immutable runner image.

An independent final audit then replaced the M5a ledger's unjustified
`humanDecision`/“Human accepted” wording with neutral `approvalDecision` and
authorized-client evidence. On that exact post-audit tree, strict TypeScript and
the four affected approve/deny/request-changes/cancel integration cases passed
4/4. A second repository-wide invocation was requested, but the Codex app's
approval reviewer rejected process creation because its usage quota had been
reached; `npm` did not start. This is recorded as an unexecuted final rerun, not
as either an application pass or failure. The preceding complete run and the
post-repair focused evidence are both retained above.

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

### Milestone 5a Atomic fixture contracts

- A default-off flag and bearer-auth gate are required before the isolated-writer
  preflight is exposed. Flag-off/unavailable paths cannot allocate a workspace or
  start a container.
- Admission accepts only project `atomic-pilot`, task `task_atomic_fixture_m5`,
  runtime `atomic`, workflow `atomic-fixture-pilot`, the literal reviewed
  objective, a human final-action policy, and the configured budget cap.
  Idempotent replay returns one control-plane run and schedules one native workflow.
- Launch manifest schema `1.1.0` binds stable project/task/run IDs, accepted
  context and run-contract hashes, workspace path/owner, exact lease owner/fence,
  immutable image/policy, budget and fixed bounds, final-action boundary,
  provenance, and `crossProcessResume=false`.
- The provider, not the adapter, owns the one bounded interactive exec transport.
  It re-inspects immutable container/run/workspace/owner/fence/policy before
  opening Atomic LF-JSONL and closes the transport before stop/cleanup.
- Atomic 0.9.12 discovers and dispatches the package's reviewed tool-only workflow.
  Raw native records are retained with occurrence indexes and native main-session/
  workflow IDs alongside normalized running/completed events. No provider/model
  response is simulated or counted.
- The native workflow has one turn, zero repair rounds, one concurrency slot,
  zero child depth, network `none`, fixed command/output/elapsed bounds, and a
  reviewed implementation hash. Deterministic Node/Git checks and a separate
  fresh deterministic verifier must both pass.
- Governed export freezes the exact fence and revalidates all nine exported bytes/
  checksums against the pre-export native snapshot before atomic artifact
  persistence. Tampered evidence or non-evidence artifacts fail closed. Secret,
  persistence, ownership, cleanup, and replay conflicts retain quarantine evidence.
- Container and Atomic stop, worktree removal, lease release, and evidence-ready
  metadata precede approval. Migration 006 enforces complete project/workflow/
  evidence-digest/policy-hash/expiry binding with SQLite/PostgreSQL parity.
- Approve, deny, request-changes, expiry, cancellation, concurrent resolution,
  restart reconciliation, and exact replay are bounded. Approval can only record
  a safe mock receipt; memory remains proposed and no external final action occurs.
- Narrow `npm run verify:atomic` passed after the M5a package changes: 31 required
  files, 4 workflows, 16 routing cases, 5 prompt templates, 11 invalid-manifest
  rejection cases, and package TypeScript. This is not a substitute for the final
  repository-wide or live runner evidence still marked below.

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

## Milestone 5a live Atomic fixture evidence

The explicit proof command is run against a separately configured authenticated
server and immutable local runner digest:

```bash
CONTROL_PLANE_AUTH_TOKEN_FILE="$PWD/data/auth/control-plane.token" \
  npm run smoke:atomic-fixture
```

The smoke uses restricted stdio MCP, replays the exact start idempotently, waits
for the cleaned evidence gate, verifies nine governed artifact references and
checksums plus their approval digest, reads four bounded artifact bodies back
through MCP, resolves only the fixture-specific safe mock approval, and confirms
the memory proposal remains `proposed`.

Recorded live result: **passed** on 12 August 2026 against Colima/Docker on
Linux/ARM64. The exact immutable runner was:

```text
localhost:5000/valkyrie-atomic-runner@sha256:17de54b6354874d2009fd467c4098efb4e43b16323c38bbfb987092b0699e8bb
```

The image preflight observed Atomic `0.9.12`, Git `2.50.1`, network `none`, and
reviewed provenance digest
`6684b2be01ceb338f33af5585622d931993e7ca8361dbdf21d9a5470ed756d19`.
The authenticated MCP proof produced:

- control-plane run `run_4f48a202-954a-4002-b642-a1f3b8a76a4d`;
- Atomic main session `019ff209-a1ba-761f-a131-69549d33702c`;
- native workflow run `e69b6cb2-7183-4206-a6cf-c6198be093e5`;
- 35 retained raw native records and 41 total run events;
- nine governed artifacts, four re-opened and checksum-verified through MCP;
- approval `approval_atomic_da5c1b1898b2a7c14f46fd2642aa3467`, resolved by the
  opt-in automated test client only after it independently verified the evidence
  and cleanup;
- zero model tokens, zero model cost, zero repair rounds, and
  `modelExecutionAttempted=false`; and
- cleaned container/sandbox, removed writer workspace, released exact lease, and
  an empty post-run Docker inventory for `valkyrie.managed=true`.

This was an operator-authorized automated gate exercise, not proof that a human
person read and judged the artifact content. The safe mock receipt completed the
disposable run. Memory proposal
`memory_atomic_da5c1b1898b2a7c14f46fd2642aa3467` intentionally remains
`proposed`; optional rejection was not requested. No PR, merge, deploy,
external/product database mutation, credential expansion, model call, or memory
promotion occurred. The earlier runner attempt that failed because its Git did
not understand `extensions.relativeWorktrees` remains recorded as a truthful
failed attempt and is not counted as success.

Even a successful M5a run establishes only credential-free tool-workflow
composition. It does not establish Atomic provider/model execution, a model-based
fresh verifier, native HIL, or cross-process DBOS/PostgreSQL durability.

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

passed and discovered the then-current 11 pilot tools. The current restricted
wrapper has 15 tools: M5a added the narrow
`atomic_fixture_approval_resolve` and bounded `atomic_fixture_artifact_read`
surfaces, while credential-free M5b adds the equally narrow model-fixture approval
and artifact-read counterparts. The M5a tools were exercised by the standalone
authenticated M5a MCP smoke; the M5b tools are deterministic contract evidence,
not a new Hermes model conversation or live provider call.
Configuration reads returned both
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
for the tracked local provider. M5a additionally covers the fixed tool-only Atomic
composition, frozen export rebinding, evidence-bound/expiring approval, and safe
mock receipt. A hard host/VM failure during a real model run and descendant
behavior under a broader writer workload remain future evidence.

## Live integrations not exercised

- Claude model call (manual dedicated API key still required).
- Atomic provider/model workflow, model verifier, HIL answer mapping, steering, pause/resume, or
  durable DBOS/PostgreSQL native resume.
- Telegram/phone channel or remote Hermes gateway.
- Any model-backed repository writer, GitHub PR API, merge, deployment, Linear,
  OpenViking, or external outbox publisher.
- Production credentials, destructive database action, or canonical memory
  promotion in the live native smoke.

## Milestone 5b credential-free lifecycle evidence

The credential-free implementation adds migration 007, the fixed
`atomic-fixture-model-pilot`, four role/model capabilities, a private Unix-socket
gateway, an inspected internal-network bridge contract, read-only staged Atomic
model configuration, accepted package/image bindings, raw native record
retention, one bounded repair, and a new final fresh verifier. It is registered
default-off through service, authenticated HTTP, and the restricted Hermes MCP;
it includes transactional one-run admission, retrying durable claims,
cancellation, provider-aware restart reconciliation, bounded artifact reads,
indexed capability/approval expiry, an evidence-bound safe-mock operator gate,
and proposed-only memory. The same lifecycle runs against SQLite and disposable
PostgreSQL.

Deterministic fakes exercise success, native failure, policy/model/capability
tamper, replay, request/token/cost bounds, provider failure redaction,
package/image rejection, bridge cleanup and uncertain-create recovery,
capability expiry/revocation, substantive artifact/context verification,
stopped-export rebinding, approval/tamper rejection, cancellation, restart, and
durable concurrency admission.

This is complete credential-free lifecycle evidence, not live model evidence.
The fake Atomic process does not make provider requests, the fake upstream does
not prove model quality, and normal verification binds
`live_provider_expected=false`, requires `live_provider_verified=false`, strips
all `ATOMIC_FIXTURE_MODEL_*` settings, and loads no provider credential. A live
configured run may claim verification only after every expected role request is
durably completed and the native, deterministic, and frozen-export evidence
agrees. `npm run smoke:atomic-model` is a separate opt-in live command and remains
excluded from normal verification. Its successful subscription-backed execution
is recorded below.

## M5b subscription-broker live evidence

On 13 August 2026, the installed `codex-cli 0.147.0` reported `Logged in using
ChatGPT`. A minimal ephemeral read-only marker probe using `gpt-5.6-sol` completed
with thread `019ff7cd-42aa-7231-a105-3f496794fa46`, exact output
`VALKYRIE_SUBSCRIPTION_OK`, 13,574 input tokens (9,984 cached), and 12 output
tokens. This proves that the local ChatGPT subscription transport works; it is
not the end-to-end Atomic pilot and it used no OpenAI API key.

The repository now adds a fake-child-contract-tested `codex-subscription`
gateway upstream, strict structured-output schema, dedicated-profile setup and
opt-in marker smoke, and checksummed migration 008. SQLite and PostgreSQL both
permit changed request hashes within one role while rejecting exact replay and
enforcing a total 16-request/aggregate-token ceiling. Normal verification strips
all `ATOMIC_FIXTURE_MODEL_*` values and cannot use the live profile.

`npm run setup:codex-subscription` created the ignored dedicated profile and
scratch directories, and that profile completed its own ChatGPT device login.
`npm run smoke:codex-subscription` then passed with `codex-cli 0.147.0`,
`gpt-5.6-sol`, request `codex_677e403017bc188282400df77d8c7266`, 11,108 input
tokens, 29 output tokens, and no API key. No OAuth file was copied from the
existing user profile.

The full `npm run smoke:atomic-model` path passed on 13 August 2026 and stopped
before approval as designed:

- control-plane run: `run_6423f043-0abc-40c0-a7cc-a398633ba949`;
- Atomic main session: `019ff807-b584-7ef3-a6ac-62e6f5eb1d77`;
- native workflow run: `e9d6b759-1d3a-44a2-9f84-deda37d975ae`;
- pending approval: `approval_atomic_model_7817fe4297c19c7126b580b2d0dad754`;
- eight completed provider turns: four implementer, two initial-verifier, and two
  final-verifier turns; repair count zero;
- aggregate usage: 134,319 input tokens, 858 output tokens, and zero/unknown
  subscription dollar cost;
- immutable bindings: runner image
  `sha256:17de54b6354874d2009fd467c4098efb4e43b16323c38bbfb987092b0699e8bb`,
  staged package `8b5247c86cb84d5044aca18f01784b9472ccf3fe348d6c3b9e85bd86ede9625b`,
  policy `2f8745b1913d6b59f1524faee9f95e09bc19788af27e4167bff94cd1789c06bc`,
  and candidate source `2a83c9141bc48f097168a8ed70f484060974bd7cc0788b318dc079c1ac584934`;
- deterministic evidence: four fixture tests passed, `git diff --check` passed,
  exactly `src/normalize-project-slug.js` changed, and both fresh verifiers
  approved with no findings;
- 11 checksum-bound governed artifacts were exported; the smoke independently
  read and rehashed the candidate patch, final checks, final verifier, and evidence
  manifest against the approval digest;
- the inference capability was revoked, the proxy and writer container removed,
  the worktree deleted, and the writer lease released. A post-run managed-container
  inventory was empty.

The live writer never received the subscription profile or API key. The verified
macOS/Colima deployment used a loopback-only host gateway plus a fixed credential-
free proxy dual-homed on the internal writer network and Docker bridge; the writer
itself remained on the internal network. The run remains an operator-decision
candidate, not an accepted result or external-action authorization.

## Milestone 6 deterministic and live comparison evidence

The default-off M6 slice adds a direct Codex root writer and checksummed migration
009 for durable comparison aggregates/candidates. Focused evidence on 13 August
2026 passed for:

- exact direct task/runtime/workflow and one-candidate admission gates;
- an independent writer worktree/container/lease owner and no Atomic invocation;
- schema-bounded implementer output, fixed target write, immutable tests,
  `node --test`, `git diff --check`, exact changed-file scope, a fresh verifier,
  and at most one evidence-backed repair;
- 11 frozen, secret-scanned, checksum-bound artifacts and a separately expiring
  safe-mock approval with proposed-only memory;
- bounded raw Codex JSONL plus normalized inference completion events, durable
  request/token/cost evidence, capability revocation, cleanup, cancellation,
  artifact re-open/tamper checks, and restart recovery;
- SQLite/PostgreSQL comparison storage parity and an evidence-derived Atomic/
  direct-Codex metric snapshot; and
- a distinct Claude Code model workflow that remains unavailable and never
  inherits the Codex subscription boundary.

Focused direct/subscription/comparison tests passed 14/14, the policy/direct/
comparison set passed 21/21, strict typecheck passed, and the unrestricted full
unit suite exited zero. The final exact repository-wide count is recorded after
the last `npm run verify` below.

After Wesley explicitly approved sending the fixed disposable payload to the
external ChatGPT subscription service, `npm run smoke:m6-comparison` passed on
13 August 2026. The exact evidence was:

- comparison `compare_493a626ad2e583bff275ffc343bb495e`, contract hash
  `2ba4c154659db4a033b62e5477a8683093d840fdb0857e04c37e6d3cd7406170`;
- Atomic run `run_2592e612-7f6d-46ab-bf7d-b786de72e62f`, native session
  `019ff8c5-03b1-7561-8cd8-1368bbea51f0`, and native workflow
  `fe618202-259c-4ca2-a4c0-2a529b7489b2`;
- direct Codex run `run_ee9b00bd-52af-4006-bd81-a00c9b6aa5b2`;
- both candidates passed four deterministic fixture tests, `git diff --check`,
  exact changed-file scope, and a fresh final verifier with no findings and no
  repair;
- Atomic used 134,670 input and 934 output tokens in 83,188 ms, retained 974
  run events, and produced 11 governed artifacts;
- direct Codex used 34,933 input and 349 output tokens in 27,267 ms, retained 16
  run events including 12 raw inference records, and produced 11 governed
  artifacts;
- both subscription cost fields were recorded as zero/unknown rather than
  misrepresented as priced API usage; recovery was not exercised in this live
  run and `crossProcessResume` remained false;
- both candidates used the same exact base commit
  `6b608417507d3d45a6e4ad067b36203f43fe7d88`, model policy hash
  `2f8745b1913d6b59f1524faee9f95e09bc19788af27e4167bff94cd1789c06bc`,
  deterministic checks, and verifier rubric, but independent run IDs,
  workspaces, containers, leases, capabilities, artifacts, and approvals; and
- governed patches/checks/verifiers were reopened and rehashed, both containers
  and workspaces were removed, both writer leases were released, and a final
  managed-container inventory was empty.

The candidate implementations were semantically equivalent. Atomic returned a
compact one-line normalization expression; direct Codex returned the same logic
split over multiple lines and used capitalized error text. This one fixed fixture
does not select a default runtime. Atomic approval
`approval_atomic_model_d4703f0e655a4a5cbc650b641eed1943` and direct approval
`approval_direct_codex_4ce0bd26eea85ddc4cf477bf08374e9e` remain pending. No PR,
merge, deployment, product-database mutation, credential expansion, memory
promotion, or candidate acceptance occurred.

### Interpreting the elapsed-time and token result

Elapsed time is an operational budget metric required by the M6 contract, not a
standalone quality score. The raw difference mostly measured orchestration shape:

- Atomic made eight stateless subscription requests: four implementer calls and
  two calls for each fresh verifier. Their model wait was about 77,037 ms of the
  83,188 ms total.
- Direct Codex made three requests: one implementer and one per verifier. Their
  model wait was about 25,502 ms of the 27,267 ms total.
- Every Atomic request opened a new Codex thread, resent roughly 16–17K input
  tokens, and reported zero cached input. Direct requests carried roughly 11–12K.
- Atomic's first implementer call requested source/test/check evidence, the
  second wrote the source, the third attempted to read final checks before that
  artifact existed, and the fourth emitted structured completion. Each Atomic
  verifier similarly used one read round and one verdict round. Direct Codex
  received the bounded inputs in its prompt and returned one schema-bound result
  per role.

For this small deterministic fixture, the additional Atomic work was not worth
3.05x elapsed time and 3.82x input tokens: it caught no additional defect, used no
repair, and reached the same check/verifier outcome. Atomic did provide a native
session/workflow graph, tool-mediated stage trace, and much richer event evidence
(974 versus 16 events), which may be valuable for larger tasks or recovery—but
recovery was not exercised here and cross-process resume remains false.

Before another comparison, optimize the Atomic path by reusing or caching tool-loop
context, trimming its per-turn bootstrap, hiding stage-inapplicable artifacts,
preloading bounded verifier evidence where safe, and skipping a duplicate final
verifier when no repair occurred. Then compare several medium tasks and measure
defects caught and human review burden, not just latency. The current evidence
supports direct Codex for this class of tiny fixed task; it does not justify a
global routing default.

## Repository-wide verification through deterministic M6

The final repository-wide command passed on 13 August 2026 after the live pilot.
The normal verification environment stripped every live model/profile setting and
made no subscription request:

```bash
npm run verify
```

- `npm run typecheck`: passed with strict checking enabled.
- `npm test`: 237 tests total; 234 passed, 0 failed, and 3 honest opt-in
  cases skipped in this phase (the PostgreSQL storage contract, PostgreSQL M5b
  lifecycle, and live OCI provider).
- `npm run test:postgres`: a disposable PostgreSQL 16 cluster passed the storage
  contract 22/22 and then the full Atomic model lifecycle 7/7, including
  evidence-bound safe acceptance. The harness stopped PostgreSQL and removed its
  temporary cluster.
- `npm run verify:atomic`: passed TypeScript and verified 36 required files, 5
  workflows, 16 routing cases, 5 prompt templates, and 11 invalid-manifest
  rejection cases.
- `npm run smoke:http`: passed with 3 projects, 3 isolated candidates, 3
  approvals, artifact counts 5/4/4, and one exact-preview memory promotion in
  disposable smoke state.
- `npm run smoke:mcp`: passed with 7 test-allowlisted authenticated tools,
  runtime status, governed memory preview/promotion, portfolio calls, and
  idempotent run replay.

The general suite is intentionally serialized because several fake-OCI tests use
tight process deadlines; every previously observed parallel-load timeout passed
both individually and in the final serialized run. Live model settings and
credentials were stripped throughout. Neither live-model smoke was part of this
command, so the result makes no new provider/model, model-quality, or human-review
claim. The separate opt-in M6 smoke is the authority for the live comparison
claim. It did not resolve either approval and does not prove human-review burden,
recovery behavior, general coding quality, or a preferred default runtime.

## Post-M6 gap closure: durable assessment, Atomic Lite, and session continuity

On 13 August 2026, the complete pre-M7 gap slice passed the repository verifier:

```bash
npm run verify
```

- strict root TypeScript passed;
- the general suite reported 264 total: 261 passed, 0 failed, and 3 honest
  opt-in skips (PostgreSQL storage, PostgreSQL model lifecycle, and live OCI are
  exercised in their separate phases);
- disposable PostgreSQL passed 22/22 storage and 7/7 model-lifecycle tests;
- the Atomic package passed TypeScript and verified 38 required files, 6
  workflows, 16 routing cases, 5 prompt templates, and 11 invalid manifests;
- HTTP smoke passed with 3 projects, 3 isolated candidates, 3 approvals,
  artifacts 5/4/4, and one disposable exact-preview memory promotion; and
- authenticated MCP smoke passed with its 7 test-allowlisted tools, runtime and
  governed-memory operations, portfolio calls, and idempotent run replay.

Migration 010 and the authenticated HTTP/MCP operations now persist a bounded,
explainable Direct / Atomic Lite / Atomic Full assessment from a literal Hermes
request. Scores and hard signals remain control-plane-owned. Because the only
available Linear context is a prototype projection and Git/project execution
policy is unavailable, every current assessment is durably marked unsupported
and creates no run, workspace, lease, container, or fixed-pilot substitution.

The package-local `atomic-lite-writer` passed 12/12 focused tests. It binds the
contract/policy/context, one retained implementer lineage, model-free checks, at
most one forked repair, conditional fresh review, exact Git commit/tree/index,
descriptor-bound writes, full Git-visible worktree state, and checksummed patch/
evidence artifacts. An independent fresh review found no blocker after regressions
proved ancestor-swap refusal, ordinary undeclared check-mutation rejection, and
staged/committed undeclared-mutation rejection. This remains an unregistered
package contract, not an OS sandbox or a general writer.

Migration 011 retains provider-session identity and reuse evidence. The opt-in
two-turn ChatGPT-subscription smoke was run twice; the final run kept one native
Codex thread `019ff91a-d34a-7fe2-b995-0989a9350c24` across request
`codex_ec75fc61909b2e9f2e525dc570f184b3` (11,674 input/29 output tokens) and
request `codex_ef152c3ba4e8d66968d132a28538a72c` (23,606 input/57 output tokens).
The second request recorded `providerSessionReused=true` and sent only the
appended conversation delta through the broker. This proves process-local
transport continuity, not token savings: the provider reported more/cumulative
input on the resumed turn, dollar cost stayed zero/unknown, and restart resume
remains disabled.

## Milestone 7 deterministic connector evidence

On 13 August 2026, the complete deterministic M7 connector slice passed:

```bash
npm run verify
```

- strict root TypeScript passed;
- the general suite reported 311 total: 308 passed, 0 failed, and 3 honest
  opt-in skips;
- disposable PostgreSQL passed 23/23 storage and 7/7 model-lifecycle tests;
- the Atomic package verified 38 required files, 6 workflows, 16 routing cases,
  5 prompt templates, and 11 invalid launch manifests;
- authenticated HTTP smoke passed with 3 projects, 3 candidates, 3 approvals,
  artifacts 5/4/4, and one disposable exact-preview memory promotion; and
- authenticated MCP smoke passed with its 7 test-allowlisted tools, runtime and
  governed-memory operations, portfolio calls, and idempotent run replay.

Focused M7 coverage exercised migration 012/013 parity, revision-bound authority,
connector-policy digest/target drift refusal, approval-gated Linear issue
creation, the absence of an ordinary `task.created` provider consumer, fenced
per-consumer delivery, concurrent claims,
retry/dead-letter/replay/retention, deterministic Project Brain evaluation,
external-action approval and receipt transitions, stable-marker ambiguity
reconciliation, repository/ref/evidence drift refusal, authenticated operator
routes, and deterministic fake Linear/GitHub gateways. The final independent
five-suite repair review passed 25/25. The first release-candidate PostgreSQL run
exposed a stale-snapshot double-claim race; the claim path was repaired with an
exact locked delivery reread plus primary-key conflict-safe insert, then the full
verification and independent concurrency review both passed. The separate
disposable PostgreSQL phase above is authoritative for PostgreSQL.

After the deterministic verifier, the opt-in live read exercise used a private
Linear key with only `Read` permission and access restricted to the `Oropher`
team. The accepted Ovalo policy digest was
`2ef60676cab8de0141c8e0b7bc37a11feded66cd5259a990d05dce32fe112c4d`.
The first attempts preserved two useful failures: Linear's current `Project`
schema uses `teams` rather than `team`, and this new workspace rejects the
optional `Project.identifier` field while its Project IDs feature is disabled.
The query was narrowed to `teams.nodes` plus universally available project
fields, with exact accepted-team selection and focused regressions.

The final `npm run smoke:m7-read` passed and an exact idempotency replay returned
the same assessment `route_996ab07e-dc93-4e5b-8650-f933d7c890d1`. Linear was
revision-bound at `2026-08-13T06:53:29.958Z`; Git was revision-bound to `main`
commit `4d6e319de5b6764f9b73fd5599e25607aabd53fb` with the empty-patch digest
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
The smoke launched no runtime and performed no Linear/GitHub write. Operator
setup created the otherwise empty `Ovalo` Linear project and the scoped key;
no issue/comment, GitHub request, branch publication, PR, merge, deployment,
status change, OpenViking request, or canonical-memory promotion occurred.

The post-fix full `npm run verify` also passed with the same authoritative counts
above: 311 total / 308 passed / 3 honest skips, PostgreSQL 23/23 plus 7/7,
Atomic package verification, HTTP smoke, and MCP smoke.

## Milestone 8a managed skill-suite evidence

The 14 August 2026 pre-change baseline passed `npm run verify` on the M7 tree:
311 total / 308 passed / 3 honest skips, PostgreSQL 23/23 plus 7/7 model
lifecycle, Atomic package verification, HTTP smoke, and the 7-tool test MCP
smoke.

After the M8a implementation and a fresh local security pass, the complete
command passed again:

```bash
npm run verify
```

- strict TypeScript passed;
- the general suite reported 321 total: 318 passed, 0 failed, and 3 honest
  opt-in skips;
- disposable PostgreSQL passed 23/23 storage and 7/7 model-lifecycle tests;
- the Atomic package still verified 38 required files, 6 workflows, 16 routing
  cases, 5 prompt templates, and 11 invalid launch-manifest rejections;
- authenticated HTTP smoke passed unchanged; and
- authenticated MCP smoke passed with 8 explicitly allowlisted tools, including
  read-only managed-suite status.

Focused M8a evidence passed 10/10 for deterministic discovery/capability
classification, content-addressed private installation, exact replay, runtime and
project grants, operator-gated skills, compatible/manual updates, privilege-
expansion quarantine, explicit activation/rollback, source/policy/capability-pack
digests, source and installed tamper refusal, path/control-character refusal,
path-opaque/prose-free status, and the operator CLI. Authenticated HTTP/MCP
contract tests passed 7/7.

No third-party suite was fetched, installed into a native runtime, or executed.
No web/browser capability, dependency, setup script, telemetry, credential,
external action, or global runtime state was enabled. This verifies the M8a
admission/catalog foundation only; native projection and a real suite proof are
the next gate.

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

The complete local runner build, immutable-digest server environment, fixture
setup, and M5a smoke commands are in `README.md` under “Test the Milestone 5a
Atomic fixture slice.” They intentionally require an explicit local engine and
are not part of `npm run verify`.

The native and Hermes commands are intentionally outside default `npm run verify`
because they depend on installed user-owned CLIs/authentication and local ignored
state. Their results must always distinguish pass, skip, and unavailable.
