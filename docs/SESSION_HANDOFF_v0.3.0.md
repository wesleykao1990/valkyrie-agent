# Session handoff — v0.3.0 through live-verified Milestone 6 and pre-M7 gaps

Date: 2026-08-13

## 1. Milestone completed

- Milestones 0–4 remain complete for the documented local, non-production
  posture: inventory/plan, transactional SQLite/PostgreSQL, Atomic package
  integration, authenticated native connectivity, and the fenced external writer
  boundary.
- Milestone 5a implements one default-off, credential-free, end-to-end Atomic
  integration slice for the disposable `normalizeProjectSlug` fixture. It composes
  authenticated MCP, stable task/run/idempotency, fake Linear projection, bounded
  accepted Project Brain context, one M4 worktree/container/lease, one real Atomic
  0.9.12 main session/native workflow, deterministic checks, a fresh deterministic
  verifier, frozen governed evidence, terminal cleanup, an evidence-bound human
  gate, an evidence-derived proposed-only memory record, and a safe mock
  acceptance receipt after approval.
- Milestone 5b is implemented and live-verified through its separate approval
  boundary: scoped capability/accounting storage, a loopback-only host gateway,
  no-secret internal-network bridge, fixed Atomic model workflow, fresh initial
  and final verifiers, one optional implementer-continuity repair, raw native
  evidence, cleanup/revocation, authenticated service/Hermes admission,
  cancellation, restart, bounded maintenance, artifact review, evidence-bound
  safe approval, and SQLite/PostgreSQL parity. The fixed live run exercised the
  dedicated ChatGPT subscription broker and stopped without approval or external
  action. Wesley's operator decision remains separate.
- Milestone 6 is deterministically implemented, live-verified, and default-off. Direct Codex is
  a separate root writer using the same literal fixture/model/check/verifier/
  budget policy, but a distinct worktree/container/fenced lease/capability/
  artifacts/approval. Raw Codex JSONL and normalized inference events are
  retained. Migration 009 stores durable comparison metrics. Claude Code remains
  distinctly unavailable and cannot fall back to Codex. Wesley approved the
  fixed external payload; the opt-in Atomic/direct comparison passed and stopped
  with both candidate approvals pending and no default selected.
- The pre-M7 routing/efficiency gaps are implemented without enabling a general
  writer: authenticated durable engineering assessments select Direct, Atomic
  Lite, or Atomic Full but fail closed while live Linear/Git authority is absent;
  the package-local Atomic Lite contract implements retained implementer/forked
  repair/conditional review with deterministic integrity gates; and Codex
  subscription lineages reuse one process-local thread per capability/role.

The M5a implementation, deterministic contracts, and live no-model runner smoke
are complete. Exact immutable-image and native-run evidence is recorded in
`docs/VERIFICATION.md`.

## 2. Architecture preserved

Hermes remains an interface; Linear remains roadmap/status authority; Git and
executable checks remain implementation truth; accepted Project Brain Markdown
remains rationale/decision truth. The control plane owns stable IDs, policy,
budgets, approvals, workspace leases/fences, normalized events, and artifact
references. Atomic owns its one native main session and workflow graph.

The control plane does not orchestrate Atomic stages through Codex or Claude Code,
and it does not create another workflow engine. Every writer receives one private
worktree and exact writer lease. Automatic episodic capture and silent canonical
promotion stay disabled. Raw Atomic records remain alongside normalized events.

## 3. Files changed

The M5a slice primarily adds or changes:

- `apps/control-plane/src/atomic-fixture-pilot.ts` and
  `atomic-workflow-protocol.ts` for fixed admission, composition, evidence,
  reconciliation, and approval;
- `atomic-rpc-client.ts`, `oci-sandbox-provider.ts`, and
  `writer-sandbox-boundary.ts` for provider-owned interactive JSONL execution and
  frozen export validation;
- service/config/server/index/MCP wiring for the default-off preflight, exact run
  contract, and narrow fixture approval mutation;
- SQLite/PostgreSQL migration 006 and store contracts for complete approval
  project/workflow/evidence/policy/expiry binding;
