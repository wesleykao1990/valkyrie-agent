# Security model

Valkyrie demonstrates control-plane contracts. It is not a production sandbox,
remote multi-user service, or authorization system. Do not point it at a
confidential repository or give it production credentials.

## Preserved authority boundaries

- One root runtime owns each run lifecycle and native session state.
- Every candidate receives a distinct workspace record and exactly one writer
  lease, even though native pilot operations are read-only.
- Hermes receives named project/run/memory tools, not raw process, container,
  credential, filesystem, worktree, merge, or deploy controls.
- Linear, Git/GitHub plus executable checks, and accepted Project Brain Markdown
  remain authoritative for roadmap, implementation, and rationale respectively.
- Runtime/session memory is advisory. It cannot override current operational state
  or accepted canonical decisions.
- Proposal, exact promotion preview, canonical promotion, PR, merge, deploy, and
  secret expansion remain separate final actions.

## Three execution postures

The default `npm start` posture binds loopback, uses SQLite, and registers only
deterministic mock runtimes. It needs no credential or external service.

The opt-in `bin/project-os-pilot-server` posture requires bearer auth and enables
these disabled-by-default native adapters:

- **Atomic 0.9.12:** credential-free `ATOMIC_OFFLINE=1` LF-JSONL process and
  imported-package discovery only. It does not issue a model prompt. The launch
  manifest records `modelExecutionAttempted=false`, `final_action=analysis_only`,
  and `crossProcessResume=false`.
- **Codex 0.147.0-alpha.6.5:** authenticated CLI call with `exec --json`,
  `--sandbox read-only`, `--ephemeral`, ignored user configuration/rules, and no
  repository-write final action.
- **Claude Code 2.1.81:** optional `--bare` stream-JSON call with settings sources,
  MCP, tools, hooks/browser, slash commands, and session persistence disabled.
  It accepts only an explicitly forwarded `ANTHROPIC_API_KEY`; OAuth/keychain state
  is deliberately ignored.

The separate M5a posture uses normal `npm start` with
`ATOMIC_FIXTURE_PILOT_ENABLED=true`, bearer auth, exact absolute fixture/engine/
state paths, and an already-present immutable runner digest. It does not enable a
general writer. It accepts one literal project/task/objective/workflow contract
and runs real Atomic 0.9.12 inside the M4 OCI boundary with network `none` and no
provider credential. Atomic's reviewed workflow uses only deterministic tool
stages. Its "fresh verifier" is a separate deterministic process, not a model.
The only final approval effect is a safe mock receipt, and generated memory stays
proposed.

Codex/Claude connectivity objectives must exactly match
`Return exactly MARKER and nothing else.` where `MARKER` is 3–64 uppercase ASCII
letters, digits, or underscores. This prevents the connectivity endpoint from
becoming a general arbitrary-prompt runner before a writer sandbox exists.

Every child has a wall-clock/output/framing bound, version preflight, minimal
environment, native session-ID gate, bounded termination, and writer-lease
release. Every parsed native JSONL occurrence is stored as `runtime.native` before
its normalized projection. These records and result artifacts may contain prompt
context/model output; treat `DATA_DIR` as sensitive retained data. On POSIX, the
server sets an owner-only `077` process umask before creating new state. Existing
files retain their prior modes; harden or recreate an older `DATA_DIR` before
shared-host use. Windows deployments need an equivalent private ACL.

Before native context is written, the owned workspace and its `.control-plane`
directory are checked as contained regular non-symlink directories. A symlink
escape fails before adapter start and releases the lease. Service shutdown also
terminates open SSE/keep-alive connections so bounded adapter cleanup and storage
close cannot wait indefinitely behind a client.

## Bearer authentication and loopback

Set exactly one of:

- `CONTROL_PLANE_AUTH_TOKEN`; or
- `CONTROL_PLANE_AUTH_TOKEN_FILE`.

Tokens must contain 32–4096 non-whitespace, non-control characters. A token file
must be a regular non-symlink; on POSIX it must grant no group/other access (use
mode `0600`). `npm run setup:pilot` generates a random ignored local token file
without printing it.

When configured, every `/api` route, including SSE, requires an exact bearer
header. Comparison uses timing-safe fixed-length digests. `/health` and static
assets remain public. Tokens are not returned through HTTP/MCP or intentionally
logged.

Any native adapter or non-loopback `HOST` fails startup without authentication.
This static bearer check is still not production identity, authorization,
rotation, expiry, revocation, CSRF protection, or device/channel attestation.
Keep the pilot on `127.0.0.1`/`::1`.

Loopback means the same device. A phone cannot reach a Mac service at the phone's
own `127.0.0.1`. Do not bind to `0.0.0.0` as a shortcut; remote/mobile use needs a
TLS ingress or authenticated Hermes gateway, caller identity, scoped policy,
rate/abuse limits, and an audited approval principal.

## Hermes isolation

