# Atomic Installation and Operations

This guide is the minimum setup path. The skill/package is designed so Wesley should not need to learn Atomic's workflow syntax for normal use.

## Recommended pilot topology

```text
Wesley mobile
  ↓
Hermes on VPS
  ↓ authenticated control-plane MCP
Control plane + PostgreSQL
  ↓
Disposable/isolated runner or remote VM
  ├─ pinned Atomic
  ├─ this package
  ├─ project worktree
  └─ access to durable Postgres when resume is required
```

## Install Atomic

The package research used Atomic 0.9.12-era sources, but this repository has not
validated a live compatible host set. Treat 0.9.12 as the first disposable
contract-test candidate, not as a production-approved version:

```bash
npm install -g @bastani/atomic@0.9.12
atomic --version
```

Do not continue to installation unless that exact published package, the required
peer set, JSONL/SDK boundary, and advertised capabilities pass the disposable
contract suite. Atomic also supports pnpm/Bun or platform release archives; every
selected distribution/version requires the same validation.

## Authenticate

Inside Atomic, use `/login` for supported subscription providers, or supply scoped API credentials through the runner's secret broker/environment. Do not write keys into package files, Project Brain notes, prompts, or logs.

For production runners, prefer short-lived/scoped credentials and explicitly control which provider may receive context. Atomic compaction may borrow a configured fallback model for line ranking.

## Install this package

```bash
cd /absolute/path/to/valkyrie-agent/packages/atomic-workflow-architect
npm run verify:all
atomic install -l "$PWD"
```

One-session test:

```bash
atomic -e "$PWD"
```

## Confirm resources

```text
/workflow list
/atomic-routing status
/atomic-routing test Build a feature that adds a project dashboard
/skill:atomic-workflow-architect Evaluate an idea for Ovalo. Do not implement.
```

Expected workflows:

```text
idea-to-decision
project-blueprint
request-preflight
```

## Durable workflows

For cross-process resume, configure/verify Atomic's DBOS/PostgreSQL backend. An external database can be supplied with:

```bash
export DBOS_SYSTEM_DATABASE_URL='postgresql://...'
```

Store the value in the runner's secret manager; the line above is illustrative. If Atomic reports an in-memory/non-durable fallback, do not promise recovery after process exit.

## Remote operation

A remote VM/Mac mini plus SSH is useful for long tasks. Herder or tmux can make terminal reattachment easier, but neither replaces:

- Atomic workflow durability;
- control-plane run reconciliation;
- sandboxing;
- authenticated mobile control.

Hermes should remain the normal interface. Open a terminal/operator console only for deep troubleshooting.

## Sandbox checklist

Before real writing:

- isolated container/VM/micro-VM/policy sandbox;
- project worktree and one writer lease;
- no production secrets by default;
- scoped network/tool access;
- resource/cost/time/child limits;
- package/workflow version pinning;
- artifact/log secret scanning;
- approval path for PR/merge/deploy/destructive actions.

## First pilot

Use one medium-risk Ovalo issue with deterministic checks and a reviewable output. Avoid both a trivial documentation edit and a production migration.

Compare:

1. Atomic selected workflow path;
2. direct Codex or Claude Code path with equivalent checks/reviewer.

Measure contract adherence, defect catch rate, evidence completeness, review burden, time, cost, repair loops, and recovery.
