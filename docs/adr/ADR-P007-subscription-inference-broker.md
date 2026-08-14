# ADR-P007: subscription-backed Codex inference broker

Status: proposed

## Context

Milestone 5b already keeps provider credentials outside the Atomic writer behind
an opaque run-scoped inference capability. Its first external upstream assumes an
OpenAI-compatible HTTPS endpoint and an API credential. Wesley prefers to use an
existing ChatGPT Plus/Pro subscription when the provider supports it.

Pinned local Codex 0.147.0 reports `Logged in using ChatGPT`, and both a bounded
broker marker and the complete disposable Atomic model workflow ran with native
token usage on 2026-08-13. OpenAI API authentication remains a separate API-key and billing
surface; a ChatGPT subscription token must not be re-labelled as an API key.

Atomic model stages use native custom tools and structured output. One stage may
therefore require several provider turns: request a fixed read/write tool, receive
the tool result, and then call `structured_output`. The pre-live ledger's original
one-request-per-role rule cannot execute that native loop and must not be claimed
as a live-ready model boundary.

## Proposed decision

Add a second, default-off upstream mode named `codex-subscription`:

1. A host-side broker launches the exact pinned Codex CLI with a separately
   selected `CODEX_HOME`. Codex owns ChatGPT OAuth acquisition and refresh.
2. The broker runs in a private empty scratch root with ignored user configuration
   and rules, read-only sandboxing, no repository, and prompts only on stdin. It
   never exports, parses, or logs an OAuth token.
3. The writer still receives only the existing opaque Valkyrie capability and
   internal gateway URL. It never receives `CODEX_HOME`, `auth.json`, a subscription
   bearer, browser/keychain state, or provider network access.
4. The broker translates the fixed OpenAI-compatible model/tool conversation into
   one constrained Codex turn and translates the structured result back into a
   Chat Completions assistant message or tool-call response. Any Codex command,
   file-change, MCP, web, browser, subagent, or other tool event fails the request.
5. Subscription usage is accounted with Codex's native input/output token record.
   Dollar cost remains zero/unknown for the subscription path and is never
   represented as avoided API spend. Request, aggregate token, elapsed-time, and
   subscription rate limits remain authoritative.
6. Migration 008 replaces the inference ledger's unique `(capability, role)` rule
   with unique `(capability, role, request_hash)` requests. A fixed total request
   ceiling bounds tool loops; an exact repeated request is rejected without a
   second provider call. Per-request and aggregate token ceilings are distinct.
7. Migration 011 records the stable provider thread ID/reuse evidence and allows
   only one active request per capability/role. The live broker retains one
   process-owned thread per role and uses `codex exec resume` with only appended
   conversation messages. Different roles remain isolated. A process replacement
   fails closed rather than claiming cross-process resume.

The first live use remains the literal disposable M5b fixture. This does not make
the broker safe for untrusted repositories or general prompts. A production
subscription broker should run inside a separately reviewed credential-holding
micro-VM/container with no product workspace.

The macOS/Colima deployment uses a loopback-only host listener rather than a
bind-mounted Unix socket because the Linux VM cannot consume a macOS host socket
with the required semantics. A fixed credential-free proxy is dual-homed on the
writer's `Internal=true` network and Docker's bridge and can forward only to the
fixed host-gateway address/port. The writer is never attached to the egress
bridge. Engines that support a true local Unix-socket bind may retain that mode.

## Rejected alternatives

- Mounting `~/.codex`, `~/.atomic`, or `auth.json` into the Atomic writer.
- Printing/exporting the subscription bearer and passing it through the gateway.
- Treating ChatGPT subscription authentication as an OpenAI API key.
- Letting Codex orchestrate Atomic's workflow graph or directly modify the writer.
- Keeping the four-request ledger while claiming Atomic custom tools work live.

## Consequences

The broker adds a process/protocol boundary and subscription-specific tests, but
preserves Atomic as the root runtime and the control plane as policy authority.
The path remains disabled until an exact Codex version, dedicated private profile,
model, accepted package/image digests, internal network, and all bounds validate.
Normal verification uses a fake Codex child and makes no subscription request.
The live evidence proves only the fixed fixture and stopped before the separately
bound operator decision; it does not authorize general prompts or repositories.
