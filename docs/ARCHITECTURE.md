# Architecture

## Recommended system

```text
Wesley on mobile
      |
      v
Hermes messaging and approvals
      |
      +---- Linear: roadmap and live work truth
      +---- Project Brain: accepted vault knowledge + read-only retrieval pilot
      +---- Control-plane MCP: runs, approvals, budgets, evidence
                         |
                         v
              Thin TypeScript control plane
              - stable IDs
              - routing policy
              - run registry
              - approval service
              - workspace leases
              - normalized events
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
     Atomic          Codex/Claude         Prime
 pilot workflow      bounded workers   long research
       |                 |                  |
       +-----------------+------------------+
                         |
                         v
              isolated workspaces / GitHub
```

## Authority boundaries

- **Hermes** owns conversation, mobile notification, and user-facing summaries.
- **Linear** owns initiatives, projects, issues, dependencies, and work status.
- **Git/GitHub** owns source code, PRs, CI, and accepted delivery history.
- **Control plane** owns cross-runtime run IDs, policies, approvals, budgets, workspace leases, and normalized event projections.
- **Native runtime** owns its internal workflow/session state.
- **Obsidian/Git vault** owns accepted project rationale and enduring knowledge.
- **Machine memory** supplies retrieved or episodic context but cannot override live or accepted sources.

These are domain authorities, not one global precedence list. Linear controls
roadmap and work state; Git and executable checks control implementation truth;
accepted Project Brain Markdown controls project rationale and decisions. Current
explicit user instruction controls intent but does not silently rewrite recorded
external state.

## Storage boundary

The control plane uses one asynchronous store contract with two adapters:

- SQLite is the local, zero-service demo backend.
- PostgreSQL is opt-in and supplies the production-candidate transaction and
  concurrency semantics.

Both adapters own explicit versioned migrations, lifecycle idempotency records,
and a transactional outbox. Selecting PostgreSQL never silently falls back to
SQLite, and there is no dual-write or automatic data copy between them. The
outbox is durable state in this milestone; an external broker/publisher is not.

## Atomic module boundary

`packages/atomic-workflow-architect/` contains the Atomic-specific skill, router,
prompts, launch contract, and workflows. It is independently verifiable source,
not the whole Project OS. Its presence alone does not install Atomic, register an
adapter, or alter routing. An explicitly configured pilot adapter can start pinned
Atomic 0.9.12 for credential-free offline RPC/package discovery. The control plane
continues to own stable run IDs, policy, budgets, approvals, context/workspace
references, normalized events, and artifacts; Atomic's main session owns native
session/workflow state.

M5a adds exactly one independently tested package workflow,
`atomic-fixture-pilot`, for a reviewed disposable repository. Its real Atomic main
session runs inside the external writer container, and its native graph uses only
credential-free `ctx.tool` stages: literal-contract preflight, reviewed fixture
edit, deterministic checks, fresh deterministic verification, and artifact
emission. This proves the integration boundary, not model behavior. Provider/model
workflow, native HIL, and cross-process durability remain unverified and disabled.

## Native connectivity boundary

Native adapters are disabled by default and require bearer-authenticated API/MCP.
The minimum pilot admits only `workflow=runtime-connectivity`: Atomic discovers
the pinned module offline; direct Codex/Claude accept fixed marker-only objectives
and use read-only/bare process modes. Complete native JSONL records are persisted
before normalized projections. Context packs and run contracts are bounded,
checksummed workspace artifacts. Every pilot final action is `analysis_only` and
`crossProcessResume=false`.

This connectivity boundary is not a writer sandbox. Milestone 4 provides the
separate contract below. Only the literal M5a fixture coordinator may compose it
with Atomic, behind a separate default-off gate and successful deployment-host
preflight; the general native adapters remain read-only.

## Verified external writer boundary (disabled by default)

The Milestone 4 boundary composes these separate authorities:

1. `WriterWorkspaceManager` snapshots one exact clean base commit into a private
   shallow bare Git store, creates one relative worktree, and never mounts the
   developer checkout or a shared Git directory.
2. The storage boundary assigns an explicit owner and monotonic fencing token.
   Renewal, quarantine, and release require the exact original fence; quarantined
   rows remain durable reconciliation evidence.
3. `OciSandboxProvider` creates one digest-pinned Docker-compatible container with
   the private run Git root writable, separately staged context read-only, network
   `none`, read-only root, numeric non-root user, built-in seccomp, dropped
   capabilities, no-new-privileges, and CPU/memory/PID/tmpfs/time/output bounds.
   It re-inspects immutable labels, mounts, workdir, network, image, and privilege
   policy before execution or cleanup.
4. `WriterLeaseSupervisor` begins immediately after durable lease creation and
   renews only its retained fence. Lease loss stops the old container when exact
   ownership is still proven; ambiguous ownership is quarantined without release
   or reuse, and a rotated successor cannot be mutated.
