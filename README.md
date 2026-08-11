# Valkyrie Agent Control Plane — prototype v0.3.0

Valkyrie is Wesley's local-first, mobile-oriented Project OS control plane. It
coordinates project context, one root runtime per run, bounded workspaces,
approvals, evidence, and governed Project Brain memory. Hermes is the intended
conversation interface; this repository supplies the control plane and its local
MCP bridge.

This is the user guide for
[draft PR #1](https://github.com/wesleykao1990/valkyrie-agent/pull/1).

## What PR #1 can do

There are two deliberately different modes.

| Area | Default demo | Authenticated native pilot |
|---|---|---|
| Storage | Automatic local SQLite; PostgreSQL is an opt-in, contract-tested adapter | Automatic local SQLite |
| Atomic | Deterministic mock lifecycle | Real Atomic 0.9.12 LF-JSONL process, but **offline package/workflow discovery only**; no model call |
| Codex | Deterministic mock lifecycle | Real authenticated Codex CLI model call in `read-only`/ephemeral mode |
| Claude Code | Deterministic mock lifecycle | Optional real `--bare` model call using an explicitly allow-listed `ANTHROPIC_API_KEY`; OAuth/keychain state is ignored |
| Hermes | Local MCP bridge | Isolated Hermes profile, authenticated stdio MCP, and a restricted tool list |
| Project Brain | Read accepted local Markdown; propose/review/reject/promote separately | Search, proposal, exact promotion preview, and rejection; pilot MCP cannot promote |
| Events/evidence | Real run records around simulated stages | Raw native JSONL plus normalized events, native IDs, checksummed context/run-contract/result artifacts |
| Writer isolation | Disabled; simulated directories/worktrees remain concurrency aids only | A real Docker-compatible boundary, fenced leases, strict private Git worktrees, and secret-scanned artifact export are contract-tested and live-verified locally, but **not connected to model runtimes** |

The native pilot is a connectivity slice, not a coding pipeline. It cannot edit a
repository, run Atomic's model workflow, create a PR, merge, deploy, call Linear,
or use OpenViking. The Milestone 4 writer boundary now exists as an internal,
disabled provider contract, and its local Colima/Docker live smoke and restart
contracts pass. No model runtime is connected to it. All native final actions remain
fixed to `analysis_only`. A successful pilot run is connectivity evidence, not
implementation acceptance.

## Requirements

- Node.js `22.16.0` or newer and npm.
- Git when cloning the repository.
- For the default demo: nothing else.
- For the native pilot: the pinned Atomic install, Codex CLI
  `0.147.0-alpha.6.5` with working `codex login status`, and optionally Claude
  Code `2.1.81` plus an Anthropic API key.
- Hermes CLI for the Hermes walkthrough (this pilot was exercised with `0.19.0`).
- Optional Milestone 4 live test: a Docker-compatible CLI/daemon reachable through
  its default local socket or one explicitly configured local `unix:///` socket,
  plus an already-present, reviewed image referenced by immutable SHA-256 digest.

The pilot fails closed when an installed runtime version differs from its pinned
contract. Do not change an expected-version setting merely to bypass that check;
contract-test the new version first.

## Five-minute default demo

```bash
git clone https://github.com/wesleykao1990/valkyrie-agent.git
cd valkyrie-agent
git switch --track origin/agent/postgres-atomic-integration  # while PR #1 is unmerged
npm ci
npm start
```

Open <http://127.0.0.1:8787>. The default starts only mock runtimes, creates
`data/control-plane.sqlite`, applies migrations, and seeds three disposable
projects. No PostgreSQL server or credential is needed.

Try idea duplicate detection, separate Atomic/Codex/Claude mock candidates,
timeline inspection, approval decisions, evidence artifacts, and governed memory
proposals. Mock events and artifacts are marked simulated.

Stop with `Ctrl-C`. To reset only operational SQLite state after stopping:

```bash
npm run reset
```

This does not remove artifact/workspace directories or undo accepted Project
Brain Markdown.

## Test the authenticated native pilot

### 1. Prepare local, ignored runtime state

```bash
npm ci
npm run setup:atomic
npm run setup:pilot
```

`setup:atomic` installs exactly `@bastani/atomic@0.9.12` under ignored
`data/runtime/atomic/`. `setup:pilot` creates a random bearer token at ignored
`data/auth/control-plane.token`, with mode `0600`, and never prints the token.

Confirm direct runtime readiness:

```bash
codex --version
codex login status
claude --version       # optional
```

### 2. Start the pilot server

For Atomic plus Codex, with Claude reported as an honest skip:

```bash
./bin/project-os-pilot-server
```

To include Claude, inject the key into the shell from your password manager and
allow-list only its variable name before starting the server:

```bash
export CLAUDE_RUNTIME_ENV_ALLOWLIST=ANTHROPIC_API_KEY
# Populate ANTHROPIC_API_KEY without committing it or pasting it into this repo.
./bin/project-os-pilot-server
```

The wrapper enables the three native adapters, requires bearer authentication,
disables demo reset, and keeps the service on `127.0.0.1:8787` unless explicitly
overridden. It never falls back from a requested native adapter to a mock.

### 3. Run the live smoke from a second terminal

```bash
npm run smoke:native
```

The smoke test:

1. proves `/api/*` rejects an unauthenticated request and accepts the local token;
2. prints all three runtime preflights;
3. performs Atomic credential-free offline RPC/package discovery;
4. requests the exact marker `VALKYRIE_CODEX_LIVE_OK` from the real read-only
   Codex model;
5. runs the equivalent Claude probe only when its preflight is available;
6. verifies raw native records, normalized completion, local artifact files, and
   every artifact checksum;
7. searches accepted Project Brain Markdown, creates a proposal, obtains its
   exact promotion preview, and **rejects** it.

It never calls memory promotion, edits a repository, creates a PR, or deploys.
The script expects to run on the same computer as the server because it verifies
the local artifact files referenced by the API. Set `CONTROL_PLANE_API` only when
using another loopback port.

### 4. Test Hermes through the restricted MCP bridge

Keep the pilot server running, then:

```bash
npm run setup:hermes
hermes -p valkyrieeval mcp test valkyrie_project_os
```

The setup creates an **empty**, dedicated Hermes profile rather than cloning the
default profile. Hermes's built-in CLI toolsets, built-in memory, and user-profile
memory are disabled in that profile so the Project Brain/MCP test is not
contaminated. If an older
`valkyrieeval` profile exists without the isolation marker, the script stops and
tells you to audit or recreate it.

Configure inference inside that profile, then start a conversation with only the
Valkyrie MCP toolset:

```bash
hermes -p valkyrieeval setup model
hermes -p valkyrieeval chat -t valkyrie_project_os
```

Useful test prompts:

```text
List my Valkyrie projects and report which runtime integrations are available.
Search the Ovalo Project Brain for the accepted terminology preload decision.
Propose (but do not promote) a memory that this Hermes MCP connectivity test passed.
Start a Codex runtime-connectivity run for Ovalo that returns VALKYRIE_HERMES_CODEX_OK, then inspect its evidence.
```

The pilot MCP allow-list omits approval resolution, steering, comparison, demo
reset, and canonical-memory promotion. Hermes can preview a proposed promotion but
cannot perform it. See [the Hermes guide](docs/HERMES_MCP_SETUP.md) for exact tool
names and troubleshooting.

This setup was live-tested with Hermes `0.19.0` using
`gpt-5.6-sol`/`openai-codex`: the model called runtime status and Project Brain
search through the restricted MCP server. Choose a model actually supported by
your Hermes provider; `gpt-5.3-codex` returned HTTP 400 on the ChatGPT-account
Codex endpoint during this test.

This tests Hermes on the Mac hosting the stdio MCP child. It does not yet expose a
phone-facing gateway. A phone cannot connect to `127.0.0.1` on the Mac: on a phone,
loopback means the phone itself. Remote/mobile exposure requires a separately
authenticated channel and is not enabled in PR #1.

## Test the Milestone 4 writer boundary

Milestone 4 adds a real but disabled Docker-compatible provider and an internal
fixture coordinator. It does **not** make Atomic, Codex, or Claude Code a writer.
The deterministic suite proves exact orchestration and failure handling; only an
opt-in test against a real engine can provide isolation evidence.

Run the safe default first:

```bash
npm run smoke:sandbox
```

Normal verification reports an honest skip because it strips every live-engine
variable. On this Mac the explicit opt-in smoke passed against Colima `0.10.3`,
Docker Engine `29.5.2`, and the immutable ARM64 Alpine digest recorded in
[the verification record](docs/VERIFICATION.md). A skip on another host is not a
Milestone 4 live pass.

To reproduce it with an installed and started Docker-compatible engine:

This Mac uses the following local stack:

```bash
brew install colima docker  # installs Lima as Colima's VM dependency
colima start --runtime docker --vm-type vz --cpu 2 --memory 4 --disk 16
docker pull alpine:3.22.5
install -d -m 700 "$HOME/.valkyrie/oci-live-tmp"
```

The measured Homebrew footprint is about 115 MB (`colima` 10 MB, `lima` 78 MB,
Docker CLI 27 MB). The current sparse Colima VM consumes about 1.1 GB on the host,
has a 16 GiB virtual disk, and the Alpine image consumes 13.4 MB. Keep at least
5 GiB free for this fixture and preferably 15 GiB or more before Milestone 5
model images/build caches. These are measured local values, not fixed package
guarantees.

1. Choose and review a tiny POSIX fixture image that supplies `sleep`, `/bin/sh`,
   `id`, `grep`, and `touch`.
2. Pull it deliberately, then obtain an immutable local repo digest. For Docker,
   `docker image inspect --format '{{index .RepoDigests 0}}' IMAGE` prints the
   digest reference when available.
3. Set the exact absolute CLI path and digest, then run the smoke:

```bash
export VALKYRIE_OCI_LIVE_ENGINE=/absolute/path/to/docker
export VALKYRIE_OCI_LIVE_IMAGE='registry.example/image@sha256:<64-hex-digest>'
export VALKYRIE_OCI_LIVE_ROOT='/absolute/private/engine-visible/test-root'

# Optional only when the host UID/GID cannot be derived. This must be the
# reviewed non-root numeric owner of the bind-mounted fixture directories.
export VALKYRIE_OCI_LIVE_USER='501:20'

# Optional for Docker Desktop/rootless engines when the default socket is absent.
# Only a local absolute unix:/// endpoint is accepted; TCP engines are rejected.
export VALKYRIE_OCI_LIVE_SOCKET='unix:///absolute/path/to/docker.sock'

npm run smoke:sandbox
```

`VALKYRIE_OCI_LIVE_ROOT` must be an existing owner-private (`0700` on POSIX),
non-symlink directory visible to the selected engine. This is explicit because
macOS VM engines do not necessarily share the host's system temporary directory.

The provider uses `--pull never`; it will not download an image for you. The live
smoke verifies the effective ownership labels/fence, digest-pinned image, no
network, read-only root and context, writable candidate directory, non-root user,
built-in seccomp, dropped capabilities, no-new-privileges, resource bounds,
absence of a host secret canary, artifact export, and ownership-aware cleanup.
By default the smoke uses the current non-root host UID:GID so its strict private
bind root is writable; `VALKYRIE_OCI_LIVE_USER` is an explicit reviewed override.
It mounts no Docker socket, home directory, cloud configuration, SSH agent, or
provider credential into the container.

The full writer lifecycle is separately deterministic-tested as:

```text
clean source + exact base commit
  → private shallow bare Git store + one relative worktree
  → owner/fencing-token lease + heartbeat
  → bounded container execution and owned stop
  → exact-fence cleanup freeze
  → bounded baseline secret scan
  → atomic checksummed artifact registration
  → owned container/worktree cleanup
  → exact-fence release
```

The cleanup freeze is recorded as the transient quarantine reason
`writer_filesystem_cleanup_claimed` and is released only after export persistence,
container cleanup, and filesystem removal are proven. If the fence, effective
policy, secret scan, persistence, or cleanup cannot be proven, quarantine remains
durable and the workspace is not automatically reused. Ownership ambiguity is
quarantined without claiming that the container stopped. The built-in scanner is
a high-confidence deterministic baseline, not proof that arbitrary content is
secret-free. Do not use production credentials or confidential repositories.

`npm test` and `npm run verify` strip inherited live-sandbox variables, so normal
verification cannot accidentally contact a real engine. See
[the Milestone 4 plan](docs/IMPLEMENTATION_PLAN_M4.md) and
[proposed ADR-P004](docs/adr/ADR-P004-external-writer-boundary.md).

## Loopback and the “invisible” database

`127.0.0.1` and `::1` are loopback addresses. A listener on loopback accepts
connections only from the same computer. Other devices on Wi-Fi and the public
internet cannot reach it. This is why the unauthenticated default mock demo is
allowed only on loopback. The native pilot adds a bearer token as a second
boundary, but still defaults to loopback.

Most agent harnesses hide their persistence behind local files or an embedded
database. Valkyrie does the same for normal use: SQLite is a single file created
and migrated automatically under `data/`. You do not start, configure, or think
about a database. PostgreSQL exists here because the control plane needs tested
transaction/restart semantics for future multi-process use; it is optional for
the demo and pilot.

## Authenticated HTTP examples

`/health` and static files remain public on the local listener. When a token is
configured, every `/api` route—including the SSE event stream—requires
`Authorization: Bearer ...`.

```bash
export CONTROL_PLANE_AUTH_TOKEN_FILE="$PWD/data/auth/control-plane.token"
VALKYRIE_BEARER="$(tr -d '\n' < "$CONTROL_PLANE_AUTH_TOKEN_FILE")"

curl -fsS \
  -H "Authorization: Bearer $VALKYRIE_BEARER" \
  http://127.0.0.1:8787/api/runtimes

curl -fsS -X POST \
  -H "Authorization: Bearer $VALKYRIE_BEARER" \
  -H 'content-type: application/json' \
  http://127.0.0.1:8787/api/runs \
  -d '{
    "projectId":"ovalo",
    "objective":"Return exactly VALKYRIE_MANUAL_CODEX_OK and nothing else.",
    "runtime":"codex",
    "workflow":"runtime-connectivity",
    "maxCostUsd":1,
    "idempotencyKey":"manual-native-probe-001"
  }'

unset VALKYRIE_BEARER
```

Reuse an idempotency key only for the exact same logical request. See
[docs/API.md](docs/API.md) for routes and response shapes.

The browser developer console does not currently collect or store a bearer token.
Use it for the default mock demo; use the smoke, HTTP, or Hermes MCP surfaces for
the authenticated native pilot.

## Project Brain memory boundary

- Accepted canonical Markdown under `project-brain/Projects/**/Decisions/` is
  authoritative for reviewed rationale.
- Search is deterministic and read-only, but its authority-labeled results may
  include advisory notes. Callers must inspect `authority` and `status`; only
  accepted canonical material is authoritative.
- Stale, rejected, deprecated, and superseded notes are suppressed from bounded
  runtime context packs.
- A runtime context pack contains accepted canonical Markdown only and records
  `automaticEpisodicCapture: false`.
- Proposal, exact promotion preview, promotion, and rejection are separate API
  actions. Promotion writes a real Markdown file and is intentionally excluded
  from the pilot Hermes allow-list.
- Promotion previews expire after 15 minutes and tolerate at most 30 seconds of
  future clock skew. Regenerate and re-review an expired preview; never edit its
  timestamp.
- Hermes session memory and runtime transcripts are advisory; they never override
  current Linear/Git truth or accepted Project Brain decisions.

## Configuration

The application does not auto-load `.env`. Export variables or set them for one
command. Important settings are:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | HTTP listener. Non-loopback startup requires auth. |
| `DATA_DIR` | `./data` | SQLite, workspaces, runtime state, and artifact parent. |
| `PROJECT_BRAIN_DIR` | `./project-brain` | Local accepted/advisory Markdown root. |
| `CONTROL_PLANE_AUTH_TOKEN_FILE` | unset | Regular non-symlink token file, mode `0600`, 32–4096 bytes. |
| `ATOMIC_ADAPTER`, `CODEX_ADAPTER`, `CLAUDE_ADAPTER` | `mock` | Each must be explicitly set to `native` for the pilot. |
| `*_EXPECTED_VERSION` | pinned versions above | Exact runtime contract; mismatch is unavailable. |
| `CLAUDE_RUNTIME_ENV_ALLOWLIST` | empty | Must contain `ANTHROPIC_API_KEY` for a live Claude probe. |
| `CONTROL_PLANE_STORE` | `sqlite` | Select `postgres` only for storage development. |
| `REPOSITORY_PATH_<PROJECT>` | unset | Creates a real branch/worktree even for a mock; use only a disposable repo. |

See [.env.example](.env.example) and [SECURITY.md](SECURITY.md). Runtime child
environments are allow-listed; the control plane does not forward the full shell.

## Verification

The full verifier runs type checking, unit/service/runtime contracts, a disposable
PostgreSQL 16 suite, Atomic package verification, HTTP smoke, and MCP smoke:

```bash
npm run verify
```

Full verification requires PostgreSQL 16 `initdb` and `pg_ctl` on `PATH`; normal
use does not. Useful narrower checks:

```bash
npm run typecheck
npm test
npm run verify:atomic
npm run smoke:http
npm run smoke:mcp
npm run smoke:native   # opt-in; requires the running authenticated pilot
```

## Troubleshooting

- `listen EPERM ... 127.0.0.1`: the managed environment blocks local sockets;
  allow loopback binding or run in a normal terminal.
- `EADDRINUSE`: stop the existing listener or set the same alternate `PORT` and
  `CONTROL_PLANE_API` for server and clients.
- `401 Unauthorized`: use the same token file for server, smoke, and MCP; do not
  set both inline-token and token-file variables.
- Runtime version unavailable: install the pinned version or deliberately update
  and contract-test the adapter before changing the pin.
- Claude skipped: provide `ANTHROPIC_API_KEY` and include exactly that name in
  `CLAUDE_RUNTIME_ENV_ALLOWLIST`; existing OAuth/keychain login is not used.
- Hermes profile already exists: audit it, or run
  `hermes profile delete valkyrieeval` and repeat `npm run setup:hermes`.
- MCP output contains non-JSON: configure `bin/project-os-pilot-mcp`, not plain
  `npm run mcp`, so npm banners cannot corrupt stdio.

## Architecture, storage, and license

Hermes remains an interface. Linear is the future live roadmap authority;
Git/GitHub and executable checks are implementation truth; accepted Project Brain
Markdown is decision truth; the control plane owns stable IDs/policy/budgets/
approvals/leases/events; each native runtime owns its own session state.

Read [START_HERE.md](START_HERE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/STORAGE.md](docs/STORAGE.md), and
[docs/CONTINUATION_PLAN.md](docs/CONTINUATION_PLAN.md) before extending the pilot.

The root repository is MIT licensed. The imported
`packages/atomic-workflow-architect/` subtree retains its own `UNLICENSED`,
private-use, all-rights-reserved notice. Wesley explicitly chose public repository
visibility; public visibility does not extend the root MIT grant to that subtree.
The pilot setup pins Atomic's top-level version, but its ignored live install has
no committed transitive-dependency lockfile; review and lock that graph before a
production-style deployment.