`npm run setup:hermes` creates an empty dedicated profile without cloning the
default profile. It disables Hermes built-in CLI toolsets and built-in/user-profile
memory, then registers a restricted MCP wrapper. The wrapper's server-side allow-list excludes runtime
steering/comparison, general approval resolution, demo reset, and canonical-memory
promotion. Its narrow Atomic fixture approval tool can resolve only the fixed,
evidence-bound disposable pilot gate. The matching artifact-read tool returns
only pending-gate evidence after no-follow, size, checksum, secret-scan, and fatal
UTF-8 checks; success and error responses never include host paths.
Disallowed/unknown MCP tool calls fail closed.

Inference credentials must be configured inside the isolated profile. Reusing an
older cloned profile can carry unrelated MCP servers, settings, skills, or `.env`
secrets; audit or recreate it before testing.

## Environment and secret handling

The process does not auto-load `.env`. Do not commit a token, API key,
`DATABASE_URL`, or provider credential.

Native children receive basic operating-system names plus explicitly approved
runtime-specific variables:

- Atomic offline discovery receives its isolated Atomic directories and offline
  flag; configured provider-secret allow-lists are not inherited for discovery.
- The Atomic fixture runner receives fixed control-plane IDs/contracts and staged
  accepted context only. It runs offline with no forwarded provider secret or
  host authentication state.
- Codex uses its installed CLI authentication state; the pilot does not require a
  new provider key in repository configuration.
- Claude receives `ANTHROPIC_API_KEY` only when the server has both the value and
  `CLAUDE_RUNTIME_ENV_ALLOWLIST=ANTHROPIC_API_KEY`.

Never broad-forward a developer's shell or cloud credentials. Use a dedicated,
short-lived, low-limit Claude key for this read-only probe and unset it after the
server stops.

## Project Brain safety

- Retrieval is local, deterministic, bounded, and read-only.
- General search results are authority-labeled and can include advisory notes;
  callers must not treat every search hit as accepted knowledge.
- Runtime context packs include accepted canonical Markdown only, suppress
  stale/rejected/deprecated/superseded material, and record automatic episodic
  capture as disabled.
- Notes and promotion targets are checked for vault containment, file type, size,
  and hashes.
- Promotion requires the complete unchanged human-reviewed preview, including
  exact target/content/hash/reviewer/timestamp. Missing, tampered, or stale input
  fails. Preview lifetime is 15 minutes with at most 30 seconds of future clock
  skew; an expired preview must be regenerated and reviewed again.
- Pilot Hermes cannot promote, and `smoke:native` previews then rejects its test
  proposal.

A successful promotion writes a real Markdown file before resolving the database
proposal. Those two resources are not one atomic transaction; an operator must
reconcile if the database step fails. Review promoted content for secrets and
prompt-injected claims before approval.

## Workspaces are not sandboxes

A directory/Git worktree and writer lease by themselves provide concurrency isolation only.
They do not block network access, credential access, process escape, symlink
tricks, or writes outside the worktree. The M3 native connectivity pilot therefore
has no writer mode and no implementation/PR action.

Milestone 4 adds a separate, disabled Docker-compatible boundary for a disposable
fixture. It never mounts the developer checkout: an exact clean base commit is
fetched shallowly into a private per-run bare store with one relative worktree.
The container receives that run root as its only writable host bind and receives
separately staged context read-only. It is created with a digest-pinned image,
`--pull never`, network and IPC `none`, read-only root, a numeric non-root user,
built-in seccomp, all capabilities dropped, no-new-privileges, bounded resources,
and no inherited home/cloud/SSH/provider environment. A local daemon socket can
be selected explicitly only as a `unix:///` engine endpoint; it is used by the
host CLI and is never mounted into the writer.

Container labels and inspection bind the run, workspace, lease-owner digest,
fencing token, image, mounts, workdir, network, and privilege policy. Lease loss
stops the old container when exact ownership remains proven; ambiguous ownership
is quarantined without release/reuse or a false stop claim. A stale fence cannot
renew or release a rotated successor. After stop and an exact-fence cleanup
freeze, only manifest-named, contained, regular, single-link files within
configured count/byte bounds may be exported. The freeze uses the durable reason
`writer_filesystem_cleanup_claimed`; it is transient on success and remains
operator evidence if cleanup cannot finish. A deterministic baseline
scan blocks high-confidence private-key/provider/token patterns before atomic
artifact registration or display; findings retain rule IDs/fingerprints, never
matched values. This scanner is not proof that arbitrary data contains no secret.

Fake-engine tests prove orchestration, not isolation. The separate M4 opt-in smoke
passed locally against Colima/Docker and an immutable ARM64 Alpine fixture. M5a
composes that boundary only through a fixture-specific coordinator and narrow MCP
contract; Hermes never receives raw engine, Git, command, or path controls. Direct
Codex and Claude Code remain read-only. A container also remains weaker than a
reviewed remote micro-VM for confidential or hostile multi-tenant work.

