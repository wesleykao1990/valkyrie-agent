# Milestone 3 minimum live-runtime pilot plan

Date: 2026-08-11
Status: implemented and verified

## Run contract

Objective: make the installed Hermes, Codex CLI, Claude Code, the pinned Atomic
0.9.12 RPC boundary, and the governed local Project Brain testable through one
control-plane vertical slice without enabling autonomous repository writes.

Acceptance evidence:

- default `npm start` remains the zero-service SQLite/mock demo;
- bearer-authenticated loopback HTTP and stdio MCP work with a dedicated Hermes
  profile and a server-side tool allow-list;
- runtime preflight reports the configured adapter, exact binary/version,
  authentication readiness where observable, and verified capabilities;
- Atomic, Codex, and Claude native adapters are disabled by default and fail
  closed when their pinned command/protocol is unavailable;
- deterministic fake subprocess tests retain every raw JSONL record, stable
  native IDs, terminal result, malformed framing, cancellation, and unexpected
  exit evidence;
- each run receives a bounded, checksummed Project Brain context pack and literal
  run contract artifact;
- pinned Atomic offline discovery and a read-only live Codex run are exercised on
  this host; the real Claude probe remains optional and may skip only when its
  explicit API-key preflight is unavailable;
- memory search, proposal, review preview, explicit promotion, and rejection
  remain separate operations; the live smoke always previews then rejects;
- `npm run verify` and an independent fresh review pass.

## Non-goals and final-action boundary

- No real runtime may write repository files in this milestone. The host lacks
  the required external container/VM boundary.
- No Linear, GitHub PR, deployment, OpenViking, production secret, remote MCP,
  or automatic memory-promotion integration is enabled.
- Atomic owns its main session and native workflow state; the control plane does
  not drive its individual stages.
- Stop after local read-only integration evidence. PR merge and deployment are
  outside this run contract.

## Planned changes

1. Harden the Atomic LF-JSONL transport and add a fake Atomic subprocess.
2. Add a generic native-event recorder plus read-only Codex/Claude subprocess
   adapters and a pinned Atomic adapter.
3. Extend runtime context with workspace/lease, context-pack, run-contract, budget,
   and final-action references. Persist native session IDs in run metadata.
4. Add feature flags and a runtime registry/preflight endpoint; never fall back
   from an explicitly selected native adapter to a mock.
5. Add optional bearer authentication to `/api/*` and the MCP bridge, plus a
   server-side MCP tool allow-list.
6. Parse accepted Project Brain frontmatter structurally, suppress stale or
   superseded notes, validate vault containment, and create deterministic bounded
   context packs.
7. Add an isolated Hermes setup/test script and live-runtime smoke commands.

## Storage and migration posture

No schema migration is planned for this minimum. Complete native payloads are
stored first as deterministic `runtime.native` run events; normalized sibling
events retain the same native identifiers. This uses the existing transactional,
idempotent event/outbox contract. A dedicated native-event table remains a later
optimization if query volume or independent retention requires it.

## Rollback

- Unset all `*_ADAPTER=native` flags to restore mock adapters.
- Unset the control-plane auth token only for the disposable loopback mock demo;
  native adapters refuse to start without authentication.
- Remove the ignored local Atomic installation/runtime data; no canonical
  Project Brain content or external roadmap state is required for rollback.
- Revert this milestone's commit. No database down migration is required.

## Security impact

- Native execution is read-only and local-only.
- Child environments are allow-listed and raw payloads are never written to
  process logs by the control plane.
- Tokens may come from environment variables or bounded local files and are never
  returned through HTTP/MCP.
- Hermes built-in CLI toolsets, memory, and user-profile injection are disabled in
  the evaluation profile so they cannot contaminate the first Project Brain/MCP
  test.
- Writer mode remains blocked until a container/VM provider, lease heartbeat and
  fencing, secret scan, and kill-on-lease-loss path exist.
