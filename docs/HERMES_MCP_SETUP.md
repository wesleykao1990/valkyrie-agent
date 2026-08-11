# Hermes MCP setup

The prototype includes a minimal local stdio MCP server at:

```text
apps/mcp-server/src/index.ts
```

## Start the services

1. Start the HTTP control plane:

```bash
./bin/project-os-server
```

2. Register this executable as the local stdio MCP command in Hermes:

```text
/absolute/path/to/valkyrie-agent/bin/project-os-mcp
```

The wrapper changes into the repository directory and launches Node directly, keeping stdout clean for JSON-RPC. A direct equivalent is:

```bash
node --experimental-strip-types /absolute/path/to/apps/mcp-server/src/index.ts
```

Do not configure plain `npm run mcp` as the stdio command unless you add `--silent`; npm may emit a script banner on stdout and corrupt the protocol stream.

3. Set the API URL when the control plane is not local:

```bash
export CONTROL_PLANE_API=https://your-private-control-plane.example
```

The server implements MCP `initialize`, `tools/list`, `tools/call`, and `ping`. Protocol output goes to stdout and diagnostics go to stderr.

## Exposed tools

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

## Recommended Hermes permissions

Allow:

- read project brief and portfolio;
- create an idea;
- start a bounded run or comparison;
- inspect, steer, or cancel a run when supported;
- list and resolve an explicit approval;
- search project memory;
- propose reviewed knowledge.

`runs_start` callers should supply a stable `idempotencyKey` for every mobile
retry. Use the same key only for the same logical request.

Do not expose:

- raw process execution;
- container management;
- direct secret retrieval;
- unrestricted filesystem mutation;
- protected-branch merge;
- production deployment.
- canonical-memory promotion unless Wesley is shown the exact target/evidence and
  explicitly approves that final action.

Although the prototype server advertises `memory_promote` for contract continuity,
omit it from the Hermes allow-list until authentication and exact-action approval
binding exist.

The production bridge must authenticate the Hermes identity and source channel, issue exact mutation previews, and attach idempotency keys to every write.
