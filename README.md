# Valkyrie Agent Control Plane — Prototype v0.3.0

Valkyrie is a runnable, local-first demonstration of Wesley's mobile-oriented
Project OS and agent control plane. It shows how projects, bounded agent runs,
approvals, evidence, workspace leases, and governed memory fit together.
Valkyrie is the repository/project name; the current service, browser, and MCP
identifiers retain “Wesley Agent Control Plane” for contract compatibility.

> **Current status:** the control-plane, HTTP/MCP transports, SQLite storage, and
> PostgreSQL storage contracts are real. All Atomic, Codex, Claude, Prime, and
> Hermes runtime execution is scripted simulation. This version does not run an
> autonomous coding agent or create a real pull request.

This is the user guide for the work in
[draft PR #1](https://github.com/wesleykao1990/valkyrie-agent/pull/1).

## What you can do today

| Capability | Where to use it | What really happens |
|---|---|---|
| View a three-project portfolio | Browser, HTTP, MCP | Reads seeded local project/task state; it does not query Linear. |
| Capture an idea and detect an exact/similar duplicate | Browser, HTTP, MCP | Writes a local task and searches local Project Brain Markdown; it does not create a Linear issue. |
| Start a scripted runtime | Browser (Atomic, Codex, Claude, Prime); HTTP/MCP (those four plus Hermes) | Creates a real run record, workspace record, writer lease, events, and simulated cost counter; the selected runtime is a mock. |
| Compare runtime candidates | Browser (fixed Atomic/Codex/Claude trio); HTTP/MCP (2–4 distinct runtimes) | Creates separate runs/workspaces with one comparison ID; it does not score or select a winner. |
| Inspect, steer, and cancel runs; watch progress | Browser auto-refresh; HTTP reads/SSE; MCP polling | State transitions and events are real; steering is only recorded by the mock and does not alter an agent's reasoning. |
| Approve, deny, or request changes | Browser, HTTP, MCP | Transactionally records the decision and changes the simulated lifecycle; approval does not create a real PR. |
| Store artifacts and checksums | Browser/API plus `data/artifacts/` | Files are real, but their check/verifier contents are explicitly marked simulated. |
| Search and propose Project Brain knowledge | HTTP, MCP | Searches local Markdown and stores governed proposals; automatic promotion remains disabled. |
| Promote a reviewed proposal | Browser, HTTP, MCP | **Really writes accepted Markdown** under `project-brain/`; this is not a simulation, has no confirmation dialog, and the file/database update is not yet atomic. |
| Exercise durable storage semantics | SQLite by default; PostgreSQL opt-in | Migrations, transactions, idempotency, outbox rows, claims, and reconciliation are implemented; no external outbox publisher exists. |

## What it cannot do yet

- Run a real Atomic, Codex, Claude, Prime, or Hermes process.
- Read or update Linear or OpenViking through a live connector, or implement code
  in a product repository. An optional local-repository setting can create a real
  branch/worktree, but the mock never edits it.
- Create or merge a real pull request, deploy software, or select a comparison winner.
- Authenticate HTTP/MCP callers or prove that an approval caller is Wesley.
- Provide a security sandbox. A directory or Git worktree plus writer lease is a
  coordination boundary, not container/VM isolation.
- Enforce a real provider budget. Mock costs are capped counters, not a kill switch.
- Deliver outbox events to an external system.

Keep the prototype on localhost and use disposable data.

## Fastest setup: local SQLite demo

### Requirements

- Node.js `22.16.0` or newer.
- npm, included with a normal Node installation.
- Git if you are cloning the repository.

PostgreSQL is **not** needed for the normal demo.

### 1. Get the code

```bash
git clone https://github.com/wesleykao1990/valkyrie-agent.git
cd valkyrie-agent
```

While PR #1 is unmerged, switch to its branch. Skip this command if you are
already reading the README from that branch.

```bash
git switch --track origin/agent/postgres-atomic-integration
```

### 2. Install and start

```bash
node --version
npm ci
npm start
```

The default command:

- listens on `http://127.0.0.1:8787`;
- creates `./data/control-plane.sqlite`;
- applies SQLite migrations automatically;
- seeds three demonstration projects and tasks;
- starts only scripted runtimes;
- needs no credential or external service.

`127.0.0.1` is the **loopback** address: only programs on the same computer can
connect. It does not expose the unauthenticated prototype to your Wi-Fi network or
the internet.

Check health from a second terminal:

```bash
curl -fsS http://127.0.0.1:8787/health
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787) in a browser.

### 3. Try the five-minute walkthrough

1. Review the three project cards: Ovalo, Signal Ledger, and AI Workflow Watch.
2. Under **Capture idea**, enter an idea once, then submit it again to see the
   local duplicate check.
3. Under **Start demo work**, choose a project and runtime, enter an objective,
   and start an isolated run.
4. Open **Inspect** on the run to see its timeline, workspace ID, simulated cost,
   and artifact checksums. You can record a steering instruction or cancel it.
5. Atomic, Codex, and Claude mock runs eventually appear under **Approvals**.
   Approve resumes the mock, request-changes returns it to its scripted
   implementation stage, and deny fails it.
6. After completion, inspect its governed memory proposal. **Reject** only changes
   database state. **Promote** writes a canonical Markdown decision into the
   checkout, so use it only when you intend to change Project Brain content.
7. Use **Start Atomic / Codex / Claude A/B pilot** to create three separate mock
   candidates. Completion does not mean any candidate was accepted.

The page refreshes automatically. All approval evidence and runtime events that
come from a mock are labelled simulated.

## Configuration

Defaults and available variable names are documented in `.env.example`, but the
application does **not** load a `.env` file automatically. Export variables in the
shell or prefix the command explicitly:

```bash
PORT=8877 DATA_DIR=/tmp/valkyrie-demo npm start
```

Common settings:

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` | Listen address. Keep loopback until authentication exists. |
| `PORT` | `8787` | HTTP/developer-console port. |
| `DATA_DIR` | `./data` | SQLite, artifact, and workspace parent directory. |
| `PROJECT_BRAIN_DIR` | `./project-brain` | Local Markdown knowledge root. |
| `DEMO_STAGE_DELAY_MS` | `1200` | Delay between mock stages. |
| `CONTROL_PLANE_STORE` | `sqlite` | Select `sqlite` or `postgres`. |
| `SEED_DEMO_DATA` | `true` for SQLite | Seed local demonstration projects/tasks. |
| `ENABLE_DEMO_RESET` | `true` for SQLite | Expose the unauthenticated local reset action. |
| `REPOSITORY_PATH_<PROJECT>` | unset | Opt in to creating a real branch and Git worktree for that project. See the warning below. |

`DEFAULT_RUNTIME` is currently reserved but does not select a runtime. The UI/API
request or routing policy chooses it.

For the normal demo, ensure no `REPOSITORY_PATH_*` variable is exported. Setting,
for example, `REPOSITORY_PATH_OVALO=/path/to/repository` makes each Ovalo run call
`git worktree add -b agent/<run-id>` against that repository. This really creates
a branch and worktree even though the selected runtime remains a mock and writes
no implementation. Use only a disposable repository until cleanup and sandboxing
are implemented.

## Ways to use the prototype

### Browser console

The browser is the easiest demonstration surface. It provides portfolio cards,
idea capture, mock-run launch/comparison, run inspection, approval decisions,
memory decisions, and SQLite demo reset.

It is a developer console, not the intended Hermes mobile experience and not a
roadmap system of record.

### HTTP API

The API uses the same base URL as the browser. For example:

```bash
curl -fsS http://127.0.0.1:8787/api/portfolio

curl -sS -X POST http://127.0.0.1:8787/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "projectId": "ovalo",
    "objective": "Exercise the governed mock lifecycle",
    "runtime": "atomic",
    "maxCostUsd": 8,
    "idempotencyKey": "readme-demo-run-001"
  }'
```

Reuse an `idempotencyKey` only for the same logical run request. Reusing it with
different content returns a conflict.

Stream one run's normalized events after copying its run ID from the response:

```bash
curl -N http://127.0.0.1:8787/api/runs/RUN_ID/events
```

See [docs/API.md](docs/API.md) for every route. The complete HTTP surface is
unauthenticated; do not expose it beyond loopback.

### Hermes-compatible MCP bridge

First keep the HTTP service running. Configure your local MCP client to launch
this clean stdio executable:

```text
/absolute/path/to/valkyrie-agent/bin/project-os-mcp
```

Set `CONTROL_PLANE_API` for the bridge only when the local service uses a different
port:

```bash
CONTROL_PLANE_API=http://127.0.0.1:8877 ./bin/project-os-mcp
```

The MCP command waits for JSON-RPC on stdin; it is not an interactive shell UI.
Prefer the wrapper over plain `npm run mcp`, because npm's banner can corrupt the
stdio protocol.

The bridge advertises 15 tools for projects, ideas, runs, comparisons, approvals,
and memory. Omit `memory_promote` from a Hermes allow-list until authentication and
exact-action approval binding exist. See
[docs/HERMES_MCP_SETUP.md](docs/HERMES_MCP_SETUP.md).

## Local data and reset behavior

| Path | Contents |
|---|---|
| `data/control-plane.sqlite` | Default SQLite state. |
| `data/artifacts/<run-id>/` | Simulated check, verifier, and summary files. |
| `data/workspaces/<run-id>/` | Prototype directories or optional Git worktrees. |
| `project-brain/` | Local accepted/advisory Markdown. Promotion writes here. |

There are two different reset paths:

- The browser's **Reset demo** action has no confirmation dialog. It
  transactionally clears SQLite operational records and reseeds demo tasks while
  the server is running.
- After stopping the server with `Ctrl-C`, `npm run reset` deletes the SQLite main,
  WAL, and shared-memory files under `DATA_DIR`. It reports filesystem failures
  instead of claiming success. The next start recreates and seeds the database.

Neither reset removes artifact/workspace directories or undoes promoted Project
Brain Markdown. The offline command refuses to run when
`CONTROL_PLANE_STORE=postgres`; no PostgreSQL reset command exists.

Memory promotion is also a deliberate local mutation: the Markdown write happens
before proposal state is resolved in the database. If the second step fails, an
operator must reconcile the file and proposal manually.

## Docker Compose demo

Docker is optional. The included Compose service runs the same SQLite demo and
publishes it only on host loopback:

```bash
docker compose -f docker-compose.prototype.yml up --build
curl -fsS http://127.0.0.1:8787/health
docker compose -f docker-compose.prototype.yml down
```

`down` preserves the named SQLite data volume. Compose mounts `./project-brain`
read/write, so memory promotion changes the host checkout. The container is a
local prototype—not a production sandbox—and does not include the PostgreSQL
server/CLI toolchain needed for full repository verification (it does include the
application-side JavaScript client).

## PostgreSQL mode: storage development only

PostgreSQL is a contract-tested production **candidate**, not a complete end-user
deployment. Use PostgreSQL 16 or a deliberately tested later version.

Create a dedicated local role/database, supplying the password through an
appropriate local secret mechanism:

```bash
createuser --pwprompt control_plane
createdb --owner=control_plane control_plane
```

Inject `DATABASE_URL` from a password manager or another secret mechanism without
placing its value in shell history. Then run forward-only migrations and start
without runtime auto-migration:

```bash
CONTROL_PLANE_STORE=postgres \
npm run migrate

CONTROL_PLANE_STORE=postgres \
POSTGRES_AUTO_MIGRATE=false \
npm start
```

Do not commit or paste a real password into documentation, logs, or shell history.
Use separate migration/runtime roles, TLS, backups, and secret injection for any
persistent environment.

Important current behavior:

- PostgreSQL selection never falls back to SQLite.
- There is no SQLite-to-PostgreSQL copy or dual write.
- Demo seeding and reset are hard-disabled in PostgreSQL mode.
- A freshly migrated PostgreSQL database therefore has an empty portfolio until a
  future governed project-ingestion/bootstrap path provisions it.
- `POSTGRES_SSL=require` applies to the migration command. Runtime TLS must be
  represented in `DATABASE_URL`.

See [docs/STORAGE.md](docs/STORAGE.md) before persistent use.

## Verification

For ordinary use, PostgreSQL remains invisible. The full verifier creates a
temporary PostgreSQL cluster on a random loopback port, tests it, stops it, and
removes it automatically.

Requirements for the full command:

- Node.js `22.16.0` or newer;
- PostgreSQL 16 command-line programs `initdb` and `pg_ctl` on `PATH`;
- a non-root user, writable `/tmp`, and permission to bind a local loopback port.

```bash
npm run verify
```

The unit and smoke wrappers strip inherited persistent database and
`REPOSITORY_PATH_*` settings from disposable fixture processes. `npm run
test:postgres` supplies its own explicit test sentinel and disposable database
URL.

Useful narrower checks:

```bash
npm run typecheck
npm test
npm run test:postgres
npm run verify:atomic
npm run smoke:http
npm run smoke:mcp
```

## Troubleshooting

### `listen EPERM ... 127.0.0.1`

Your sandbox or managed environment forbids opening even a local-only socket.
Allow loopback binding or run the command in a normal local terminal. This is an
environment restriction, not a PostgreSQL schema failure.

### `EADDRINUSE`

Another process already uses the selected port. Stop it or choose another:

```bash
PORT=8877 npm start
```

### `initdb` or `pg_ctl` not found

Install PostgreSQL 16 command-line tools or run only the SQLite-focused checks.
Normal `npm start` does not need them.

### `.env` changes have no effect

The application does not auto-load `.env`. Export the values or prefix the start
command as shown above.

### PostgreSQL starts with no projects

That is the current safe behavior: demo seeding is disabled for PostgreSQL. Use
SQLite for the walkthrough until governed project ingestion exists.

### MCP output contains non-JSON text

Use `bin/project-os-mcp` as the configured command. Do not use plain
`npm run mcp` for a strict stdio client.

## Architecture and continuation

The control plane deliberately preserves separate authorities:

- Hermes: conversation and mobile interface.
- Linear: roadmap and issue state.
- Git/GitHub plus executable checks: implementation and delivery truth.
- Accepted Project Brain Markdown: reviewed rationale and decisions.
- Control plane: stable IDs, policy, budgets, approvals, leases, normalized
  events, and artifact references.
- Native runtime: its own internal workflow/session state.

The integrated Atomic package at `packages/atomic-workflow-architect/` is inert
source. Its presence neither installs Atomic nor enables a live adapter. The next
milestone is the disabled-by-default JSONL Atomic adapter with a deterministic
fake process.

Start with [START_HERE.md](START_HERE.md), then read
[docs/CONTINUATION_PLAN.md](docs/CONTINUATION_PLAN.md) and
[docs/NEXT_SESSION_PROMPT.md](docs/NEXT_SESSION_PROMPT.md).

## Security and license

Read [SECURITY.md](SECURITY.md) before enabling any non-mock runtime or exposing a
service beyond localhost.

The repository root is MIT licensed. `packages/atomic-workflow-architect/` retains
its own `UNLICENSED`, private-use, all-rights-reserved notice; the root license does
not supersede it. Public source visibility grants no additional right to use,
copy, or redistribute that nested subtree.