- `packages/atomic-workflow-architect/workflows/atomic-fixture-pilot.ts`, its
  independently tested core, and launch-manifest schema `1.1.0` with exact lease
  owner/fencing token;
- the disposable fixture template, fixture setup script, fake Atomic/OCI support,
  deterministic integration/protocol/workflow/storage/recovery tests, and live
  MCP smoke;
- `docker/atomic-runner/`, which pins Node, Atomic 0.9.12, its npm graph, and Git
  2.50.1 from a checksum-verified source archive; and
- the M5 plan, proposed ADR-P005, API/security/architecture/setup/verification/
  continuation documentation.

Use `git diff --stat` and draft PR #1 for the exact path list.

The original credential-free M5b composition adds
`atomic-model-pilot-lifecycle.ts`, model HTTP/MCP routes, the opt-in
`atomic-model-pilot-live-smoke.ts`, service/index/config composition, exact
internal-bridge restart cleanup, provider-aware OCI reconciliation, launch schema
1.1, live-provider expectation binding, PostgreSQL lifecycle parity, and updated
security/setup/continuation documentation.

The 13 August subscription follow-up adds a default-off host-side Codex broker
that uses a dedicated ChatGPT-authenticated `CODEX_HOME` without exporting OAuth
material or mounting it into Atomic. Migration 008 permits up to 16 distinct
tool-loop requests across the same four fixed roles while exact request replay
remains single-spend. The dedicated Codex 0.147.0 ChatGPT profile completed its
marker and the end-to-end `gpt-5.6-sol` Atomic model pilot without exporting OAuth
material.

The post-M6 gap slice adds SQLite/PostgreSQL migrations 010–011, authenticated
engineering assessment HTTP/MCP operations, the package-local
`atomic-lite-writer` workflow/core/tests, and process-local provider-session
lineage evidence. The final Atomic Lite hardening binds admitted Git commit/tree/
index, pre-creates exact output inodes, uses descriptor/path identity checks, and
rejects ordinary or committed undeclared check mutations before evidence.

## 4. Tests and verification evidence

The recorded pre-M5 baseline was:

- strict TypeScript: passed;
- general suite: 123 total, 121 passed, 0 failed, 2 honest opt-in skips;
- disposable PostgreSQL 16.14: 20/20 passed;
- Atomic package verification, HTTP smoke, and authenticated MCP smoke: passed;
- M4 live Colima/Docker provider smoke: 1/1 passed with no skip.

M5a deterministic coverage includes exact admission/idempotency, manifest and
lease-fence binding, strict native workflow protocol, raw-first events, zero-model
cost/tokens, check/verifier failures, export tamper/TOCTOU rebinding, secret and
persistence failure, cleanup/quarantine, cancellation, approval approve/deny/
request-changes/expiry/concurrency, safe restart recovery, and SQLite/PostgreSQL
parity.

The live M5a smoke passed with immutable runner
`localhost:5000/valkyrie-atomic-runner@sha256:17de54b6354874d2009fd467c4098efb4e43b16323c38bbfb987092b0699e8bb`,
Atomic `0.9.12`, Git `2.50.1`, control-plane run
`run_4f48a202-954a-4002-b642-a1f3b8a76a4d`, main session
`019ff209-a1ba-761f-a131-69549d33702c`, and native workflow
`e69b6cb2-7183-4206-a6cf-c6198be093e5`. It retained 35 native records, registered
nine governed artifacts, read four back through MCP, used zero model tokens/cost,
completed the exact safe-mock approval, left memory proposed, and left no managed
Docker container. The opt-in test client invoked approval automatically after its
assertions; this proves the bound transition, not independent human review.
The live M5b run `run_6423f043-0abc-40c0-a7cc-a398633ba949` used Atomic session
`019ff807-b584-7ef3-a6ac-62e6f5eb1d77` and native workflow
`e9d6b759-1d3a-44a2-9f84-deda37d975ae`. Eight provider turns used 134,319 input
and 858 output tokens at zero/unknown subscription dollar cost. Four tests and
both fresh verifiers passed with no repair; 11 artifacts were rehashed against
approval `approval_atomic_model_7817fe4297c19c7126b580b2d0dad754`; cleanup was
complete and the smoke did not resolve the gate.

