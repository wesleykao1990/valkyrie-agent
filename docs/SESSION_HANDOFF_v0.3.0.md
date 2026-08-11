# Session handoff — v0.3.0 plus minimum native pilot

Date: 2026-08-11

## 1. Milestones completed

- Milestone 0: inventory, baseline, plan, rollback/security review.
- Milestone 1: transactional SQLite/PostgreSQL storage behind one contract.
- Milestone 2: independently verified, non-live Atomic Workflow Architect module
  integration.
- Milestone 3a: authenticated, disabled-by-default **minimum native connectivity
  slice** for Atomic offline discovery, direct read-only Codex/Claude, isolated
  Hermes MCP, and bounded Project Brain retrieval/proposal/preview/rejection.

Milestone 3a does not complete Atomic model/workflow execution. No writer, PR,
merge, deploy, Linear, or OpenViking action was added.

## 2. Architecture preserved

Hermes remains an interface, Linear remains roadmap authority, Git/checks remain
implementation truth, and accepted Project Brain Markdown remains decision truth.
The control plane owns stable IDs/policy/budgets/approvals/leases/events; each
native runtime owns its session. Every run has one root runtime and its own
workspace/lease. Atomic is not orchestrated by Codex or Claude. Automatic
episodic capture and silent canonical promotion remain disabled.

## 3. Implementation/files changed

Storage/package work remains summarized in `docs/IMPLEMENTATION_PLAN_M1_M2.md`.
The native pilot primarily adds or changes:

- runtime boundary: `atomic-rpc-client.ts`, `atomic-runtime-adapter.ts`,
  `direct-cli-runtimes.ts`, `runtime-registry.ts`, `runtime.ts`, `service.ts`;
- security/config/transports: `auth.ts`, `config.ts`, `server.ts`, control-plane
  `index.ts`, MCP `index.ts`, and pilot wrappers under `bin/`;
- Project Brain: `project-brain.ts` plus browser/API memory preview binding;
- setup/smoke: `setup-local-pilot.ts`, `setup-hermes-profile.ts`,
  `live-native-smoke.ts`, fake runtime processes, and package scripts;
- tests: Atomic RPC/adapter, direct runtimes, native service integration, bearer
  HTTP/MCP, Project Brain, lifecycle/reconciliation, and policy coverage;
- operations/docs: README, API, Hermes, security, verification, scope, plan,
  proposed ADR-P003, provenance, and this continuation handoff.

Use `git diff --stat` and the draft PR for the exact path list.

## 4. Tests and verification evidence

- TypeScript strict check: passed.
- General suite: 77 tests; 76 passed, 0 failed, 1 optional PostgreSQL case skipped
  in the general phase.
- Tests cover bounded LF framing, raw-first persistence, exact versions,
  environment filtering, malformed/oversized output, start/exit/cancel/kill races,
  non-resumable restart reconciliation, marker-only direct objectives, launch
  schema, context/run-contract checksums, bearer auth, MCP allow-list, structural
  memory authority, context-directory symlink containment, bounded shutdown with
  open SSE, and exact short-lived preview rejection.
- Live native smoke: passed for Atomic, Codex, and Project Brain; Claude skipped
  for its documented missing key. Exact counts are in `docs/VERIFICATION.md`.
- Hermes MCP test: passed with 11 restricted tools; isolated-profile built-in
  tools were zero and memory/user-profile contribution was zero bytes.

The final repository-wide `npm run verify` passed, including 16/16 disposable
PostgreSQL 16.14 tests, Atomic package verification, authenticated HTTP smoke, and
authenticated MCP smoke. Exact phase evidence is in `docs/VERIFICATION.md`.

## 5. Live integrations actually exercised

- Local SQLite and the previously verified disposable PostgreSQL 16 adapter.
- Local HTTP and stdio MCP with bearer authentication.
- Atomic 0.9.12 real process in credential-free offline RPC/package-discovery
  mode: 10 raw records, 4 artifacts, no model call; latest run
  `run_0c3a55c4-aafb-4d60-a670-8d3ce46821ae`.
- Codex CLI 0.147.0-alpha.6.5 with existing ChatGPT authentication: real
  read-only marker call, 4 raw records, 3 artifacts; latest run
  `run_299b4665-822d-4f45-ae1b-66d34bd96eb0`.
- Local Project Brain accepted search, proposal, exact preview, and rejection; no
  canonical promotion in the live smoke.
