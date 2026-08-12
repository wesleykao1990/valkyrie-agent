# Continuation prompt — select and run the live M5b model pilot

Continue the existing public `valkyrie-agent` repository and draft PR #1. Do not
create a new repository, substitute another agent framework, expose a generic
writer, or redesign the accepted architecture.

## Read and verify first

Read `START_HERE.md`, `AGENTS.md`, `.project-context.yaml`, `CLAUDE.md`,
`docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/CONTINUATION_PLAN.md`,
`docs/PROTOTYPE_SCOPE.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `SECURITY.md`,
`docs/VERIFICATION.md`, `docs/SESSION_HANDOFF_v0.3.0.md`,
`docs/IMPLEMENTATION_PLAN_M5B_PRELIVE.md`, and
`docs/adr/ADR-P006-scoped-inference-boundary.md`. Then read the Atomic package in
the order documented by its `START_HERE.md` and run `npm run verify`.

## Existing boundary

Milestones 0–4 and the fixed M5a tool-only slice are implemented. M5a was
live-verified with Atomic 0.9.12, no network/model, deterministic checks, governed
evidence, exact cleanup, safe mock acceptance, and proposed-only memory.

The credential-free M5b implementation is also complete and default-off:

authenticated fixed MCP/HTTP request → transactional one-run admission → bounded
Project Brain pack → exact worktree/fence/container → private internal-network
gateway capability → Atomic implementer → deterministic checks → fresh verifier
→ at most one implementer-continuity repair → final checks/new fresh verifier →
frozen/secret-scanned governed evidence → bridge/container/worktree/lease cleanup
and capability revocation → bounded artifact review → evidence/policy/expiry-bound
operator gate → safe mock receipt → proposed-only memory.

SQLite and PostgreSQL execute the same lifecycle. Durable claim retry,
cancellation, restart reconciliation, artifact tamper rejection, approval/capability
expiry, raw Atomic evidence, exact runner/package/policy binding, and failure cleanup
are deterministic-test green. `crossProcessResume=false`; real PR/merge/deploy and
canonical memory promotion remain separate and unimplemented.

## Mission

Choose one reviewed provider/model or credential-free local OpenAI-compatible
endpoint with Wesley. Configure only the existing fixed M5b boundary and run the
live disposable fixture. Do not generalize repository, task, objective, workflow,
commands, artifact manifest, image, model selection, or final action.

For an external provider:

- use an HTTPS `/v1` endpoint;
- place one dedicated low-limit token in a private regular non-symlink 0600 file;
- configure explicit input/output micro-USD prices and a spend ceiling;
- never pass provider/OAuth/subscription credentials to Atomic, the writer,
  arguments, environment, prompts, events, artifacts, Hermes, or Git.

For a local endpoint, require explicit credential-free loopback opt-in. In both
cases create and inspect one dedicated local Docker bridge with `Internal=true`,
use the accepted immutable runner and package digests, set a real operator ID,
and keep the provider behind the private Unix-socket gateway. Do not mount
`~/.atomic`, `~/.codex`, `~/.claude`, browser/keychain state, Docker socket, SSH
agent, or broad cloud configuration.

## Live procedure and evidence

1. Back up any persistent pre-v7 database and configure the commented
   `ATOMIC_FIXTURE_MODEL_*` values in `.env.example` without committing secrets.
2. Start the default-off authenticated server and verify `runtimes_status` reports
   the exact runner and model pilot available before any provider call.
3. Run `npm run smoke:atomic-model`. It must make the real model requests, verify
   exact native/usage/artifact/cleanup state, and stop at `awaiting_approval`.
4. Have Wesley read the patch, final deterministic checks, final fresh verifier,
   and evidence manifest through the bounded artifact tool. Do not describe the
   smoke itself as independent human review.
5. Resolve approve/deny/request-changes separately through Hermes. Approve may
   record only the safe mock receipt.
6. Record exact provider/model, Atomic main/workflow/stage IDs and cursor, request
   IDs/hashes, tokens, micro-cost and USD cost, repair count, checks/verifier,
   immutable image/package/policy digests, all 11 governed artifacts, capability
   terminal state, bridge/container/worktree/lease cleanup, approval actor/time,
   and proposed-memory state in `docs/VERIFICATION.md`.
7. Rerun `npm run verify`; normal verification must still strip every model flag,
   endpoint, and credential and make no provider call.

Do not call the live pilot passed unless an actual provider/model request was
observed through the scoped gateway. A fake/fixture response is contract evidence
only. Stop on any provider incompatibility, model error, budget/token/time breach,
deterministic-check failure after the one repair, verifier rejection, evidence
tamper, secret finding, capability/lease loss, or cleanup uncertainty.

## Next boundary after live M5b

Milestone 6 compares Atomic with direct Codex or Claude Code under the same literal
task contract, separate worktrees, deterministic checks, budgets, verifier rubric,
and approval boundary. Do not make Atomic the default until that comparison has
evidence. A real GitHub draft PR remains a separate newly authorized final action.

Return the standard ten-part report: milestone completed, architecture preserved,
files changed, tests/evidence, live integrations actually exercised, limitations,
manual setup, Wesley decisions, exact next commands, and the next copy-paste
continuation prompt.