For M5a the entire Atomic process runs inside the container. The runner is built
from immutable Node inputs, a checksum-verified Git 2.50.1 source tarball, and a
committed npm lock for Atomic 0.9.12. It receives a staged, bounded copy of the
reviewed package workflow and accepted context, not host Atomic/Codex/Claude homes,
keychain/browser state, Docker socket, SSH agent, cloud configuration, or provider
secret. Post-workflow export is frozen under the exact fence and revalidated
against the native evidence snapshot before persistence. The nine artifact paths,
types, and bounds are fixed.

The fixed M5a process uses Atomic's native `--approve` project/tool trust only
inside that credential-free, network-none container. It does not approve the
control-plane final action: that remains a separate, operator-intended,
evidence-bound gate. M5a authenticates the bearer and exact transition but does
not attest that a human person is present; the live smoke resolves it
automatically after assertions. Do not carry blanket native trust into M5b;
model-backed execution needs authenticated actor provenance plus a reviewed
permission/HIL policy. M5a also assumes one active control-plane pilot coordinator
process. PostgreSQL admission is cross-process, but cancellation ownership is not.

Approval is requested only after Atomic/container stop, artifact registration,
worktree removal, and lease release. Migration 006 binds it to run, project,
workflow, evidence digest, policy hash, and expiry. Approve cannot resurrect the
writer; it records `externalActionPerformed=false`. Deny/request-changes terminalize
the cleaned candidate. Approval expiry fails closed. `crossProcessResume=false`:
an active process is never claimed resumable after control-plane restart.

Before any model-backed or general-repository writing runtime:

1. enforce reviewed model egress policy rather than changing the default
   no-network posture;
2. inject short-lived least-privilege credentials after start through a separate
   broker, never ambient host state;
3. bind human approval to exact action/run/project/evidence/expiry;
4. add defense-in-depth secret scanning appropriate to the repository and retain
   only governed artifacts/memory proposals;
5. keep PR creation, merge, deploy, destructive database change, secret expansion,
   and canonical promotion behind separate policy decisions.

## Storage and retained command data

- SQLite is the local default. PostgreSQL is explicit and never receives an
  automatic copy of SQLite data.
- Use parameterized SQL and never log `DATABASE_URL` or error objects that may
  embed it.
- Persistent PostgreSQL needs separate migration/runtime roles, TLS, backups,
  retention, monitoring, and restore drills.
- Migration mismatch/unavailability fails startup; there is no fallback to
  SQLite. Demo seed/reset are hard-disabled for PostgreSQL.
- Migration 004 adds explicit lease owners, monotonic fencing epochs, and durable
  quarantine. Existing v3 leases backfill as owner=run/token=1 and must be treated
  as legacy until quarantined/cleaned/rotated. Migration 005 adds the exact-fenced
  sandbox-instance lifecycle, immutable engine/image/policy evidence, bounded
  cleanup attempts, and quarantine state. Older binaries reject the v5 ledger;
  rollback requires a pre-v5 backup rather than a destructive down migration.
  Migration 006 adds all-or-none project/workflow/evidence-digest/policy-hash/
  expiry fields for the M5a final gate plus an expiry index. Older binaries reject
  the v6 ledger; rollback requires a verified pre-v6 backup or separate compatible
  database. There is no destructive down migration.
- A fence protects database state, not raw filesystem writes. Terminating and
  inspecting the exact labeled container remains mandatory before release/reuse.
- Idempotency/outbox/events may retain objectives, native output, approval effects,
  and identifiers. Apply access controls and deletion/retention policy before
  persistent use.
- The server now sets a POSIX `077` umask for new SQLite/runtime/artifact state.
  Files created by an older checkout retain their previous mode and Windows needs
  an equivalent private ACL; harden or recreate that state before shared-host use.
- The durable outbox has no external publisher yet.

## Dependency and source trust

Pin and review every runtime, skill, extension, MCP server, and package before it
runs with host-process authority. The imported Atomic Workflow Architect subtree
is visible in this public repository but retains its own `UNLICENSED`, private-use,
all-rights-reserved notice. Root MIT licensing does not override it.

`setup:atomic` pins `@bastani/atomic` at the top level for the M3 host connectivity
probe, but installs into ignored runtime state without a committed lockfile for
its transitive graph. Do not reuse that install as the M5 writer. The M5a runner
has its own committed lock and immutable/checksummed build inputs, but that review
establishes only the fixed tool-only fixture path. It does not validate a provider,
model, general workflow, native HIL, or durable DBOS/PostgreSQL resume.

Wesley explicitly chose public repository visibility on 2026-08-11. Never commit a
secret, private project context, raw provider transcript, or confidential
vulnerability report.

## Reporting a security issue

Do not place credentials or confidential exploit details in a public issue. Send
the repository owner a minimal reproduction through a private channel.
