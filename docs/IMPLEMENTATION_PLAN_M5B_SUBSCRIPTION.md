# Milestone 5b subscription broker implementation plan

Status: implemented and live-verified on 13 August 2026 for the literal disposable
fixture. The run stopped at its evidence-bound operator gate; no acceptance or
external action was performed.

## Scope

- Add `codex-subscription` beside the existing OpenAI-compatible and explicit
  credential-free-loopback upstreams.
- Preserve the loopback-only host gateway, no-secret bridge, fixed Atomic workflow,
  disposable repository, evidence gate, proposed-only memory, and safe mock final
  action.
- Keep OAuth state in an explicit host-side Codex profile; never copy or mount it
  into the writer.
- Correct the inference ledger for bounded native tool loops rather than changing
  Atomic's graph.

## Files and migrations

- `apps/control-plane/src/codex-subscription-inference.ts`: bounded child,
  protocol translation, native event rejection, usage extraction, cleanup.
- `apps/control-plane/src/config.ts` and
  `apps/control-plane/src/atomic-model-pilot-configured.ts`: fail-closed mode and
  profile selection.
- Store contract, both adapters, migration 008, and shared storage tests: repeated
  changed requests per role, exact-retry rejection, total request exhaustion, and
  separate aggregate token ceilings.
- Focused fake-Codex tests plus policy, gateway, smoke-isolation, documentation,
  manifest, and verification evidence.

## Security and failure behavior

- Command path, expected version, profile root, scratch root, model, and reasoning
  effort are fixed before startup.
- Profile/scratch roots must be absolute private non-symlink directories and must
  not overlap the repository, writer, context, artifact, or provider-state roots.
- Prompts are stdin-only; child environment is constructed from a small allowlist.
- Output is LF-JSONL, byte/record/time bounded, and must include one thread ID,
  exactly one final assistant envelope, one successful terminal record, and
  authoritative usage.
- Internal Codex tool activity, approvals, malformed output, missing usage,
  timeout, cancellation, or uncertain process cleanup fail closed without a model
  response being returned to Atomic.
- No token, auth path, prompt, response body, or raw child diagnostic is written
  into the inference ledger.

## Tests

1. Fake child proves argv/env/stdin isolation and Chat Completions translation.
2. Tool-call and final-message envelopes are schema validated.
3. Tool activity, malformed JSONL, missing usage, wrong version/auth mode,
   output overflow, timeout, cancellation, and TERM-to-KILL behavior fail closed.
4. SQLite and PostgreSQL share migration/replay/request-count/token-budget tests.
5. Normal `npm run verify` strips subscription configuration and makes no live
   Codex request.
6. Opt-in live preflight proves only exact CLI version, ChatGPT auth mode, model
   availability/marker output, and native usage before the full Atomic pilot.

## Live outcome

The dedicated profile was authenticated directly and the broker marker passed.
The end-to-end run `run_6423f043-0abc-40c0-a7cc-a398633ba949` then completed the
Atomic implementer, initial fresh verifier, deterministic final checks, and final
fresh verifier using `gpt-5.6-sol`. It exported 11 governed artifacts, removed the
container/worktree, released the writer lease, and stopped at approval
`approval_atomic_model_7817fe4297c19c7126b580b2d0dad754`. No repair, API key,
external action, or automatic memory promotion occurred.

On macOS/Colima, a host Unix socket cannot be bind-mounted into the Linux VM with
the required semantics. The verified implementation therefore binds the gateway
to host loopback and uses a fixed credential-free proxy container attached to the
writer's internal network and Docker's bridge. The writer itself remains only on
the internal network; the proxy has no credential or general caller-controlled
command surface.

## Post-M6 efficiency follow-up

Migration 011 adds stable provider-thread/reuse evidence and a one-active-turn
constraint per capability/role. The host broker now creates one process-local
Codex thread for the first role turn and resumes it with only appended messages.
Role lineages remain separate and ambiguous failures poison continuation. A new
control-plane process refuses a durable thread ID because cross-process ownership
has not been proven. See `docs/IMPLEMENTATION_PLAN_POST_M6_GAPS.md`.

## Rollback

Migration 008 is checksummed and forward-only. Binary rollback requires a
verified pre-v8 database backup or a separate compatible database. Disabling the
feature requires only stopping the server and unsetting its feature flag; keep
the dedicated Codex profile until evidence review or explicitly log it out.
