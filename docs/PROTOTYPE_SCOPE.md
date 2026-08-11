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

## Default behavior remains simulated

`npm start` still selects deterministic mocks for Atomic, Codex, Claude, Prime,
and Hermes. The browser walkthrough uses these fixtures and labels their
events/evidence accordingly. The default requires no credential, PostgreSQL
server, Atomic install, Codex/Claude provider, or Hermes login.

Linear remains a seeded local task projection; no live roadmap read/write occurs.
GitHub PR preparation in mock flows is evidence text only. Project Brain retrieval
is local Markdown, not OpenViking.

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
  TLS, backup/restore, monitoring, retention, and an outbox dispatcher.
- Run/lease claims have ownership and expiry, but a real long writer needs renewal,
  fencing, kill-on-lease-loss, orphan quarantine, and cleanup.
- Native subprocess durability does not cross control-plane restart; restart
  reconciliation fails non-resumable orphans conservatively.
- Memory promotion validates the exact preview and file target but cannot make the
  filesystem write and database resolution one atomic transaction.
- Raw native events/artifacts have bounds but need deployment retention/redaction/
  deletion policy.

## Not implemented or enabled

- External container/devcontainer/VM writer sandbox, network policy, secret
  broker, artifact export/secret scan, or production credential injection.
- Real repository implementation by Atomic, Codex, or Claude; deterministic
  check/repair/reviewer pipeline; draft PR creation; merge; deploy.
- Atomic model workflow, HIL response mapping, steering, pause/resume, or proven
  DBOS/PostgreSQL cross-process durability.
- Direct native in-flight steering, resume, or approval mapping.
- Phone/mobile Hermes gateway, remote ingress, per-user policy, or production
  channel authentication.
- Live Linear connector, GitHub connector, OpenViking provider/evaluation, webhook
  validation, or external outbox publishing.
- Automatic episodic memory capture or automatic canonical-memory promotion.

No successful connectivity marker should be interpreted as code correctness,
delivery acceptance, production readiness, or permission for a higher-risk final
action.
