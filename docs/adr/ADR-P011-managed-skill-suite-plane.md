# ADR-P011 — Managed skill-suite capability plane

Status: proposed

## Context

Valkyrie's Hermes, Atomic, Codex, and Claude Code paths currently carry separate
tool and instruction configuration. Installing a suite independently into each
host creates drift, while stripping its tools per runtime can make the managed
experience worse than a normal native installation. Giving every interface the
same ambient authority would instead expose shell, browser, credentials, and
final actions to components that must not hold them.

## Proposal

1. Treat a skill suite as one operator-approved, versioned product with many
   discovered skills.
2. Preserve exact upstream source bytes in a private content-addressed store.
3. Make one digest-pinned policy describe projects, runtime modes, telemetry,
   update posture, and a suite-level trust profile.
4. Derive individual skill requirements automatically from bounded definitions;
   Wesley does not manually map every skill.
5. Preserve native execution on supported hosts. Codex and Claude Code receive
   native projections; Atomic delegates to an eligible specialist; Hermes can
   request and observe but never gains raw runtime tools.
6. Bind every future run to an immutable capability pack containing suite, skill,
   runtime, project, digest, and effective-capability evidence.
7. Ordinary development activity may proceed within an owned sandbox under the
   trusted-development profile. Credentials and external final effects remain
   control-plane actions even when a skill prepares them.
8. Installation and activation remain local operator operations. Models and MCP
   callers cannot add, update, activate, or roll back a suite.
9. The accepted manifest dialect is `skill-frontmatter-v1`, parsed as strict
   YAML 1.2 by pinned `yaml@2.9.0`. Only top-level `tools` or `allowed-tools`
   declarations are authority-bearing, and using both is ambiguous.
10. Missing, malformed, duplicate, conflicting, nested, empty, or unknown
    authority stays operator-gated. Executables, setup/install files, dependency
    manifests and lifecycle hooks, MCP definitions, and static prose/name risk
    scanning may add authority requirements but may never prove safety.
11. When upstream metadata cannot express a reviewed capability, only the exact
    digest-bound suite policy may supply a per-skill capability override. An
    override cannot erase malformed metadata, an unknown tool, or detected risk
    that it does not explicitly cover.

## Consequences

- The user experience is suite-level: install once, inspect automatically, route
  to a compatible runtime, and ask only when authority materially expands.
- Upstream routers may remain intact when a reviewed native projection is proven.
- A suite requiring an unsupported broker is reported honestly rather than run in
  a silently weakened form.
- Installed source is not yet executable merely because the catalog accepts it.
- Web/browser and GBrain capabilities can be added later through the same catalog
  without changing Hermes into a privileged host.

## M8a acceptance boundary

The first slice implements deterministic local admission, fail-closed YAML
authority parsing and source-risk inspection, catalog generations, compatibility
classification, rollback, status, and capability-pack attestation.
It intentionally does not fetch the internet, run third-party setup code, install
dependencies, alter global Codex/Claude/Hermes state, or compose a general writer.

Wesley's 2026-08-13 instruction accepts the product direction—suite-level seamless
management rather than manual per-skill administration—but this ADR remains
proposed until the exact native projection, update, and broker behavior is reviewed
with a real suite such as GStack.
