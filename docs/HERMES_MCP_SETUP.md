# Hermes MCP setup

This guide connects a dedicated Hermes CLI profile to the authenticated local
Valkyrie pilot. It tests Hermes → stdio MCP → loopback HTTP → control plane. It
does not expose a phone-facing network service.

## Prerequisites

From the repository root:

```bash
npm ci
npm run setup:atomic
npm run setup:pilot
./bin/project-os-pilot-server
```

Keep that server terminal open. The pilot token is an ignored `0600` file at
`data/auth/control-plane.token`. The server and MCP bridge read the same file;
neither prints it.

## Create the isolated Hermes profile

In another terminal:

```bash
npm run setup:hermes
```

The script creates `valkyrieeval` as an empty profile using `--no-skills` and
without `--clone`/`--clone-from`. It then:

- disables Hermes built-in CLI toolsets, built-in memory, and user-profile memory;
- registers `valkyrie_project_os` with the clean stdio wrapper
  `bin/project-os-pilot-mcp`;
- supplies only the local API URL and token-file path to that child;
- records a local isolation marker under ignored `data/runtime/hermes/`.

This prevents the first Project Brain test from inheriting another profile's MCP
servers, settings, skills, or `.env` secrets. If `valkyrieeval` already exists but
has no marker, setup refuses to assume it is isolated. Audit it or recreate it:

```bash
hermes -p valkyrieeval mcp list
hermes profile delete valkyrieeval
npm run setup:hermes
```

For a different lowercase alphanumeric name, set
`VALKYRIE_HERMES_PROFILE` consistently when running setup and later commands.

## Verify MCP independently of model login

```bash
hermes -p valkyrieeval mcp test valkyrie_project_os
```

This should initialize the stdio server and discover the restricted pilot tools.
It proves MCP connectivity and bearer authentication without spending model
tokens.

The wrapper exposes these 18 tools:

- `projects_list`
- `project_get_brief`
- `runtimes_status`
- `skill_suites_status`
- `engineering_assess`
- `engineering_assessment_get`
- `runs_start`
- `runs_list`
- `run_get`
- `atomic_fixture_artifact_read`
- `atomic_model_fixture_artifact_read`
- `run_cancel`
- `atomic_fixture_approval_resolve`
- `atomic_model_fixture_approval_resolve`
- `memory_search`
- `memory_propose`
- `memory_preview`
- `memory_reject`

It intentionally excludes idea creation, comparisons, runtime steering, general
approval resolution, general execution launch, demo reset, and `memory_promote`.
`skill_suites_status` is read-only: it reports admitted immutable generations,
runtime modes, and gated capabilities. Hermes cannot install, update, activate,
roll back, execute setup code, or receive a source filesystem path through it.
The two engineering tools persist/read an explainable route only; they cannot
start a writer or substitute a fixed pilot. The narrow
`atomic_fixture_approval_resolve` tool can resolve only the evidence-bound,
cleaned disposable Atomic fixture gate; it cannot approve another action.
`atomic_fixture_artifact_read` returns at most 256 KiB of UTF-8 evidence whose
bytes still match the pending gate's recorded checksum; it never returns a host
path, including in an error. The two `atomic_model_fixture_*` tools apply the
same restrictions to the default-off fixed model pilot: they expose no provider,
credential, network, repository, command, or generic approval selection. Setting
`CONTROL_PLANE_MCP_TOOL_ALLOWLIST` replaces this default with another validated
subset; an unknown tool name fails MCP startup.

`memory_preview` returns a review object valid for at most 15 minutes (with 30
seconds of future clock-skew tolerance). Although this pilot profile cannot
promote, any future authorized caller must regenerate and re-review an expired
preview rather than changing its timestamp.

## Who chooses Direct, Atomic Lite, or Atomic Full

Hermes should not silently make the authoritative runtime decision. For general
engineering assessment it should:

1. preserve Wesley's literal request and final-action instruction;
2. resolve or supply the current project/task identity;
3. state an optional preference such as low latency, Direct, Atomic Lite, or
   Atomic Full;
4. call `engineering_assess` and retain its assessment ID;
5. explain the selected shape, score, hard signals, source freshness, and any
   preference that policy overrode; and
6. stop when `executionSupported=false` rather than mapping the request onto a
   fixed `runs_start` workflow.

The control plane scores Structure, Verifiability, Iteration, Risk, Duration, and
Isolation. Direct is the 0–3 default, Atomic Lite is the 4–6 default, and Atomic
Full is selected at 7+ or for an explicit loop, high risk, durable/background
work, multiple candidates, or an evidence/approval gate. A user preference may
increase rigor; `direct:` cannot waive a required safety or final-action gate.

The assessment tools require configured bearer authentication even on loopback.
Without M7 configuration they record `prototype` Linear and `unavailable` Git
provenance. With an accepted M7 policy plus the control plane's own
least-privilege read connectors, they bind bounded current source revisions.
Either way the launch result remains unsupported: `runs_start` still accepts only
the listed fixed connectivity/M5/M6 workflows, so Hermes must not translate an
arbitrary request into one of those fixtures.

## Optional M7 operator tools

The default 18-tool pilot allowlist above intentionally omits production-
connector mutations. After reviewing
[`docs/M7_CONNECTOR_SETUP.md`](M7_CONNECTOR_SETUP.md), an operator may replace
`CONTROL_PLANE_MCP_TOOL_ALLOWLIST` with an exact subset of these M7 tools:

