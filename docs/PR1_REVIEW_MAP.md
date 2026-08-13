# PR #1 review map

Reviewed baseline: `5e7a80dc9b34d08f1b8bcc07e7d5054c308b32c2`

Branch: `agent/postgres-atomic-integration`

Scope: governed v0.3 foundation plus release stabilization; no M9+ product work.

Use this map to review by authority/security boundary instead of treating the
large PR as one undifferentiated patch. Repository-recorded live evidence is
summarized here but remains qualified by `docs/VERIFICATION.md`.

## Storage and migrations

- Invariants: one async store contract; SQLite demo and opt-in PostgreSQL parity;
  checksummed forward-only migrations; atomic idempotency/outbox/approval/fence
  transitions; no automatic SQLite→PostgreSQL copy or fallback.
- Key files: `store.ts`, `sqlite-store.ts`, `postgres-store.ts`, `migrations.ts`,
  `store-factory.ts`, `scripts/migrate-storage.ts`.
- Tests: `storage.test.ts`, `atomic-model-pilot-lifecycle.test.ts`, and
  `scripts/test-postgres-storage.ts`.
- Live evidence: disposable PostgreSQL 16 storage and model-lifecycle contracts.
- Unexercised: persistent production roles/TLS/backups/restore/monitoring and
  horizontal native-runtime ownership.
- Reviewer checklist: compare both adapters; verify constraints and transaction
  boundaries; inspect migration checksums/rollback notes; reject secret-bearing
  errors or silent backend fallback.

## Atomic transport and runtime

- Invariants: one Atomic root/main session; strict bounded LF-JSONL; raw native
  records precede normalized projection; exact version/workflow/manifest; no
  false native resume or silent native→mock fallback.
- Key files: `atomic-rpc-client.ts`, `atomic-runtime-adapter.ts`,
  `atomic-workflow-protocol.ts`, `atomic-fixture-pilot.ts`,
  `atomic-model-workflow-executor.ts`, `atomic-model-pilot-*`, and the nested
  `packages/atomic-workflow-architect/` subtree.
- Tests: Atomic RPC/runtime/protocol, fixture/model workflow/coordinator, and
  package `verify:all` suites.
- Live evidence: Atomic 0.9.12 offline discovery; fixed M5a tool-only workflow;
  fixed M5b subscription-backed workflow through evidence gate.
- Unexercised: arbitrary-project Atomic launch, native cross-process durability,
  general HIL/pause/resume/steering, and production final action.
- Reviewer checklist: preserve Atomic workflow ownership, framing/output/time
  bounds, raw evidence order, package/version/license pins, and honest capability
  flags.

## Writer sandbox

- Invariants: private shallow Git store; separate worktree; one owner/fencing
  token; immutable image; no ambient credentials/socket; no-network/default
  egress; non-root/read-only/cap-drop/seccomp bounds; exact owned cleanup before
  lease release; ambiguity quarantines.
- Key files: `writer-workspace.ts`, `writer-lease-supervisor.ts`,
  `writer-sandbox-boundary.ts`, `oci-sandbox-provider.ts`,
  `governed-artifact-export.ts`, and `docker/atomic-runner/`.
- Tests: writer workspace/lease/boundary, OCI provider, governed export, and
  restart/reconciliation cases.
- Live evidence: local Colima/Docker fixture policy, export, and cleanup; fixed
  M5/M6 isolated writers.
- Unexercised: confidential hostile multi-tenant workloads, remote micro-VMs,
  general repository writers, and horizontal cancellation ownership.
- Reviewer checklist: trace every cleanup/fence failure; verify container labels,
  mounts/network/user/image; ensure artifacts are bounded/no-follow/secret-scanned;
  reject any developer-checkout or credential mount.

## Scoped inference

- Invariants: provider/OAuth stays host-side; writer receives an opaque expiring
  capability only; role/model/usage/cost/time/request hashes are bounded;
  credentials are not stored; native tool activity fails; process-lost session
  continuity is refused.
- Key files: `scoped-inference-gateway.ts`, `scoped-inference-bridge.ts`,
  `codex-subscription-inference.ts`, `atomic-model-pilot-prelive.ts`, and config.
- Tests: scoped gateway/bridge, subscription broker, configured/pre-live/model
  lifecycle, and deterministic fake upstreams.
- Live evidence: dedicated ChatGPT subscription profile on fixed M5b/M6 fixtures
  and same-role two-turn process-local continuity.
- Unexercised: general prompts, production credential broker isolation, Claude
  writer auth, cross-process resume, and provider dollar-cost attestation.
- Reviewer checklist: confirm no OAuth/profile mount, exact capability accounting,
  network bridge isolation, role lineage separation, and ambiguous-failure poison.

## Comparison and routing

- Invariants: candidates have independent writers/evidence/approvals; comparison
  does not select a default; preference is upward-only; engineering uses the
  Direct/Atomic Lite/Atomic Full rubric; role is separate from runtime; research
  does not imply Prime; general launch stays fail-closed.
- Key files: `direct-model-pilot.ts`, `policy.ts`, `service.ts`, migrations
  009–011, and Atomic Lite package workflow/core.
- Tests: `comparison.test.ts`, `direct-model-pilot.test.ts`, `policy.test.ts`,
  `engineering-routing.test.ts`, and `atomic-lite-workflow.test.ts`.
- Live evidence: fixed Atomic/direct Codex M6 comparison and process-local Codex
  continuation; durable assessments were exercised without launch.
- Unexercised: Claude comparison, broad benchmark quality, Research Lead runtime
  selection, and the General Governed Launcher.