- Hermes 0.19.0 isolated-profile MCP configuration/test: 11 tools discovered,
  all built-in CLI tools and built-in/user-profile memory disabled. Hermes using
  `gpt-5.6-sol`/`openai-codex` successfully called `runtimes_status` and
  `memory_search`, returning `VALKYRIE_HERMES_MCP_OK` and
  `VALKYRIE_HERMES_MEMORY_OK`. An earlier `gpt-5.3-codex` selection failed HTTP
  400 before a response because that model is unsupported on the ChatGPT-account
  Codex endpoint; it was not counted as a pass.

Not exercised: live Claude model (no allow-listed `ANTHROPIC_API_KEY`), Atomic
model workflow, Linear, OpenViking, GitHub PR API, writer container/VM, mobile
gateway, external outbox, merge, or deployment.

## 6. Known limitations and risks

- Atomic success means offline package discovery only.
- Direct model prompts accept fixed markers only and end at `analysis_only`.
- A workspace/worktree plus lease is not a security sandbox; native writer mode is
  intentionally unreachable.
- Bearer auth is local pilot protection, not production identity/authorization or
  mobile channel attestation. Static assets and health remain public.
- Native subprocesses cannot resume across control-plane restart; orphans fail
  conservatively with `crossProcessResume=false`.
- Claude ignores OAuth/keychain login and needs a dedicated API key.
- Hermes same-Mac stdio MCP works; phone-facing access does not.
- Project Brain filesystem promotion and database resolution are not one atomic
  transaction. Promotion previews expire after 15 minutes (30-second future skew
  tolerance), and the pilot MCP cannot promote.
- No external outbox publisher/retention job, writer heartbeat/fencing,
  container policy, artifact secret scan, or connector credential broker exists.
- Search results are authority-labeled but may include advisory notes; only the
  accepted-canonical subset is authoritative and eligible for runtime context.
- New POSIX server state uses an owner-only `077` umask. Files created by an older
  checkout keep their previous mode, and Windows needs an equivalent private ACL;
  harden or recreate old state before shared-host use.
- Atomic is top-level pinned to 0.9.12, but the ignored live installation has no
  committed transitive lockfile; a fresh install can resolve different transitives.
- Hard crash/SIGKILL and descendant-process cleanup still require the external
  container/VM boundary; the in-process graceful shutdown path is bounded.
- The nested Atomic package remains `UNLICENSED` despite public repository
  visibility.

## 7. Manual setup still required

- Run `npm ci`, `npm run setup:atomic`, and `npm run setup:pilot` on a new clone.
- Keep `bin/project-os-pilot-server` running before native/Hermes tests.
- Run `npm run setup:hermes`, then configure inference inside the isolated profile
  with `hermes -p valkyrieeval setup model` before a Hermes model conversation.
- To exercise Claude, inject a dedicated `ANTHROPIC_API_KEY` into the server shell
  and set `CLAUDE_RUNTIME_ENV_ALLOWLIST=ANTHROPIC_API_KEY`.
- Full verification needs PostgreSQL 16 `initdb` and `pg_ctl` on `PATH`.
- Any remote/mobile pilot still needs a separately designed authenticated gateway;
  do not bind this prototype to a LAN/public interface as a shortcut.

## 8. ADRs/decisions requiring Wesley

- Accept/amend ADR-P001 transactional storage/migration/idempotency semantics.
- Reconcile Atomic addendum A-01 through A-07 via ADR-P002.
- Accept/amend/reject ADR-P003's read-only native connectivity boundary and fixed
  marker-only direct prompts.
- Choose the external container/VM provider and network/secret policy before
  Milestone 4 writer work.
- Choose the future Hermes mobile ingress identity/authorization boundary.

Public repository visibility was already Wesley's explicit decision. It does not
change the nested Atomic license.

## 9. Exact next commands

Default mock demo:

```bash
npm ci
npm start
```

Native/Hermes pilot:

```bash
npm run setup:atomic
npm run setup:pilot
./bin/project-os-pilot-server
```

In another terminal:

```bash
npm run smoke:native
npm run setup:hermes
hermes -p valkyrieeval mcp test valkyrie_project_os
hermes -p valkyrieeval setup model
hermes -p valkyrieeval chat -t valkyrie_project_os
```

Repository verification:

```bash
npm run verify
```

## 10. Next-session prompt

Copy the fenced prompt in `docs/NEXT_SESSION_PROMPT.md`. The next implementation
boundary is the real workspace/container/VM provider; do not turn connectivity
adapters into writers before that boundary is green.
