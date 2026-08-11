# Verification record

Package version: 0.2.2

## Automated tests

Command:

```bash
npm test
```

Result: 10 tests passed.

Coverage includes:

- non-trivial engineering routing to Atomic;
- research routing to Prime;
- explicit runtime selection;
- budget ceilings;
- full mock Atomic lifecycle through approval, evidence, completion, lease release, and governed memory proposal;
- duplicate idea detection;
- comparison launch with three distinct workspaces and a shared comparison ID;
- steering retained as a normalized event;
- strict LF-only Atomic JSONL decoding that preserves U+2028/U+2029 inside JSON strings;
- Atomic child-process environment allow-listing so unrelated secrets are not inherited.

## HTTP smoke test

The server was started from a clean data directory and the following paths were exercised:

- `GET /health`
- `GET /api/portfolio`
- `POST /api/runs/compare`
- `GET /api/approvals`
- `POST /api/approvals/:id/resolve`
- `GET /api/runs`
- `GET /api/memory/proposals`
- `POST /api/memory/proposals/:id/resolve`
- `GET /api/runs/:id`

The comparison launched Atomic, Codex, and Claude mock candidates, created three distinct leases, paused each at an approval gate, resumed after approval, completed all runs, released all leases, stored artifacts, created three unpromoted memory proposals, promoted one proposal through the explicit review endpoint, and verified the accepted Markdown target.

## MCP smoke test

`npm run smoke:mcp` starts a temporary clean server and tests:

- `initialize`
- `tools/list`
- `tools/call` with `projects_list`
- `tools/call` with `memory_search`

The JSON-RPC stream was clean when Node or `bin/project-os-mcp` was invoked directly.

## Not verified as real integrations

- real Linear MCP/GraphQL writes;
- real Atomic workflow completion and approval mapping;
- real Codex or Claude Code session adapters;
- OpenViking HTTP/MCP retrieval;
- Docker or micro-VM sandbox enforcement;
- GitHub PR creation.

Those remain explicit continuation tasks rather than implied capabilities.

## Static and handoff checks

- `tsc --noEmit` completed successfully with TypeScript 5.8.3.
- The architecture review DOCX was rendered to 23 page images and every page was visually inspected for clipping, overlap, broken tables, and pagination defects.
- A complete Git bundle was created, verified with `git bundle verify`, cloned into a clean temporary directory, and the cloned repository passed `npm run verify`.