- Reviewer checklist: verify no shared candidate state, no research→Prime
  heuristic, explainable/fresh assessment evidence, and no fixture-as-general
  launcher substitution.

## Connectors and external actions

- Invariants: host-only least-privilege credentials; digest-pinned project policy;
  revision-bound Linear/Git reads; per-consumer fenced delivery; immutable
  evidence/policy/expiry-bound action plan; exact approval; ambiguous effects are
  reconciled, never blindly retried; GitHub draft only from pre-existing head.
- Key files: `connector-policy.ts`, `linear-authority.ts`, `git-authority.ts`,
  `github-draft-pr-gateway.ts`, `production-connectors.ts`,
  `external-final-action.ts`, migrations 012–013, and M7 runbook.
- Tests: connector policy, Linear/Git/GitHub gateway, production connector,
  external-action, service HTTP/MCP boundary, and PostgreSQL claim contention.
- Live evidence: read-only Linear project and local clean Git authority.
- Unexercised: Linear writes, GitHub requests/draft creation, branch publication,
  merge, deploy, OpenViking transport, and multi-user actor attestation.
- Reviewer checklist: verify caller cannot supply URL/path/ref/command/target/body;
  recheck authority immediately before spend; inspect idempotency marker and
  timeout/reconciliation paths; confirm ordinary task events have no writer.

## Project Brain

- Invariants: accepted Markdown is canonical project rationale; retrieval is
  read-only and namespace-bound; stale/rejected/superseded entries are excluded
  from run context; proposal/preview/promotion are separate; agents propose and
  humans promote.
- Key files: `project-brain.ts`, `project-brain-provider.ts`,
  `project-brain-evaluation.ts`, `project-brain/`, and ADR/docs.
- Tests: Project Brain, provider, evaluation, service, HTTP, and MCP cases.
- Live evidence: accepted local search and proposal/preview/rejection; disposable
  smoke promotion only.
- Unexercised: live OpenViking, GBrain, personal profile, automatic capture, and
  production canonical promotion.
- Reviewer checklist: inspect authority/status labels, project isolation,
  containment/hash/expiry, and ensure advisory memory never overrides
  Linear/Git/accepted decisions.

## Managed skills

- Invariants: exact upstream bytes; pinned strict YAML dialect; missing/malformed/
  ambiguous/unknown authority is operator-gated; source/body/name inspection is
  additive only; exact policy-digest overrides; expansion quarantine; rehash on
  use; Hermes request-only; admission never executes setup/dependencies/skills.
- Key files: `managed-skill-suites.ts`, `manage-skill-suite.ts`, example policy,
  M8 plan, and ADR-P011.
- Tests: `managed-skill-suites.test.ts` covers both authority fields, inline/block/
  multiline YAML, absence/malformed/duplicates/conflicts/nesting/unknown tools,
  executables, package lifecycle, MCP risk, override, quarantine, drift, and pack
  tampering.
- Live evidence: none; deterministic local catalog only.
- Unexercised: native Codex/Claude projection, Atomic delegation, remote fetch,
  dependency setup, browser/network broker, and GStack.
- Reviewer checklist: test fail-closed edge cases; compare detected requirements
  with overrides; confirm source bytes/modes/digests; ensure no gated skill enters
  ordinary packs and no projection exists.

## HTTP and MCP

- Invariants: loopback plus bearer for native/mutating pilots; exact bounded DTO
  keys; restricted Hermes allowlist; no raw process/filesystem/container/
  credential control; path-opaque evidence; static bearer is not human identity.
- Key files: `server.ts`, `http.ts`, `auth.ts`, `service.ts`,
  `apps/mcp-server/src/index.ts`, and API/Hermes docs.
- Tests: server auth, MCP auth, shutdown, service integration, HTTP smoke, MCP
  smoke, and production connector route cases.
- Live evidence: authenticated loopback HTTP and stdio MCP/Hermes pilot.
- Unexercised: remote TLS ingress, LINE/Buzz actor identity, scoped grants,
  presentation-safe remote DTOs, revocation, CSRF/device/channel attestation.
- Reviewer checklist: audit every route/tool and input key, authentication before
  parsing/spend, error/path redaction, allowlists, idempotency, and shutdown.

## Docs and tests

- Invariants: deterministic/contract/live claims remain distinct; opt-in live
  paths never run in normal verification or CI; security/setup/rollback/version/
  license limitations stay current; architectural change gets a proposed ADR.
- Key files: bootstrap README/START_HERE/context, Decisions/Architecture/Security/
  Verification/Continuation/Handoff, `docs/CI.md`, this map, all tests/scripts,
  package manifests, and `.github/workflows/ci.yml`.
- Tests: `npm run verify` is the aggregate authority; CI exposes each phase and a
  separate secret scan.
- Live evidence: the repository verification record plus exact GitHub checks on
  the stabilized head.
- Unexercised: every opt-in provider/connector/write smoke in CI and all M9+
  product capabilities.
- Reviewer checklist: confirm exact SHA and dependency/action pins, test/skip
  counts, absence of credentials/absolute private paths, link validity, qualified
  claims, current PR not-built list, and nested Atomic license preservation.

## PR #1 explicit not-built / not-exercised list

PR #1 does not provide the General Governed Launcher; production actor identity;
remote mutating LINE/Buzz ingress; shared LINE/Buzz conversations; GBrain;
meetings; commitments; Personal Profile; persistent visible agents; unrestricted
agent communication/delegation; native managed-skill projection; live Claude
writer; live GitHub draft creation; branch publication; merge; deploy; or
automatic canonical promotion. Do not infer any of these from green CI.
