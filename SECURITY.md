# Security model for the prototype

This repository demonstrates control-plane contracts. It is **not** a production sandbox and must not be pointed at confidential repositories with production credentials until the continuation milestones are implemented.

## Accepted boundaries

- One root runtime owns each run lifecycle.
- Every writing candidate receives a separate workspace and one writer lease.
- Hermes receives constrained project/run/approval/memory tools, not raw shell, container, credential, or worktree controls.
- Linear, Git/GitHub, and accepted Markdown remain authoritative for roadmap, code, and project rationale respectively.
- Retrieved or inferred memory cannot override current operational truth or accepted decisions.

## Prototype safety posture

- Mock runtimes are the default and execute no external coding-agent command.
- The HTTP server binds to `127.0.0.1` by default.
- The SQLite database and generated artifacts are local demo data.
- No production secret is required or bundled.
- The Atomic RPC class is a scaffold and is not selected by the default runtime registry.
- The Atomic scaffold passes only a minimal operating-system environment unless additional variable names are explicitly allow-listed.
- The imported Atomic module is inert source and remains `UNLICENSED` under its
  nested private notice. Installing it into an Atomic host would execute extension
  code with that host process's authority; review and pin it before doing so.
- Wesley authorized public repository visibility on 2026-08-11. That visibility
  does not extend the root MIT grant to the nested all-rights-reserved module.
- SQLite remains the default. PostgreSQL must be selected explicitly and never
  receives an automatic copy of SQLite demo data.

## PostgreSQL and retained command data

- Use parameterized SQL and do not log `DATABASE_URL` or database error objects
  that may embed credentials.
- Use separate least-privilege migration and runtime roles outside a disposable
  local environment; require TLS according to the deployment boundary.
- Back up before forward-only migrations. A checksum mismatch or unavailable
  database must fail startup rather than fall back to SQLite.
- Idempotency and outbox records may retain objectives, event summaries, exact
  approval effects, and identifiers. Apply access controls and retention before
  production use.
- The current outbox is durable local state, not a configured external publisher.
  Future consumers must deduplicate stable outbox IDs and redact payloads from
  logs.
- Demo reset and automatic demo seeding are hard-disabled for PostgreSQL.

## Before enabling real agents

1. Run each writing task in a devcontainer, container, VM, or remote sandbox.
2. Mount only the selected repository/worktree; mount unrelated material read-only or not at all.
3. Inject short-lived, least-privilege credentials at run start.
4. Use an explicit outbound-network policy and log high-risk egress.
5. Scan artifacts and proposed memories for secrets before storage or display.
6. Authenticate Hermes mutations and bind approvals to the exact action, project, run, evidence, and expiry.
7. Add lease heartbeats, orphan quarantine, cancellation reconciliation, and a global kill switch.
8. Verify Linear and GitHub webhook signatures and replay windows.
9. Pin and review agent skills, extensions, MCP servers, and runtime versions.
10. Keep protected-branch merge, production deployment, destructive data changes, secret expansion, and canonical-memory promotion behind human approval.

## Runtime environment allow-list

The Atomic RPC scaffold inherits only basic OS variables such as `PATH`, `HOME`, locale, terminal, and temporary-directory settings. To expose an additional variable to the child process, list its **name** in `ATOMIC_RUNTIME_ENV_ALLOWLIST`.

Example for a disposable pilot worker:

```bash
ATOMIC_RUNTIME_ENV_ALLOWLIST=OPENROUTER_API_KEY,HTTPS_PROXY \
OPENROUTER_API_KEY=... \
npm start
```

Do not expose broad cloud credentials or a developer's complete shell environment.

## Reporting a security issue

Do not place credentials or confidential exploit details in a public issue. Share a minimal reproduction through a private channel with the repository owner.