Final credential-free `npm run verify` passed after deterministic M6: strict
TypeScript; 237 general tests with 234 passed, 0 failed, and 3 honest opt-in
skips; disposable PostgreSQL storage 22/22 plus M5b lifecycle 7/7; Atomic package
verification with 36 required files and 5 workflows; and authenticated HTTP/MCP
smokes. Verification stripped all live model/profile settings and made no
subscription request. Focused direct/subscription/comparison tests also passed
14/14.

The live M6 comparison passed as
`compare_493a626ad2e583bff275ffc343bb495e`. Atomic run
`run_2592e612-7f6d-46ab-bf7d-b786de72e62f` used native session
`019ff8c5-03b1-7561-8cd8-1368bbea51f0`, 134,670 input/934 output tokens,
83,188 ms, 974 events, and 11 artifacts. Direct Codex run
`run_ee9b00bd-52af-4006-bd81-a00c9b6aa5b2` used 34,933 input/349 output
tokens, 27,267 ms, 16 events, and 11 artifacts. Both passed checks and a fresh
verifier without repair, cleaned their isolated writers, and retained zero/unknown
subscription cost. Their distinct approvals remain pending.

Final post-M6 `npm run verify` passed: strict TypeScript; 264 general tests with
261 passed, 0 failed, and 3 honest opt-in skips; disposable PostgreSQL storage
22/22 plus model lifecycle 7/7; Atomic package verification with 38 required
files and 6 workflows; and authenticated HTTP/MCP smokes. The focused Atomic
Lite suite passed 12/12 and an independent fresh reviewer reported no blocker.

The final two-turn subscription continuity smoke reused native Codex thread
`019ff91a-d34a-7fe2-b995-0989a9350c24`. The first/second requests recorded
11,674/29 and 23,606/57 input/output tokens respectively. This verifies the
same-thread transport and append-only broker request path, not token savings or
cross-process resume.

## 5. Live integrations actually exercised

Previously and still valid:

- local SQLite and disposable PostgreSQL 16 storage;
- authenticated loopback HTTP and stdio MCP;
- Atomic 0.9.12 credential-free host RPC/package discovery (no model call);
- Codex CLI with existing ChatGPT authentication for a fixed read-only marker;
- Project Brain accepted search plus proposal/preview/rejection;
- isolated Hermes MCP with a supported `openai-codex` model; and
- Colima/Docker M4 container/network/mount/ownership/export/cleanup policy.

M5a final live result: **passed**. The authenticated MCP → Atomic workflow →
governed evidence read → cleanup → approval → mock receipt sequence completed
against the immutable Git-2.50.1 runner; exact evidence is in
`docs/VERIFICATION.md`. The earlier real Atomic/container attempt correctly
failed because its older Git did not recognize host-created relative-worktree
metadata and is not counted as success.

Exercised in M6: fresh live Atomic and direct Codex candidates against the same
fixed contract, plus the durable comparison ledger. Not exercised: Claude Code
model execution, candidate acceptance, real GitHub/PR/merge/deploy, Linear,
OpenViking, mobile gateway, external outbox publishing, destructive database
action, production secret, or canonical memory promotion.

Exercised after M6: two bounded ChatGPT-subscription marker turns on one native
Codex thread. The durable engineering-assessment HTTP/MCP paths were exercised
only against current prototype/unavailable authority and correctly launched
nothing. Atomic Lite itself remains contract-tested rather than live-model run.

## 6. Known limitations and risks

- M5a writes reviewed fixed bytes and has zero repair rounds. It measures
  integration/lifecycle correctness, not agent coding quality.
- M5a's fresh verifier is deterministic and process-separated. M5b/M6 exercised
  live provider/model output and fresh model verifiers, but one disposable fixture
  is not enough to claim general coding quality or a preferred runtime.
- M5a's writer has network `none`. M5b permits only an inspected internal Docker
  network to a no-secret bridge; the provider credential remains in the host
  gateway and is never placed in the writer.
