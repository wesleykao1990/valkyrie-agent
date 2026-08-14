# ADR-P003: Read-only native-runtime pilot boundary

- Status: Proposed
- Date: 2026-08-11
- Decision owner: Wesley Kao
- Implementation status: minimum connectivity slice implemented and verified;
  decision pending

## Context

The default control plane still registers scripted adapters only. The opt-in pilot
can register pinned Atomic 0.9.12, Codex CLI 0.147.0-alpha.6.5, and Claude Code
2.1.81 adapters. This host has authenticated Codex CLI; Claude requires a separate
explicit API key; Hermes needs inference configured inside its isolated profile;
and no Docker/Podman execution boundary exists. The architecture forbids real
writing agents outside a container or VM.

## Proposed decision

1. Introduce disabled-by-default native adapters in `read-only` mode only.
2. Use Atomic 0.9.12 strict LF-delimited RPC as a first-class root runtime; keep
   `crossProcessResume=false` until external PostgreSQL durability survives a
   process-kill/restart test.
3. Use Codex non-interactive JSONL and Claude Code stream-JSON for the first direct
   runtime probes. Advertise no in-flight steering/resume capability that these
   minimum adapters do not exercise.
4. Persist every complete native record before its normalized projection using
   deterministic run-event IDs, while retaining stable native session/workflow
   identifiers in run metadata.
5. Require authenticated loopback API/MCP access whenever any native adapter is
   selected. Hermes receives only the explicitly allow-listed control-plane tools.
6. Snapshot a bounded accepted-Markdown context pack for every run. Runtime
   session history and Hermes built-in memory remain advisory/non-authoritative.
7. Keep repository writes, internal Atomic HIL answer mapping, PR creation,
   cross-process resume, and remote/mobile exposure disabled until their separate
   contracts are positively verified.

## Consequences

- Wesley can test real provider/runtime connectivity without weakening workspace
  isolation policy.
- A successful read-only probe is integration evidence, not implementation or
  delivery evidence.
- Claude and Hermes model tests still require user-owned authentication. Atomic's
  implemented pilot is credential-free offline package discovery only; provider
  authentication and Atomic model execution remain deferred until the external
  sandbox boundary exists.
- Moving from subprocess probes to Codex app-server or the Claude Agent SDK is a
  later, separately pinned protocol decision.

## Approval requested

Accept, amend, or reject this read-only pilot boundary before enabling any native
writer mode.
