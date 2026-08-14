import test from "node:test";
import assert from "node:assert/strict";
import { ProductionConnectorRegistry } from "../apps/control-plane/src/production-connectors.ts";

test("production connector registry is inert without an accepted policy or credentials", () => {
  const registry = new ProductionConnectorRegistry({
    linear: { mode: "disabled", authMode: "personal-api-key" },
    github: { mode: "disabled" },
  }, {} as never);
  assert.deepEqual(registry.status(), {
    enabled: false,
    policyDigest: null,
    linear: { mode: "disabled", configuredProjects: [], credentialLoaded: false },
    github: { mode: "disabled", configuredProjects: [], credentialLoaded: false },
    git: { configuredProjects: [] },
    externalEffects: {
      linearIssueCreation: false,
      linearEvidenceComment: false,
      githubDraftPr: false,
      branchPublication: false,
      merge: false,
      deployment: false,
    },
  });
  assert.equal(registry.linearForProject("missing"), undefined);
  assert.equal(registry.gitForProject("missing"), undefined);
  assert.equal(registry.githubReadForProject("missing"), undefined);
  assert.equal("dispatcher" in registry, false, "ordinary task.created events must have no provider-write dispatcher");
});

test("read-write Linear mode still has no automatic task.created provider consumer", () => {
  const registry = new ProductionConnectorRegistry({
    policy: {
      schemaVersion: "1.0.0",
      digest: "a".repeat(64),
      sourcePath: "/private/reviewed-m7-policy.json",
      projects: new Map([[
        "ovalo",
        { projectId: "ovalo", linear: { teamId: "team_1", projectId: "project_1" } },
      ]]),
    },
    linear: { mode: "read-write", authMode: "personal-api-key", token: "fixture-token-not-used" },
    github: { mode: "disabled" },
  }, {} as never);
  assert.equal(registry.status().externalEffects.linearIssueCreation, true);
  assert.equal("dispatcher" in registry, false, "writes require an external-action plan and approval");
});