5. Governed export claims an exact-fence cleanup freeze after container stop,
   accepts an explicit bounded
   manifest, rejects traversal/symlinks/hardlinks/special files, performs a
   baseline deterministic secret scan, and atomically/idempotently registers
   opaque checksummed artifact references. Secret values and engine output are
   absent from control-plane evidence.
6. Only after durable artifacts and owned container/worktree cleanup does the
   exact lease release. Ambiguous ownership or cleanup leaves durable quarantine
   evidence instead of automatic reuse.

The provider remains disabled by default and is never exposed as a raw
runtime/API/MCP capability. In addition to deterministic fake-engine tests, local
Colima/Docker passed the opt-in kernel/network policy smoke with an immutable
ARM64 Alpine fixture. Migration 005 records the sandbox lifecycle and
provider-aware restart reconciliation cleans only exact immutable IDs/labels,
quarantines drift or uncertainty, and leaves unmatched managed objects untouched.

## M5a Atomic fixture composition (default off)

`AtomicFixturePilotCoordinator` is a narrow control-plane composition, not a new
workflow engine. Authenticated MCP can submit only the exact `atomic-pilot` /
`task_atomic_fixture_m5` / `atomic-fixture-pilot` contract. Callers cannot choose
the repository, command, image, socket, credential, artifact paths, or workflow
source.

The control plane creates the bounded accepted Project Brain pack, run contract,
launch manifest, private worktree, lease owner/fence, and no-network container.
The provider opens one bounded LF-JSONL transport to Atomic 0.9.12 inside that
container. Atomic owns one native main session and workflow run. Raw native
records and stable native IDs are retained alongside normalized events.

After the workflow reaches terminal success, the boundary stops Atomic and its
container, freezes the exact fence, verifies the exported bytes still match the
native evidence snapshot, scans and atomically registers nine checksummed
artifacts, removes the worktree, and releases the lease. Only then may the run
enter `awaiting_approval`. Migration 006 binds that approval to project, workflow,
artifact digest, sandbox policy hash, and expiry. Approval can record only a safe
mock acceptance receipt. Its evidence-derived memory remains `proposed`; promotion
is a separate preview-bound action absent from the fixture tool allow-list.

The slice has network `none`, zero model tokens/cost, no provider credential, no
model verifier, and `crossProcessResume=false`. It creates no real PR, merge,
deployment, destructive database action, secret expansion, or canonical-memory
write. A complete model-backed M5 depends on a reviewed local-model endpoint or a
scoped inference proxy that keeps provider credentials outside the writer.

## M5b Atomic model fixture composition (default off)

`AtomicModelPilotLifecycleCoordinator` admits only the fixed Atomic Pilot project,
model-fixture task, literal objective, Atomic root, and
`atomic-fixture-model-pilot` workflow. It creates no new workflow engine: Atomic's
main session owns the implementer, initial fresh verifier, optional single repair
fork, and final fresh verifier. The control plane owns the exact clean base commit,
writer fence, isolated container, bounded Project Brain pack, inference policy,
artifacts, expiry, approval, and safe mock receipt.

The writer joins one inspected local `Internal=true` Docker bridge but has no
public credential or direct provider authority. A separate no-secret bridge can
reach only the private host Unix-socket gateway. The gateway holds the reviewed
provider credential, accepts an opaque expiring run capability, fixes role/model
and request shape, and transactionally accounts request/token/cost/time limits in
SQLite/PostgreSQL. The container gets only the capability file and fixed internal
endpoint; host model homes, OAuth, keychain, Docker socket, and provider secret
are never mounted or forwarded.

After Atomic succeeds, deterministic checks and substantive source/test/patch/
fresh-verifier evidence are rebound to stopped frozen exports. The container,
bridge, worktree, capability, and lease must be cleaned/revoked before the run can
enter an evidence/policy/expiry-bound approval. Authenticated HTTP/MCP may read
only bounded rehashed UTF-8 artifacts and resolve only the safe mock action.
Restart recovery never claims native cross-process resume. A fake provider proves
contracts only; `liveProviderVerified` becomes true solely for a launch bound to
live execution whose durable role requests and native evidence all agree.

## Prototype substitution

The production architecture uses PostgreSQL and a read-only OpenViking trial. The
downloadable prototype defaults to SQLite and local Markdown retrieval so it can
run without external credentials. PostgreSQL now exists behind the store contract;
OpenViking and general writer runtimes remain disabled continuation work. The
writer boundary is contract-tested and locally live-verified behind proposed
ADR-P004; the only runtime composition is the fixed credential-free M5a fixture
behind proposed ADR-P005. Read-only native connectivity adapters exist only
behind explicit feature flags and the proposed ADR-P003 boundary.


## A/B pilot path

The prototype exposes `run_compare` to launch Atomic, Codex, and Claude candidates for one objective. Each candidate receives a separate workspace and writer lease, and every run carries the same comparison ID. Evidence and completion are recorded independently; a human selection remains a separate decision. This implements the current decision that Atomic is a proposed default rather than an untested assumption.
