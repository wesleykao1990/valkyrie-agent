# ADR-P006: scoped inference boundary for the Atomic model pilot

Status: proposed

## Context

M5a proved the real Atomic 0.9.12 JSONL/workflow boundary in an isolated writer with no model and no network. M5b needs model-backed implementation and an independent verifier without exposing provider credentials or general egress to that writer.

Atomic 0.9.12 supports custom OpenAI-compatible providers through its private agent-directory `models.json`. Passing a real provider key into that file, the container environment, a mounted home, or command arguments would give the writer and its tools credential authority. A named bridge by itself would also allow broader network reach than the run contract intends.

## Proposed decision

Use a control-plane-owned inference gateway outside the writer. The writer receives one opaque capability through a private run-scoped file and can reach only the gateway on an internal, run-owned network. The gateway holds the provider credential, fixes provider/model/role and request shape, enforces expiry/request/token/cost/time bounds, and records usage. Durable storage contains only capability hashes and bounded metadata.

The first model workflow remains the fixed disposable fixture. Atomic owns these native stages:

1. implementer with a fresh initial context;
2. deterministic checks owned by workflow tools;
3. independent verifier with fresh context and only the literal contract, frozen candidate, and check evidence;
4. at most one repair continuation forked from the implementer session when the verifier supplies evidence-backed findings;
5. repeated deterministic checks and a new fresh verification after repair.

The control plane owns outer admission, workspace/container/fence, gateway capability, aggregate budget, artifact export, approval, and safe mock receipt. No real PR, merge, deployment, product database mutation, or memory promotion occurs.

M5b is single-active-control-plane-instance until durable cancellation ownership and provider-aware sandbox reattachment are separately proven. The process must fail closed when another pilot owner is active.

## Rejected alternatives

- Mounting `~/.atomic`, `~/.codex`, `~/.claude`, browser/keychain state, or provider auth into the writer.
- Passing API keys or OAuth tokens in environment variables, arguments, prompts, events, or artifacts.
- Giving the writer direct public egress or a general forward proxy.
- Treating a fake upstream as evidence of model quality or live provider compatibility.
- Letting Codex or Claude Code orchestrate Atomic's internal workflow stages.

## Consequences

The gateway and capability ledger add code and an operational component, but make the credential and network boundary testable before live spend. A live pilot remains blocked on accepted provider/model and runner/package digests, a dedicated low-limit credential, an authenticated human/operator decision path, and an actual end-to-end exercise.
