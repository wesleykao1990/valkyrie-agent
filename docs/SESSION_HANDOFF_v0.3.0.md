# Session handoff — v0.3.0 through Milestone 5a

Date: 2026-08-12

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
- The original model-backed Milestone 5 is **not complete**. No Atomic provider/
  model or model verifier was exercised. It remains M5b continuation work behind
  a scoped inference proxy or reviewed local-model boundary.

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
Repository-wide `npm run verify` also passed: strict TypeScript; 188 general tests with 186
passed, 0 failed, and 2 honest opt-in skips; disposable PostgreSQL 22/22; Atomic
package verification; and authenticated HTTP/MCP smokes. The subsequent
audit-only ledger wording repair passed strict TypeScript and its four affected
approval/cancellation integration cases. A requested second full invocation did
not start because the Codex app's approval reviewer had exhausted its usage
quota; this is an unexecuted rerun, not a hidden test failure.

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

Not exercised: Atomic provider/model inference, a model-based verifier, live
Claude model (no allow-listed API key), real GitHub/PR/merge/deploy, Linear,
OpenViking, mobile gateway, external outbox publishing, destructive database
action, production secret, or canonical memory promotion.

## 6. Known limitations and risks

- M5a writes reviewed fixed bytes and has zero repair rounds. It measures
  integration/lifecycle correctness, not agent coding quality.
- Its fresh verifier is deterministic and process-separated, not an independent
  model context. M5b still needs real model implementation/review evidence.
- The writer has network `none` and no provider credential. General or model-
  backed writing is unavailable until inference is scoped outside the writer.
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
- Atomic's fixed internal project/tool trust is pre-approved only inside the
  credential-free, network-none M5a container. The separate control-plane gate is
  operator-intended and evidence-bound, but M5a bearer auth does not attest human
  presence; M5b needs a new reviewed native permission/HIL policy.
- The live smoke's approval was an automated operator-authorized test-client
  action with a fixed pilot principal. M5b needs authenticated actor provenance
  and a real person-in-the-loop review before claiming human acceptance.
- Migration 006 is forward-only. Older binaries reject a v6 ledger; rollback needs
  a verified pre-v6 backup or separate compatible database.
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
- Hermes/Claude/mobile setup remains separate from the M5a writer.

## 8. ADRs or decisions requiring Wesley

- Accept/amend ADR-P001 storage semantics, ADR-P002 Atomic package boundary,
  ADR-P003 native connectivity, and ADR-P004 external writer boundary.
- Accept/amend/reject ADR-P005's split between a credential-free integration proof
  and model-backed quality proof, including zero repairs for the fixed M5a task.
- Choose the M5b inference boundary: reviewed local model or credential-holding
  scoped proxy with run-scoped capability, provider/model/token/cost/time/
  concurrency policy, and no raw provider key inside the writer.
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
See `README.md` for PostgreSQL migration 006, rollback, and troubleshooting.

## 10. Copy-paste continuation prompt

Use `docs/NEXT_SESSION_PROMPT.md`. It starts from the fixed M5a integration slice,
requires its final evidence to be verified first, and scopes the next engineering
work to the model-backed M5b inference boundary rather than broad writer exposure.
