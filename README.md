# Wesley Agent Control Plane — Prototype v0.2.2

A runnable, zero-dependency prototype for the architecture decision:

- **Hermes is the mobile interface.**
- **Linear is the roadmap source of truth.**
- **Git/GitHub is the source-code and delivery truth.**
- **A Git-backed Obsidian vault is canonical project knowledge.**
- **A machine-memory backend is a replaceable retrieval layer; the prototype starts read-only.**
- **Atomic is evaluated as the default verifiable coding runtime, with direct Codex/Claude paths retained.**
- **The custom software is a thin control plane, not another general agent framework.**

The prototype is deliberately safe and easy to run: it uses Node 22 built-ins, including `node:sqlite`, and mock agent runtimes. It demonstrates the contracts, state ownership, mobile-facing operations, approvals, evidence, memory proposals, and Hermes MCP surface without requiring external credentials.

## Run it

Requirements: Node.js 22.16 or newer.

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787
```

Run tests:

```bash
npm test
```

Reset demo data:

```bash
npm run reset
```

## Hermes MCP server

Start the control plane in one terminal, then start the local stdio MCP bridge in another:

```bash
./bin/project-os-mcp
```

Use the wrapper or invoke Node directly. Avoid plain `npm run mcp` in an MCP client configuration because npm may print a banner to stdout, which would corrupt the JSON-RPC stream. `npm run --silent mcp` is also safe.

Register that command as a local stdio MCP server in Hermes. The server exposes:

- `projects_list`
- `project_get_brief`
- `idea_capture`
- `runs_start`
- `runs_list`
- `run_get`
- `run_steer`
- `run_compare`
- `run_cancel`
- `approvals_list`
- `approval_resolve`
- `memory_search`
- `memory_propose`
- `memory_promote`
- `memory_reject`

See `docs/HERMES_MCP_SETUP.md`.

## What is real in this prototype

- A responsive portfolio and operations console.
- Stable project, task, run, approval, event, artifact, workspace, and memory-proposal records.
- An Atomic/Codex/Claude comparison operation with a shared comparison ID and one isolated workspace per candidate.
- Runtime steering when the selected adapter advertises that capability.
- Explicit runtime routing policy.
- One root runtime per run.
- One writer lease per workspace.
- Event-normalized run timelines and SSE streaming.
- Human approval before mock PR preparation.
- Artifact-backed evidence and run summaries.
- Read-only search over a Git/Obsidian-style project brain.
- Human-gated promotion of memory proposals into accepted Markdown.
- A minimal MCP stdio server for Hermes.
- A production-oriented PostgreSQL schema and migration guide.
- An Atomic JSONL RPC client scaffold for the real integration.

## What remains simulated or intentionally deferred

- Linear writes are represented by local task projections. Connect the official Linear MCP/API in the next phase.
- Atomic, Codex, Claude Code, and Prime are mock runtimes by default.
- The local project-brain search is a stand-in for the first read-only OpenViking evaluation.
- Workspaces are simulated directories unless a local Git repository is configured.
- The prototype uses SQLite for a zero-dependency download; production remains PostgreSQL.
- There is no production deployment, merge, secret access, or destructive action.

## Continue with Codex or Claude Code

Start with:

- `docs/Agentic_Development_Control_Plane_Architecture_Review_v0.2.2.docx` for the consolidated decisions and reasoning
- `AGENTS.md`
- `docs/CONTINUATION_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/PROMPT_FOR_CODEX_OR_CLAUDE.md`
- `docs/GIT_HANDOFF.md` for cloning the included Git bundle

The first recommended engineering task is to implement the PostgreSQL store behind the existing storage interface, without changing domain contracts or API behavior.

Codex or Claude Code should open the extracted project root, read `START_HERE.md`, `AGENTS.md`, `CLAUDE.md`, and `docs/PROMPT_FOR_CODEX_OR_CLAUDE.md`, then run `npm run verify` before changing code.

## Verification performed for this package

- `npm test`: 10 passing tests.
- `npm run smoke:http`: starts a temporary clean control plane and exercises the comparison, approval, evidence, and memory-promotion lifecycle.
- `npm run smoke:mcp`: starts a temporary clean control plane and exercises the local Hermes MCP bridge.
- HTTP health, portfolio, A/B comparison, approvals, completion, artifacts, and memory-proposal flow exercised end to end.
- MCP `initialize`, `tools/list`, `projects_list`, and `memory_search` exercised through the direct stdio command.
- Atomic JSONL decoder tested to split on LF only, preserving U+2028 and U+2029 inside JSON strings.

The Atomic RPC scaffold also uses an explicit child-environment allow-list; see `SECURITY.md`.

See `docs/VERIFICATION.md`.
