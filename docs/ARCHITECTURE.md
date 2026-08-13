# Architecture

## Recommended system

```text
Wesley
  +---- LINE (active mobile surface) through Hermes
  +---- Buzz (proposed graphical workspace) through Hermes
                         |
                         v
              Valkyrie interaction gateway
              actor/channel/conversation identity: M9, not implemented
                         |
      +------------------+-------------------+
      |                  |                   |
      +---- Linear: roadmap and live work truth
      +---- Project Brain: accepted project rationale
      +---- future separate authorities: GBrain advisory knowledge,
      |     Personal Profile, and Commitment Ledger
      +---- Control-plane API/MCP: runs, approvals, budgets, evidence
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
 pilot workflow     transient workers  optional runtime
       |                 |                  |
       +-----------------+------------------+
                         |
                         v
              isolated workspaces / GitHub
```

## Authority boundaries

- **Hermes** is the interaction gateway for LINE and the proposed Buzz surface;
  it does not own roadmap, implementation, project rationale, identity, or
  commitments. Stable cross-surface conversations are planned for M9+.
- **Linear** owns initiatives, projects, issues, dependencies, and work status.
- **Git/GitHub** owns source code, PRs, CI, and accepted delivery history.
- **Control plane** owns cross-runtime run IDs, policies, approvals, budgets, workspace leases, and normalized event projections.
- **Native runtime** owns its internal workflow/session state.
- **Obsidian/Git vault** owns accepted project rationale and enduring knowledge.
- **Machine memory** supplies retrieved or episodic context but cannot override live or accepted sources.
- **Future GBrain Knowledge Plane** is a separate broad advisory candidate. It
  cannot write or override Project Brain.
- **Future Personal Profile** and **Commitment Ledger** are separate explicit
  preference and operational follow-up authorities.

These are domain authorities, not one global precedence list. Linear controls
roadmap and work state; Git and executable checks control implementation truth;
accepted Project Brain Markdown controls project rationale and decisions. Current
explicit user instruction controls intent but does not silently rewrite recorded
external state.

## Engineering routing authority

For a general engineering request, Hermes is the conversational intake and may
send an optional latency/rigor preference. It is not the final runtime router.
The control plane resolves current task/project authority, evaluates the recorded
six-dimension rubric, applies hard safety/workflow signals, and returns an
explainable execution shape:

```text
Hermes literal request + optional preference
                    |
                    v
      control-plane routing policy + current context
            /               |               \
           v                v                v
        Direct         Atomic Lite       Atomic Full
   one root session   persistent stage   multi-stage graph
   + tool checks      + tool checks      + evidence/gates
```

A preference can increase rigor but cannot reduce the policy-selected shape.
Direct remains subject to the same workspace, deterministic-check, budget, and
final-action boundaries. Atomic Lite and Atomic Full are both Atomic root runs;
they are not Codex or Claude runs hidden underneath an Atomic wrapper. The
structured selector plus authenticated assessment/read operations are
implemented and tested. Assessments are durable, source-labeled, and explicitly
unsupported for general execution until a reviewed launcher revalidates and
consumes current authority. M7 can supply narrow revision-bound Linear/Git
authority but is not that launcher. The package-level Atomic Lite workflow is independently
testable but is not registered as a general writer; current live writer pilots
retain their fixed literal contracts.

Task capability and agent role are separate from runtime. Research Lead is a
role and Prime is only an explicit optional runtime; an unqualified research
keyword now fails closed pending the future Research Lead selector. Legacy
fixed/demo engineering launch maps through the same Direct / Atomic Lite /
Atomic Full risk rubric, while the future general launcher must consume its
durable, non-expired assessment. Codex/Claude workers and fresh reviewers are
normally transient. Communication/delegation permission is separate from tool
permission, and unrestricted agent DMs/delegation remain disabled.

## Storage boundary

The control plane uses one asynchronous store contract with two adapters:

- SQLite is the local, zero-service demo backend.
- PostgreSQL is opt-in and supplies the production-candidate transaction and
  concurrency semantics.

Both adapters own explicit versioned migrations, lifecycle idempotency records,
and a transactional outbox. Selecting PostgreSQL never silently falls back to
SQLite, and there is no dual-write or automatic data copy between them. M7 adds
one default-off external-final-action consumer for approved action deliveries;
ordinary task events have no external writer. It is not a generic broker or
permission to publish other topics.

## Production connector boundary

M7 keeps network credentials and clients in the host control plane. One accepted
digest-pinned project policy maps a local project to exact Linear team/project/
evidence-issue IDs, a reviewed Git checkout and fixed checks, and GitHub
owner/repository/base/head refs. Hermes and runtimes receive only bounded domain
operations; they cannot provide a token, URL, filesystem path, ref, command,
issue target, or arbitrary GraphQL/REST body.

