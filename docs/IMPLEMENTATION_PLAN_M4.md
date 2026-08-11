# Milestone 4 external writer-boundary plan

Date: 2026-08-11
Status: deterministic contract slice implemented; live external isolation and
provider-aware restart reconciliation remain blocked until a supported
container/VM engine is installed and passes the opt-in smoke test

## Run contract

Objective: add the smallest fail-closed external writer boundary without enabling
repository-writing runtimes before the boundary is positively verified.

Acceptance evidence:

- the default SQLite/mock and Milestone 3 read-only native pilot remain available;
- every strict writing candidate is a real Git worktree, never a simulated
  directory, and belongs to one control-plane run;
- every writer lease has a stable owner, monotonic fencing token, heartbeat,
  expiry, quarantine evidence, and exact-fence release;
- a disabled-by-default Docker-compatible provider creates one container per run
  from an immutable image digest, with no ambient credentials, no network by
  default, a read-only root, a single writable per-run Git-root mount containing
  only the isolated bare store and candidate worktree, a separate read-only
  context mount, a non-root user, dropped capabilities, no-new-
  privileges, and bounded CPU, memory, PIDs, tmpfs, output, and elapsed time;
- provider ownership and the effective mount/network policy are inspected before
  commands run;
- lease loss or expiry stops the container when exact ownership can still be
  proven; ambiguous ownership is quarantined without release or reuse;
- only explicitly named, contained, regular non-symlink artifacts are exported;
  content is bounded and secret-scanned before an artifact record or displayable
  reference is created;
- terminal cleanup removes the owned container and worktree; ambiguous ownership
  or cleanup failure is quarantined rather than silently reused;
- SQLite and PostgreSQL lease contracts, deterministic fake-engine tests, an
  opt-in live smoke, full `npm run verify`, and an independent fresh review pass.

## Non-goals and final-action boundary

- This milestone does not enable Atomic, Codex, or Claude Code writer mode. That
  requires a live provider PASS on the deployment host and a separately reviewed
  runtime launch contract.
- It does not install a host container/VM engine, inject provider credentials,
  open network egress, create a PR, merge, deploy, promote memory, or change a
  production database.
- The control plane owns the top-level worktree, container, lease, and artifact
  boundary. Atomic must not create a duplicate top-level worktree or become a
  child wrapper under Codex/Claude.
- A container is the first external process/filesystem boundary, not proof of a
  production multi-tenant sandbox. Confidential/high-risk work still requires a
  reviewed remote VM or equivalent stronger boundary.

## Planned changes

1. Add forward-only SQLite/PostgreSQL migrations for lease ownership, fencing,
   heartbeat, quarantine, and workspace lease epochs.
2. Replace unfenced renew/release calls with exact lease-fence operations and add
   heartbeat/expiry reconciliation.
3. Add a strict Git-worktree path that fails closed when the repository is absent
   or worktree creation fails. Populate an independent shallow bare Git store
   with only the selected base commit, then create its one relative candidate
   worktree; preserve the simulated workspace only for the existing demo/read-
   only posture.
4. Add a Docker-compatible provider interface, deterministic fake CLI, immutable
   image/config validation, effective-policy inspection, bounded execution, and
   ownership-aware cleanup.
5. Add governed artifact export and secret scanning before storage/display.
6. Add a disabled-by-default sandbox boundary coordinator and opt-in live smoke.
7. Document setup, rollback, failure/quarantine behavior, and the exact remaining
   manual engine/image requirements.

## Storage and migration posture

Migration `004_fenced_writer_leases` is forward-only. Existing leases are
backfilled with their run as owner and fencing token 1. Each workspace stores a
monotonic lease epoch so an expired/released lease can be rotated without allowing
an older process to renew or release the successor. Quarantine evidence is
durable and included in restart reconciliation.

The exact-fence quarantine reason `writer_filesystem_cleanup_claimed` is also the
destructive cleanup freeze. It is transient on a successful fixture run and is
released only after artifact persistence, container cleanup, and filesystem
removal are proven. If the process fails mid-cleanup, it remains durable operator
evidence; monitoring must distinguish this claim from failure quarantine reasons.

No runtime transcript, credential, container environment, or complete engine
output is added to the lease tables. Store events/outbox records contain bounded
identifiers and state transitions only.

## Rollback

- Leave the provider's `enabled` option false (the default). It is not composed
  into server/runtime configuration, and no writer runtime is registered in this
  milestone.
- Stop and remove only containers whose inspected labels exactly match the
  control-plane run/workspace/fencing owner; quarantine any ambiguous resource.
- Remove only the independently initialized, run-owned Git root after the exact lease
  is terminal and the container is gone. Never recursively delete an unresolved
  or out-of-root path.
- Migration 004 is forward-only and older binaries intentionally reject an
  unknown v4 ledger. A binary rollback therefore requires a pre-v4 database
  backup (or a separate pre-v4 SQLite dataset); there is no destructive down
  migration.

## Security impact

- Image tags and implicit pulls are rejected; the image must be configured by
  immutable SHA-256 digest and already present.
- The default network is `none`. A named network is an explicit future policy
  input, not a fallback.
- No Docker socket, home directory, cloud configuration, SSH agent, production
  credential, or unrelated repository path is mounted or inherited.
- Context is staged separately and mounted read-only. The only writable host bind
  is a per-run root containing only that candidate's isolated bare Git store and
  its one `worktree/`; `/workspace/worktree` is the container working directory.
- Secret detection is a release gate. A match records only rule identifiers and
  hashes, deletes any temporary export, and quarantines the run; matched secret
  text is never logged.
- This host currently has no Docker, Podman, Lima, Colima, OrbStack, or equivalent
  engine. Deterministic contracts can pass here, but live isolation must report a
  skip/block rather than a success.
- Existing v3 active leases backfill with `ownerId=runId`, fencing token 1, and
  `acquiredAt=heartbeatAt`. Treat them as legacy evidence to quarantine, clean,
  and rotate before enabling a real writer. Database fencing alone cannot stop a
  stale process from writing; termination and effective-policy inspection remain
  mandatory.