- `crossProcessResume=false`; active Atomic work is cleaned/quarantined and failed
  after restart. Only already-cleaned evidence can be recovered for a still-valid
  control-plane approval.
- A local container is not a confidential hostile multi-tenant boundary; use a
  reviewed remote micro-VM or equivalent for that risk class.
- Static bearer auth is local-pilot protection, not production identity, mobile
  channel attestation, rotation, or scoped authorization.
- Approval creates only a safe mock receipt. The memory proposal remains advisory
  and requires a separate exact preview/promotion decision.
- M5a supports one active control-plane pilot coordinator process. Transactional
  admission works across PostgreSQL processes, but cancellation/native ownership
  handoff is not horizontally coordinated while `crossProcessResume=false`.
- Atomic's fixed internal project/tool trust is pre-approved only for these exact
  fixture workflows. The separate control-plane gate is operator-intended and
  evidence-bound, but bearer auth does not attest human presence; never generalize
  the fixture's blanket native trust to a broader writer.
- The live smoke's approval was an automated operator-authorized test-client
  action with a fixed pilot principal. M5b needs authenticated actor provenance
  and a real person-in-the-loop review before claiming human acceptance.
- Migrations 006–011 are forward-only. Older binaries reject a v11 ledger;
  rollback needs the appropriate verified pre-migration backup or a separate
  compatible database.
- Atomic Lite is not runtime-registered and its worktree integrity checks are
  not hostile-process containment. A real launcher still requires accepted
  project policy, current Linear/Git authority, an external container/VM, and an
  exact writer fence.
- Provider-thread continuity is intentionally process-local. A restart refuses
  resume rather than trusting a stored native ID it no longer owns.
- The nested Atomic module remains `UNLICENSED` despite public repository
  visibility.

## 7. Manual setup still required

- Install dependencies and create the private token with `npm ci` and
  `npm run setup:pilot`.
- To reproduce the live proof, start a Docker-compatible engine, build/push the
  reviewed runner to the local loopback registry, and capture its immutable
  repository digest.
- Create the ignored fixture with `npm run setup:atomic-fixture -- ABSOLUTE_PATH`.
- Start a separately configured authenticated server with the exact absolute
  fixture/engine/socket/root paths and immutable runner digest, then run
  `npm run smoke:atomic-fixture` from another terminal.
- The complete copy-paste commands and failure notes are in `README.md`.
- Full repository verification needs PostgreSQL 16 `initdb` and `pg_ctl`.
- Hermes/Claude/mobile setup remains separate from the fixture writers.
- To reproduce M5b with the preferred subscription path, retain or recreate the
  dedicated profile with `npm run setup:codex-subscription`, then run the opt-in
  broker marker smoke.
  Accepted package/image digests, the dedicated internal Docker network, token/
  request/time limits, and operator identity are still required. The alternative
  external-provider path still needs prices and a dedicated 0600 API token.
- Start the default-off configured server and run `npm run smoke:atomic-model`.
  The smoke stops at `awaiting_approval` by default so the governed artifacts can
  be reviewed before the separate safe-mock acceptance transition.
- To reproduce M6, also set `DIRECT_CODEX_MODEL_PILOT_ENABLED=true` and run
  `npm run smoke:m6-comparison`. This sends the fixed fixture objective/source/
  test/candidate/check/verifier payload to the external ChatGPT subscription
  service, so an explicit operator acknowledgment remains required for each new
  external run. The smoke stops before either candidate approval.

## 8. ADRs or decisions requiring Wesley

- Accept/amend ADR-P001 storage semantics, ADR-P002 Atomic package boundary,
  ADR-P003 native connectivity, and ADR-P004 external writer boundary.
- Accept/amend/reject ADR-P005's split between a credential-free integration proof
  and model-backed quality proof, including zero repairs for the fixed M5a task.
- Accept/amend/reject proposed ADR-P006's external credential-holding gateway,
  run-scoped capability, internal-network bridge, and single-instance M5b policy.
- Accept/amend/reject proposed ADR-P007's subscription-backed Codex broker. The
  current preferred inference boundary is ChatGPT subscription for the disposable
  pilot; the OpenAI-compatible API/local path remains available.