Current Linear/Git observations are retained as narrow authority bindings with
provider revision, canonical payload hash, observed time, and freshness. The
transactional business outbox remains immutable while each external consumer has
its own expiring fenced delivery state. Final provider mutations use a second
immutable action-plan aggregate bound to exact run/workflow/evidence/policy/
effect/expiry and current target revision. Approval authorizes the plan, not a
generic connector. A process crash after durable begin becomes ambiguous and
requires exact marker-based reconciliation.

The first GitHub write is draft creation only and requires a pre-existing remote
head whose OID still matches. M7 does not retain/publish a writer branch, merge,
deploy, or promote memory. The authenticated assessment may now record live
authority when configured, but general Direct/Lite/Full launch remains a separate
reviewed composition.

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
public credential or direct provider authority. On macOS/Colima, a separate
no-secret proxy is dual-homed on that network and Docker's bridge and can reach
only the fixed loopback host gateway; the writer never joins the egress bridge.
Engines with a safe bind path may instead use the private Unix-socket transport.
The gateway holds the reviewed
provider credential, accepts an opaque expiring run capability, fixes role/model
and request shape, and transactionally accounts request/token/cost/time limits in
SQLite/PostgreSQL. The container gets only the capability file and fixed internal
endpoint; host model homes, OAuth, keychain, Docker socket, and provider secret
are never mounted or forwarded.

The gateway supports either a reviewed OpenAI-compatible HTTP upstream or a
host-side `codex-subscription` adapter. Subscription mode delegates ChatGPT OAuth
to a pinned Codex CLI in a dedicated private profile and converts each fixed
OpenAI-compatible stage turn to one structured, read-only Codex turn. Migration
011 retains one process-local native thread per capability/role, uses appended
message deltas for continuation, and permits only one active turn in a role.
Atomic remains the workflow owner. Migration 008 permits up to 16 changed request
hashes across the four fixed roles, while exact replay remains single-spend and
aggregate token/time/concurrency bounds remain fail-closed. Codex native tools are
disabled and any observed tool event invalidates the request. Restart continuation
is refused because provider thread ownership is not cross-process durable.

After Atomic succeeds, deterministic checks and substantive source/test/patch/
fresh-verifier evidence are rebound to stopped frozen exports. The container,
bridge, worktree, capability, and lease must be cleaned/revoked before the run can
enter an evidence/policy/expiry-bound approval. Authenticated HTTP/MCP may read
only bounded rehashed UTF-8 artifacts and resolve only the safe mock action.
Restart recovery never claims native cross-process resume. A fake provider proves
contracts only; `liveProviderVerified` becomes true solely for a launch bound to
live execution whose durable role requests and native evidence all agree.

## Managed skill-suite capability plane

The M8a `ManagedSkillSuiteManager` is an operational admission/catalog boundary,
not a workflow engine and not project knowledge. It accepts one exact local
source tree only after an exact policy binds suite identity, version, projects,
runtime modes, trust profile, telemetry posture, and update semantics. The
manager discovers `SKILL.md` definitions without running them, derives declared
capabilities, copies exact bytes into a private content-addressed generation,
and rehashes that generation before status, activation, rollback, or pack use.

`skill-frontmatter-v1` uses pinned strict YAML 1.2 parsing and recognizes only
top-level `tools` or `allowed-tools` authority. Missing, malformed, duplicate,
conflicting, nested, empty, and unknown declarations are operator-gated. Source
inspection of executables, setup/install files, package lifecycle hooks, MCP
definitions, and static prose/name risk can only add requirements. A per-skill
override must be present in the exact digest-bound suite policy and cannot erase
malformed or unrecognized authority.

The active generation can emit an immutable capability pack bound to project,
runtime, selected skills, and digests. Codex/Claude are designated future native
hosts; Atomic receives a delegated specialist rather than a second workflow
engine; Hermes remains request/status only. The current general launcher does
not consume these packs, so admission grants no execution. A later projection
adapter and broker must preserve workspace, credential, network, approval, and
external-action policy. Web/browser capabilities remain disabled.

## Prototype substitution

The production-candidate architecture uses PostgreSQL and retains OpenViking as
an alternative read-only Project Brain provider trial. It is not a simultaneous
production memory system beside the proposed separate GBrain Knowledge Plane. The
downloadable prototype defaults to SQLite and local Markdown retrieval so it can
run without external credentials. PostgreSQL now exists behind the store contract;
OpenViking and general writer runtimes remain disabled continuation work. The
writer boundary is contract-tested and locally live-verified behind proposed
ADR-P004; the only runtime composition is the fixed credential-free M5a fixture
behind proposed ADR-P005, with the subscription inference extension proposed in
ADR-P007. Read-only native connectivity adapters exist only
behind explicit feature flags and the proposed ADR-P003 boundary.


## A/B pilot path

The prototype exposes `run_compare` to launch Atomic, Codex, and Claude candidates for one objective. Each candidate receives a separate workspace and writer lease, and every run carries the same comparison ID. Evidence and completion are recorded independently; a human selection remains a separate decision. This implements the current decision that Atomic is a proposed default rather than an untested assumption.
