# Milestone 7 connector setup and operations

Milestone 7 is implemented but every live connector remains disabled by default.
Normal installation and `npm run verify` require no Linear or GitHub credential
and perform no external write.

## What you need for each level

| Level | Required inputs | External effect |
|---|---|---|
| Deterministic verification | none | none |
| Local Git authority | accepted connector-policy file and digest | local read-only Git inspection |
| Linear authority read | dedicated Linear key or OAuth token plus exact team/project IDs | bounded project/issue reads |
| Linear issue/comment | Linear write-capable token, fixed team/project/evidence issue, operator ID | one idempotent issue or concise evidence comment after its own plan, approval, and adjacent policy/revision checks |
| GitHub ref read | repository-scoped GitHub token and fixed owner/repo/base/head | bounded ref reads |
| GitHub draft PR | pull-request write token, pre-existing remote head, operator ID, evidence-bound approval | draft PR only |

The existing Linear gateway configured inside Hermes is not reused. Hermes is an
interface; the control plane needs a separately scoped credential so the exact
authority revision can be recorded and rechecked outside conversational state.

The wire contracts follow Linear's official
[GraphQL authentication/error guidance](https://linear.app/developers/graphql)
and [OAuth scope guidance](https://linear.app/developers/oauth-2-0-authentication),
plus GitHub's official
[pull-request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10)
and [Git-reference](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10)
REST contracts.

## 1. Review the policy

Copy [`config/m7-connectors.example.json`](../config/m7-connectors.example.json)
to a private absolute path outside the repository. Replace every placeholder:

- `projectId` is Valkyrie's local project ID;
- Linear `teamId`, `projectId`, and `evidenceIssueId` are fixed provider IDs;
- `repositoryPath` is one reviewed absolute local Git checkout;
- Git and GitHub `baseRef` and `headRef` must match exactly;
- the head must already exist remotely before draft-PR preparation;
- checks contain reviewed absolute executables and fixed argv only.

The API and MCP surfaces cannot override any of those targets. Compute the exact
accepted digest after review:

```bash
shasum -a 256 /absolute/private/accepted-m7-connectors.json
```

Any later byte change requires a new review and digest.

## 2. Create private credential files

Create each token using a password manager or private editor so it does not enter
shell history. Each path must be absolute, a regular non-symlink file, and mode
`0600` on POSIX:

```bash
chmod 600 /absolute/private/control-plane.token
chmod 600 /absolute/private/linear.token
chmod 600 /absolute/private/github.token
```

Use only the files needed for the selected mode:

- `CONTROL_PLANE_AUTH_TOKEN_FILE`: a random 32–4096 byte local bearer;
- `LINEAR_TOKEN_FILE`: a dedicated Linear personal key or OAuth bearer;
- `GITHUB_TOKEN_FILE`: a repository-scoped GitHub App installation or
  fine-grained token.

Do not mount these files into Hermes, Atomic, Codex, Claude Code, a writer
container, or a repository. The host connector reads them at startup.

## 3. First live exercise: read only

Start with SQLite or an independently prepared PostgreSQL database. Demo reset
must be disabled whenever a connector policy is loaded.

```bash
export CONTROL_PLANE_AUTH_TOKEN_FILE=/absolute/private/control-plane.token
export ENABLE_DEMO_RESET=false
export M7_CONNECTOR_POLICY_FILE=/absolute/private/accepted-m7-connectors.json
export M7_CONNECTOR_POLICY_SHA256=<accepted-lowercase-sha256>
export LINEAR_CONNECTOR_MODE=read-only
export LINEAR_AUTH_MODE=personal-api-key
export LINEAR_TOKEN_FILE=/absolute/private/linear.token
export GITHUB_CONNECTOR_MODE=disabled
npm start
```

For an OAuth bearer, use `LINEAR_AUTH_MODE=oauth-bearer`. In another terminal:

```bash
export CONTROL_PLANE_API=http://127.0.0.1:8787
export CONTROL_PLANE_AUTH_TOKEN_FILE=/absolute/private/control-plane.token
export M7_LIVE_READ_PROJECT_ID=<local-project-id>
export M7_LIVE_READ_TASK_ID=<optional-local-task-id>
npm run smoke:m7-read
```

The smoke creates one local routing assessment. It reads current Linear/Git
authority, launches no runtime, and performs no Linear/GitHub write.

## 4. Inspect operations

Authenticated status is available at `GET /api/connectors/status`. Dead letters
are listed at `GET /api/connectors/outbox/dead`. Exact replay is an operator-only
POST and preserves the stable outbox action ID.

External action preparation always creates a local `pending_approval` plan first.
The plan binds project, run/workflow, governed evidence, the accepted connector-
policy digest, exact effect, expiry, provider target, and revision. Approval creates a durable
authorized delivery; the background worker revalidates evidence and authority
immediately before the provider call.

Local idea/task intake does not project automatically. To create a Linear issue,
prepare `POST /api/external-actions/linear-issue` (or the bounded MCP equivalent),
inspect the generated effect, and resolve that exact plan. The caller cannot
provide a Linear team/project target.

An interrupted write becomes `ambiguous` and is never blindly retried. The
operator-only HTTP reconciliation route accepts only zero/one/multiple match
evidence and provider identity hashes; it accepts no URL, repository, ref, issue,
command, credential, or arbitrary payload. Reconciliation is intentionally not a
Hermes MCP tool.

## 5. Enable writes only after the read record is reviewed

Linear write mode:

```bash
export CONTROL_PLANE_OPERATOR_ID=wesley-local-operator
export LINEAR_CONNECTOR_MODE=read-write
```

GitHub draft-PR mode:

```bash
export CONTROL_PLANE_OPERATOR_ID=wesley-local-operator
export GITHUB_CONNECTOR_MODE=draft-pr
export GITHUB_TOKEN_FILE=/absolute/private/github.token
```

The GitHub token should have repository metadata read, contents read, and pull
requests read/write only. Contents write, merge, Actions, Workflows, Deployments,
Administration, and Secrets are outside the boundary. Branch publication is not
implemented; the configured head must already exist and match the approved OID.

The Linear token must be scoped only to the configured team/project operations.
This implementation uses ordinary GraphQL project/issue/comment operations and
does not depend on preview AgentSession APIs.

## Failure and rollback

Migrations 012 and 013 are checksummed and forward-only. A code-only downgrade
must fail closed on their unknown ledger. Rollback requires a verified pre-v12 or
pre-v13 backup, as applicable, or a separate compatible SQLite dataset.

Disabling a connector prevents new external claims but retains pending,
delivered, ambiguous, and dead-letter evidence. A provider object already
created cannot be transactionally undone. Keep the draft PR/Linear object under
operator control, reconcile by its stable marker, and never delete evidence to
make a retry appear clean.

## Current limitations

- A team-scoped, read-only Linear credential and the Ovalo project were
  exercised successfully on 13 August 2026. The private credential and accepted
  policy remain ignored local state; GitHub and every connector write mode remain
  disabled and unexercised.
- Static bearer auth identifies one configured operator context; it is not
  multi-user actor attestation.
- General Direct/Atomic Lite/Atomic Full launch remains fail-closed even when an
  assessment has live authority. Registering a general project launcher is a
  separate reviewed change.
- OpenViking is an evaluation-only read provider candidate. Local accepted
  Markdown remains the active Project Brain authority; automatic capture and
  canonical promotion remain disabled/separate.