- Accept/amend/reject proposed ADR-P008's separate direct-root lifecycle and
  evidence-derived comparison rubric. It does not select a default runtime.
- Accept/amend/reject proposed ADR-P009's risk-based Direct / Atomic Lite /
  Atomic Full rubric. Current assessment is advisory/fail-closed until M7 binds
  live authority and accepted project execution policy.
- Decide whether a remote micro-VM is mandatory before confidential/high-risk
  writing and choose the future Hermes mobile identity/authorization ingress.

Public repository visibility is already Wesley's explicit decision and does not
change the nested package license.

## 9. Exact next commands

Default demo and repository verification:

```bash
npm ci
npm run verify
npm start
```

Prepare the dedicated ChatGPT subscription profile and test only the broker:

```bash
npm run setup:codex-subscription
# If prompted, run the printed CODEX_HOME=... codex login --device-auth command.
# Export the exact ATOMIC_FIXTURE_MODEL_CODEX_* values from .env.example, then:
npm run smoke:codex-subscription
```

M5a local ARM64 runner and fixture:

```bash
docker run --detach --name valkyrie-m5-registry \
  --publish 127.0.0.1:5000:5000 \
  registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
docker build --platform linux/arm64 \
  --tag localhost:5000/valkyrie-atomic-runner:0.9.12-m5a \
  docker/atomic-runner
docker push localhost:5000/valkyrie-atomic-runner:0.9.12-m5a
npm run setup:pilot
install -d -m 700 \
  "$PWD/data/fixture-repositories" \
  "$PWD/data/atomic-fixture-pilot/runtime"
npm run setup:atomic-fixture -- "$PWD/data/fixture-repositories/atomic-m5"
export VALKYRIE_ATOMIC_RUNNER_IMAGE="$(docker image inspect \
  --format '{{index .RepoDigests 0}}' \
  localhost:5000/valkyrie-atomic-runner:0.9.12-m5a)"
```

Start the separately configured server (replace the engine path/socket for
another local engine):

```bash
env \
  CONTROL_PLANE_AUTH_TOKEN_FILE="$PWD/data/auth/control-plane.token" \
  DATA_DIR="$PWD/data/atomic-fixture-pilot/control-plane" \
  PROJECT_BRAIN_DIR="$PWD/project-brain" \
  ENABLE_DEMO_RESET=false \
  ATOMIC_FIXTURE_PILOT_ENABLED=true \
  ATOMIC_FIXTURE_PILOT_REPOSITORY="$PWD/data/fixture-repositories/atomic-m5" \
  ATOMIC_FIXTURE_PILOT_ENGINE=/opt/homebrew/bin/docker \
  ATOMIC_FIXTURE_PILOT_ENGINE_SOCKET="unix://$HOME/.colima/default/docker.sock" \
  ATOMIC_FIXTURE_PILOT_IMAGE="$VALKYRIE_ATOMIC_RUNNER_IMAGE" \
  ATOMIC_FIXTURE_PILOT_ROOT="$PWD/data/atomic-fixture-pilot/runtime" \
  ATOMIC_FIXTURE_PILOT_MAX_COST_USD=1 \
  npm start
```

From another terminal, run the authenticated proof:

```bash
CONTROL_PLANE_API=http://127.0.0.1:8787 \
  CONTROL_PLANE_AUTH_TOKEN_FILE="$PWD/data/auth/control-plane.token" \
  npm run smoke:atomic-fixture
```

If the registry container already exists, start/inspect it instead of creating a
duplicate. Do not add provider credentials or substitute a mutable image tag.
See `README.md` and `docs/STORAGE.md` for PostgreSQL migrations 006–011,
forward-only rollback, and troubleshooting. M5b/M6 are default-off; configure the reviewed
provider/model boundary described in `README.md`, then run
`npm run smoke:atomic-model`. It makes real model calls and stops before approval
unless the explicit safe-mock test-client override is supplied.

## 10. Copy-paste continuation prompt

Use `docs/NEXT_SESSION_PROMPT.md`. It starts from the live-verified M6 boundary,
keeps both candidates unselected, and scopes the next work to Milestone 7
production connectors and operations.
