# ADR-P004: External container boundary and fenced writer leases

- Status: Proposed
- Date: 2026-08-11
- Decision owner: Wesley Kao
- Implementation status: local live provider verification and durable
  provider-aware restart reconciliation complete; writer enablement remains
  disabled pending the separately flagged Milestone 5 pilot

## Context

Git worktrees and database leases coordinate candidates but do not isolate a
writing process from the host filesystem, credentials, network, or other
processes. The accepted architecture requires an external container or VM before
any real runtime writes. This host now has a bounded Colima/Docker engine for the
local non-production boundary; writer adapters remain unregistered by default.

## Proposed decision

1. Keep one control-plane-owned Git worktree and one writer lease per candidate.
   Atomic must use that workspace rather than creating another top-level worktree.
2. Add a monotonic fencing token and explicit owner to every writer lease. Every
   renew, release, quarantine, container operation, and artifact export binds the
   exact run/workspace/owner/token tuple.
3. Use a disabled-by-default Docker-compatible CLI provider for the first local
   implementation. Invoke an absolute configured executable with fixed argv and
   no shell; require an immutable image digest and disallow implicit pulls.
4. Default to no network, no ambient secrets, a read-only root filesystem,
   non-root UID/GID, all Linux capabilities dropped, no-new-privileges, bounded
   resources, one writable per-run Git root (isolated bare store plus its single
   candidate worktree, shallow at the selected base commit), and one separate
   read-only context bind. The container
   works in `/workspace/worktree`; no developer checkout or shared Git directory
   is mounted.
5. Inspect the created container and its ownership labels, mounts, network, image,
   and running state before executing the workload. Unexpected effective policy
   fails closed.
6. On lease loss, expiry, timeout, or policy mismatch, stop the container when
   exact ownership remains proven before releasing the lease. If ownership or
   cleanup cannot be proven, persist quarantine evidence and never release or
   reuse the workspace automatically. Use an exact-fence cleanup claim before
   artifact export so lease rotation cannot overlap export or deletion.
7. Export only manifest-named contained regular files. Bound file count/size,
   reject links and special files, scan for secrets before creating any governed
   artifact, and retain checksums rather than secret content in evidence.
8. Do not register a writer runtime until the provider passes an opt-in live smoke
   on the actual deployment host. A fake CLI test validates orchestration, not
   isolation.
9. Persist provisioning, ready, running, freezing, exporting, cleaned, and
   quarantined sandbox-instance states transactionally. Restart reconciliation
   inventories only managed labels, binds immutable engine ID plus exact run/
   workspace/owner/fence/policy evidence, and never removes an unmatched object.

## Consequences

- Lease fencing prevents a stale process from renewing or releasing a successor's
  workspace lease.
- The default demo and read-only native pilot remain zero-engine paths.
- The first provider is portable to Docker-compatible CLIs but does not claim
  equivalent security from every daemon/runtime configuration.
- Named-network egress, credential brokering, image build/provenance, and remote
  micro-VM isolation remain separate decisions.
- On this host Milestone 4 is live-verified and restart-complete for the local
  disabled boundary. Writer mode remains unavailable until Milestone 5 composes
  the boundary into one disposable model pilot with explicit egress/credential
  policy and deterministic acceptance criteria.

## Approval requested

Accept, amend, or reject this boundary before enabling a real writing adapter.
