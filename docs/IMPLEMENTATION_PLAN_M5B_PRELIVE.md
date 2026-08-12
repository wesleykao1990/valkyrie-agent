# Milestone 5b pre-live implementation plan

Status: credential-free boundary and authenticated service/Hermes lifecycle are
deterministic-test verified in SQLite and PostgreSQL; only provider selection,
credential injection, and the live model exercise remain pending.

## Objective

Prepare and test the credential/network/workflow boundary without requesting a
model credential or making a provider call. Preserve the M5a tool-only pilot as
an independently runnable regression, and record the lifecycle work that must
still be composed before live enablement.

## Fixed scope

- Add a second, literal `atomic-fixture-model-pilot` workflow for the existing disposable repository only.
- Keep Atomic as the root runtime and owner of implementer, fresh-verifier, and one bounded repair stage.
- Keep the control plane as owner of the exact worktree, writer fence, OCI container, context pack, policy, budgets, artifacts, approval, and safe mock final action.
- Add a credential-holding inference gateway outside the writer. The writer receives only an opaque, expiring, run-scoped capability and a fixed internal endpoint.
- Build deterministic fake-upstream and fake-Atomic tests. They prove the boundary and recovery contracts, not model quality or a live integration.
- Keep all model-backed behavior disabled by default and refuse startup unless every boundary is explicit.

## Delivered in this pre-live slice

1. Add a proposed ADR for the scoped inference boundary and single-instance pilot policy.
2. Add a provider-neutral inference policy and capability ledger behind the existing store contract, with explicit SQLite/PostgreSQL migration 007.
3. Add an authenticated, bounded OpenAI-compatible gateway surface with exact request/response schemas, model/role allowlists, request/token/cost/time limits, replay protection, redaction, and raw-plus-normalized usage evidence.
4. Add deterministic fake upstream behavior for implement, verify, and one repair response; it must never be reported as live inference.
5. Add the native Atomic model workflow, a separate model-pilot launch schema,
   strict package/image/policy digests, implementer continuity, fresh verifier
   context, deterministic checks, and a single evidence-backed repair.
6. Add a fixed coordinator that composes exact
   worktree/fence/context/package/image bindings, native execution, substantive
   workspace-evidence validation, frozen-export rebinding, raw-event retention,
   bridge teardown, capability revocation, and private-context cleanup.
7. Add deterministic tamper, timeout, budget, redaction, cleanup, and
   SQLite/PostgreSQL parity tests for the delivered boundary.
8. Update setup, rollback, security, verification, and continuation
   documentation without requesting or storing a credential.
9. Register only the literal project/task/objective/workflow through authenticated
   service, HTTP, and restricted MCP operations with transactional one-run
   admission, durable claim retry, cancellation, provider-aware reconciliation,
   bounded expiry maintenance, and `crossProcessResume=false`.
10. Re-open and checksum all governed artifact bytes before bounded review or
    approval, bind the operator-intended safe-mock gate to exact evidence/policy/
    expiry, keep memory proposed, and test the same lifecycle in SQLite/PostgreSQL.
11. Provide `npm run smoke:atomic-model`; it makes no call until a separately
    configured server exists and stops before approval by default.

## Still required before a live pilot

1. Select/review the provider and model, accepted digests, token prices, spend
   ceiling, and dedicated credential or reviewed credential-free local endpoint.
2. Create and inspect the dedicated local Docker `Internal=true` bridge named in
   `ATOMIC_FIXTURE_MODEL_NETWORK`, then start the default-off configured server.
3. Run the actual Docker/Atomic/provider pilot and record native IDs, usage,
   cost, artifacts, cleanup, and a real operator evidence decision.

## Migrations and rollback

Migration 007 will be forward-only and checksummed. It will store capability hashes and usage/accounting metadata, never plaintext provider credentials or bearer capabilities. A pre-v7 database backup is required for binary rollback; an older binary must fail closed on the newer ledger.

## Security impact

This milestone introduces a future network path, so the default remains no network. The model workflow cannot start unless the gateway policy, internal network, immutable runner evidence, reviewed package digest, limits, and authentication source all validate. Provider credentials stay outside the writer and outside control-plane run artifacts. Fake mode uses no provider credential and no public network.

## Verification and stop condition

Run narrow tests first, then the shared SQLite/PostgreSQL contracts, Atomic package verification, and `npm run verify`. Perform a fresh security review. Stop before selecting a paid model, accepting a provider credential, making a live inference request, or claiming model-backed pilot success.