- `connectors_status`
- `connector_dead_letters_list`
- `connector_dead_letter_replay`
- `external_action_github_draft_pr_prepare`
- `external_action_linear_evidence_comment_prepare`
- `external_action_linear_issue_prepare`
- `external_action_plans_list`
- `external_action_plan_get`
- `external_action_plan_resolve`

These are nine optional M7 tools. Preparation creates a local pending plan, not a provider effect. Resolution
authorizes only the exact evidence/policy/expiry-bound plan. The service rechecks
the accepted connector-policy digest and exact policy-owned target immediately
before the write. Ordinary `task.created` events never call Linear.
Ambiguous-effect reconciliation is
HTTP-only and is never an MCP tool. This static local bearer does not attest that
a particular person was present; do not expose these tools through a shared or
remote Hermes deployment without per-actor authorization.

## Configure Hermes inference in the isolated profile

Authentication/model selection must happen inside `valkyrieeval`; credentials in
the default profile were intentionally not copied.

```bash
hermes -p valkyrieeval setup model
```

Then explicitly start Hermes with only the Valkyrie MCP toolset:

```bash
hermes -p valkyrieeval chat -t valkyrie_project_os
```

The release host successfully used Hermes `0.19.0` with
`gpt-5.6-sol`/`openai-codex` to call `runtimes_status` and `memory_search`. An
earlier `gpt-5.3-codex` attempt received HTTP 400 before a model response because
that model is unsupported on the ChatGPT-account Codex endpoint. Use Hermes's
model picker and select a model your configured provider actually supports.

Suggested test sequence:

```text
Use runtimes_status and tell me exactly which integrations are available. Do not claim unavailable runtimes work.

Search Ovalo memory for the accepted terminology preload decision and cite the Project Brain source returned by the tool.

Propose this advisory memory: "The isolated Hermes-to-Valkyrie MCP connectivity test passed." Preview its exact canonical target and content, but do not promote it. Then reject the proposal.

Start an Ovalo Codex run with workflow runtime-connectivity, maximum cost USD 1, and objective "Return exactly VALKYRIE_HERMES_CODEX_OK and nothing else." Use a stable idempotency key, wait for a terminal state, and summarize the raw-event and artifact evidence.
```

For an Atomic test, request the same `runtime-connectivity` workflow with runtime
`atomic`. A successful Atomic result proves only credential-free offline JSONL
RPC/package discovery. Atomic does not call a model in this milestone.

Claude appears unavailable unless the server was started with an
`ANTHROPIC_API_KEY` whose variable name was explicitly included in
`CLAUDE_RUNTIME_ENV_ALLOWLIST`. Claude OAuth/keychain state is not accepted by the
`--bare` pilot adapter.

## Why `runtime-connectivity` is required

Every native start in this milestone must explicitly use
`workflow: "runtime-connectivity"`. The control plane rejects a native start
without that literal workflow. This prevents a normal-looking request from being
mistaken for an implemented writer or end-to-end delivery workflow.

The direct Codex/Claude calls are read-only and end at `analysis_only`. The Atomic
call is offline discovery only. No native adapter advertises steering, pause,
resume, or approval mapping here.

## Loopback and mobile limits

The control plane defaults to `127.0.0.1`. Loopback means “this device”: Hermes on
the same Mac can reach the service through its local stdio MCP child. A phone's
`127.0.0.1` points to the phone, not the Mac.

Do not solve this by binding the prototype to `0.0.0.0`. Non-loopback startup
requires a bearer token, but PR #1 still lacks the mobile channel identity,
transport hardening, TLS/reverse-proxy policy, and per-user authorization needed
for safe remote exposure. A future Hermes gateway can call this control plane only
after those boundaries are implemented.

## Manual MCP configuration

`npm run setup:hermes` is preferred. The equivalent stdio command is:

```text
/absolute/path/to/valkyrie-agent/bin/project-os-pilot-mcp
```

The child needs:

```text
CONTROL_PLANE_API=http://127.0.0.1:8787
CONTROL_PLANE_AUTH_TOKEN_FILE=/absolute/path/to/valkyrie-agent/data/auth/control-plane.token
```

Use the wrapper instead of plain `npm run mcp`: npm can print a banner to stdout
and corrupt strict JSON-RPC framing. Protocol records go to stdout; diagnostics go
to stderr.

## Troubleshooting

- `Unauthorized`: server and MCP are reading different token files, or both
  inline-token and token-file variables are set. Run `npm run setup:pilot` and use
  the wrappers.
- `Profile ... does not exist`: run `npm run setup:hermes`.
- Existing profile isolation error: audit/delete the old evaluation profile as
  shown above. Do not clone the default profile for this test.
- MCP test cannot connect: confirm `curl -fsS http://127.0.0.1:8787/health`, then
  confirm the pilot server terminal is still running.
- Native start rejects the workflow: make the Hermes request include literal
  `runtime-connectivity`.
- Codex unavailable: verify the pinned version and `codex login status` in a local
  terminal.
- Hermes model returns HTTP 400 before calling MCP: choose a model supported by
  the configured Hermes provider; the release host succeeded with
  `gpt-5.6-sol`/`openai-codex`.
- Claude unavailable: use a dedicated API key and the explicit server-side
  allow-list; logging into the Claude CLI interactively is intentionally
  insufficient.
- Project Brain answer differs from Hermes memory: built-in Hermes memory should
  be disabled in this profile; accepted Project Brain Markdown is authoritative,
  while chat/session memory is advisory.
