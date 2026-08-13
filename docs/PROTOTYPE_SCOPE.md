# Prototype scope and honesty statement

Version: 0.3.0
Pilot: proposed ADR-P003 read-only native connectivity slice

## Implemented and contract-tested

- Projects, tasks, runs, normalized/raw-native events, approvals, artifacts,
  governed memory proposals, workspace records, and writer leases.
- SQLite and PostgreSQL behind one async storage contract, with checksummed
  migrations, transactional aggregates, idempotency, outbox rows, claims, restart
  reconciliation, and ownership constraints.
- Loopback HTTP, authenticated `/api/*`, SSE, and bearer-authenticated stdio MCP
  with a validated server-side tool allow-list.
- Runtime registry/preflight with explicit mock/native selection and no silent
  native-to-mock fallback.
- Strict bounded LF-JSONL Atomic RPC client plus adversarial fake process tests.
- Atomic 0.9.12 offline connectivity adapter: exact pin, one main session,
  imported-package command/skill/workflow discovery, launch-manifest schema,
  raw-event retention, cursor/artifact evidence, and
  `crossProcessResume=false`.
- Direct Codex/Claude adapters: exact pins, constrained marker-only objectives,
  read-only/bare command flags, prompt over stdin, minimal child environment,
  raw-first event persistence, native IDs, output/time bounds, termination,
  evidence artifacts, and lease release.
- Pre-spawn workspace/context-directory containment rejects symlink escapes; bounded
  shutdown terminates open SSE connections before adapter/store cleanup can hang.
- Bounded accepted-canonical Project Brain context packs; structural authority and
  stale/superseded suppression; automatic episodic capture disabled.
- Separate memory proposal, exact preview, tamper-resistant promotion, and
  rejection operations. Pilot MCP excludes promotion.
- Empty dedicated Hermes evaluation profile setup with built-in CLI toolsets and
  memory/profile injection disabled.
- Deterministic fake-runtime tests plus opt-in `smoke:native` for a running local
  pilot.
- Forward migration 004 and SQLite/PostgreSQL parity for explicit writer-lease
  owners, monotonic fencing tokens, heartbeat renewal, exact release, durable
  quarantine, and idempotent transactional artifact batches.
- Forward migration 005 and SQLite/PostgreSQL parity for durable exact-fenced
  sandbox-instance lifecycle and provider restart evidence.
- Internal disabled writer-boundary contract: a private shallow Git store plus one
  relative worktree, a Docker-compatible OCI provider with effective-policy
  inspection and no ambient credentials, host-owned heartbeat and ownership-
  aware lease-loss stop/quarantine, bounded manifest export, deterministic
  baseline secret scanning, cleanup, and quarantine. Fake/provider orchestration,
  provider-aware restart recovery, and the explicit local Colima/Docker live
  fixture smoke pass.
- Default-off fixed M5a composition: real Atomic 0.9.12 tool-only workflow in the
  live OCI writer, deterministic checks/fresh deterministic review, frozen governed
  artifacts, exact cleanup, evidence-bound safe mock acceptance, and proposed-only
  memory.
- Default-off M5b live-verified composition: fixed Atomic model workflow, four model
  roles, one repair, scoped private inference gateway, internal network bridge,
  authenticated lifecycle/artifact/approval surface, SQLite/PostgreSQL parity,
  and migration 008 for at most 16 changed native tool-loop requests with exact
  replay rejection.
- Host-side Codex subscription broker: dedicated authenticated ChatGPT profile,
  process-local role-scoped retained threads, appended-message continuation,
  read-only structured turns, disabled native tool surfaces, stdin-only prompts,
  bounded JSONL/usage, and no OAuth export or writer mount. Fake-child contracts
  plus dedicated-profile marker and end-to-end Atomic model evidence are recorded;
  restart resume remains disabled.
