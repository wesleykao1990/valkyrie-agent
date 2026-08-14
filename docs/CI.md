# CI runbook

GitHub Actions runs `CI` for every pull request and push to `main` with only
`contents: read`. Superseded runs for the same PR/ref are cancelled. Third-party
Actions are pinned to exact reviewed commit SHAs, checkout does not persist Git
credentials, dependency caching is disabled, and `npm ci --ignore-scripts` never
runs package lifecycle code. Gitleaks is pinned to 8.30.1; PR comments and leak
artifact uploads are disabled so the job needs no write permission.

The deterministic job pins Node `22.16.0`, uses PostgreSQL 16 tools already on
the pinned Ubuntu 24.04 runner, and runs strict TypeScript, the general suite,
the disposable PostgreSQL contracts, Atomic package verification, HTTP smoke,
and MCP smoke as separate visible steps. A separate Gitleaks job scans committed
history. No repository secret is required for this personal repository.

CI explicitly disables Atomic/Codex/Claude model pilots, Docker writer pilots,
Linear, GitHub, and every external action. It does not exercise OpenViking,
GBrain, subscriptions, provider credentials, branch publication, PR creation,
merge, deployment, canonical promotion, or other live writes. A CI pass is
deterministic contract evidence, not live-provider evidence.

## Reproduce locally

Install Node 22.16 or a compatible supported 22.x and PostgreSQL 16 `initdb` /
`pg_ctl`, then run:

```bash
npm ci --ignore-scripts
npm run verify
```

The general phase intentionally reports three opt-in skips (PostgreSQL storage,
PostgreSQL model lifecycle, and live Docker sandbox); the following dedicated
PostgreSQL phase must run both PostgreSQL suites with no skips. A missing local
listener permission or PostgreSQL tool is an environment failure, not an
application pass.

## Branch protection recommendation

After the workflow has completed once, protect `main` and require the two exact
checks:

- `deterministic verification (Node 22 / PostgreSQL 16)`
- `secret scan`

Also require the branch to be current before merge, at least one approving fresh
review, dismissal of stale approvals, resolution of review conversations, and no
force pushes or branch deletion. Do not grant Actions write permissions or add
provider/connector secrets to make this workflow pass.
