# Copy-paste continuation prompt

You are continuing the Wesley Agent Control Plane prototype.

Read, in order:

1. `AGENTS.md`
2. `docs/DECISIONS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/CONTINUATION_PLAN.md`
5. `docs/PROTOTYPE_SCOPE.md`

First run `npm test` and start the demo with `npm start`. Do not change authority boundaries or public contracts without proposing an ADR.

Your first task is:

> Implement a PostgreSQL storage adapter behind the existing store contract. Preserve current HTTP and MCP behavior, add migrations and transaction-safe outbox writes, and make the existing lifecycle tests runnable against both SQLite and PostgreSQL. Do not add Redis or a new workflow engine. Keep SQLite as the zero-dependency demo adapter. Document setup and failure recovery.

Before coding, produce a short plan covering schema mapping, transactions, migrations, test strategy, and rollback. Then implement in small reviewable steps, run tests, and summarize remaining risks.