- M8a managed skill-suite admission: exact policy/source digests, bounded
  `SKILL.md` discovery, derived capability classification, private
  content-addressed generations, compatible/manual update behavior, capability-
  expansion quarantine, explicit activation/rollback, immutable runtime packs,
  and authenticated path-opaque status. No third-party setup or skill code is
  executed by this boundary.

## Default behavior remains simulated

`npm start` still selects deterministic mocks for Atomic, Codex, Claude, Prime,
and Hermes. The browser walkthrough uses these fixtures and labels their
events/evidence accordingly. The default requires no credential, PostgreSQL
server, Atomic install, Codex/Claude provider, or Hermes login.

Linear remains a seeded local task projection by default; no live roadmap
read/write occurs unless the default-off M7 connector and an accepted policy are
configured. Even then ordinary task creation stays local: each issue/comment
requires its own evidence-bound plan and approval. GitHub PR preparation in mock
flows is evidence text only. Project Brain retrieval is local Markdown, not
OpenViking.

## Opt-in native pilot behavior

`bin/project-os-pilot-server` selects native Atomic/Codex/Claude adapters behind
bearer-authenticated loopback HTTP:

- Atomic performs credential-free offline process/package discovery only. It does
  not call a model or execute an implementation workflow.
- Codex makes a real read-only, ephemeral model call when its pinned CLI and login
  preflight pass.
- Claude optionally makes a real bare model call only with an explicitly
  allow-listed `ANTHROPIC_API_KEY`; OAuth/keychain state is ignored.
- All direct prompts are fixed connectivity markers. Every run ends at
  `analysis_only`; no writer/final action is reachable.
- Hermes can exercise the pilot through an authenticated local stdio MCP child.
  Model-driven `runtimes_status` and Project Brain search were exercised with
  `gpt-5.6-sol`/`openai-codex`. This remains same-Mac CLI integration, not a
  phone-facing gateway.

See `docs/VERIFICATION.md` for what was actually exercised on the release host;
implemented capability and live exercise are reported separately.

## Implemented but not production-complete

- Bearer auth protects the pilot API but is not user/device identity, fine-grained
  authorization, expiry/rotation/revocation, or remote channel attestation.
- PostgreSQL is contract-tested; production still needs deployment-specific roles,
  TLS, backup/restore, monitoring, retention operations, and deployment of the
  default-off connector dispatcher against accepted live policy.
- The writer boundary has renewal, fencing, ownership-aware stop/quarantine,
  cleanup, live-engine evidence, and provider-aware restart recovery for the
  fixed fixture. It is not a general writer or production sandbox service.
- Native subprocess durability does not cross control-plane restart; restart
  reconciliation fails non-resumable orphans conservatively.
- Memory promotion validates the exact preview and file target but cannot make the
  filesystem write and database resolution one atomic transaction.
- Raw native events/artifacts have bounds but need deployment retention/redaction/
  deletion policy.

## Not implemented or enabled

- Native managed-suite projection into Codex/Claude Code, Atomic specialist
  delegation, a general launcher that consumes capability packs, remote suite
  fetch/dependency setup, or governed web/browser capability brokering. The M8a
  catalog alone does not make an admitted skill executable.

- General/confidential repository writing, production credential injection, or a
  separately isolated credential-broker service. The current subscription broker
  is restricted to the disposable fixture.
- Wesley's separate decision on a fresh M5b evidence gate; real draft PR creation,
  merge, deploy, or product-database action.
- General Atomic HIL response mapping, model-stage steering, or proven DBOS/
  PostgreSQL cross-process durability.
- Direct native in-flight steering, resume, or approval mapping.
- Phone/mobile Hermes gateway, remote ingress, per-user policy, or production
  channel authentication.
- Live Linear connector, GitHub connector, OpenViking provider/evaluation, webhook
  validation, or external outbox publishing.
- Automatic episodic memory capture or automatic canonical-memory promotion.

No successful connectivity marker should be interpreted as code correctness,
delivery acceptance, production readiness, or permission for a higher-risk final
action.
