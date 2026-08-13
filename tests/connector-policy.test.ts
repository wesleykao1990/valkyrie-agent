import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadConnectorPolicy } from "../apps/control-plane/src/connector-policy.ts";
import { loadConfig } from "../apps/control-plane/src/config.ts";

const CONFIG_ENV_NAMES = [
  "CONTROL_PLANE_AUTH_TOKEN", "CONTROL_PLANE_OPERATOR_ID", "ENABLE_DEMO_RESET",
  "GITHUB_CONNECTOR_MODE", "GITHUB_TOKEN_FILE", "LINEAR_AUTH_MODE",
  "LINEAR_CONNECTOR_MODE", "LINEAR_TOKEN_FILE", "M7_CONNECTOR_POLICY_FILE",
  "M7_CONNECTOR_POLICY_SHA256",
] as const;

async function withConnectorEnvironment(callback: () => void | Promise<void>): Promise<void> {
  const prior = Object.fromEntries(CONFIG_ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of CONFIG_ENV_NAMES) delete process.env[name];
    await callback();
  } finally {
    for (const name of CONFIG_ENV_NAMES) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-m7-policy-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  execFileSync("/usr/bin/git", ["-C", repository, "init", "-q"]);
  const policyPath = join(root, "connectors.json");
  const body = JSON.stringify({
    schemaVersion: "1.0.0",
    projects: [{
      projectId: "fixture",
      linear: { teamId: "linear-team-1", projectId: "linear-project-1", evidenceIssueId: "linear-issue-1" },
      github: { owner: "wesleykao1990", repo: "valkyrie-agent", baseRef: "main", headRef: "agent/m7" },
      git: {
        repositoryPath: repository,
        baseRef: "main",
        headRef: "agent/m7",
        checks: [{ id: "verify", executable: "/usr/bin/true", argv: [], maxOutputBytes: 4096 }],
        policyVersion: "fixture-v1",
      },
    }],
  });
  writeFileSync(policyPath, body, { mode: 0o600 });
  chmodSync(policyPath, 0o600);
  return {
    root,
    repository,
    policyPath,
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("connector policy binds exact bytes and produces fixed Linear/Git/GitHub authority", () => {
  const item = fixture();
  try {
    const policy = loadConnectorPolicy({ path: item.policyPath, acceptedSha256: item.digest });
    assert.equal(policy.digest, item.digest);
    assert.equal(policy.projects.size, 1);
    const project = policy.projects.get("fixture")!;
    assert.deepEqual(project.linear, { teamId: "linear-team-1", projectId: "linear-project-1" });
    assert.equal(project.linearEvidenceIssueId, "linear-issue-1");
    assert.equal(project.git?.repositoryPath, realpathSync(item.repository));
    assert.equal(project.git?.repositoryIdentity, "github.com/wesleykao1990/valkyrie-agent");
    assert.equal(project.git?.checkPolicy.length, 1);
    assert.deepEqual(project.github, {
      owner: "wesleykao1990", repo: "valkyrie-agent", baseRef: "main", headRef: "agent/m7",
    });
  } finally {
    item.dispose();
  }
});

test("connector policy rejects changed bytes, unsupported fields, duplicate projects, and ref mismatch", () => {
  const item = fixture();
  try {
    writeFileSync(item.policyPath, `${item.body}\n`);
    assert.throws(() => loadConnectorPolicy({ path: item.policyPath, acceptedSha256: item.digest }), /digest/);
    const invalidCases = [
      { schemaVersion: "1.0.0", projects: [{ projectId: "fixture", unexpected: true }] },
      { schemaVersion: "1.0.0", projects: [{ projectId: "fixture", linear: { teamId: "a", projectId: "b" } }, { projectId: "fixture", linear: { teamId: "a", projectId: "b" } }] },
      { schemaVersion: "1.0.0", projects: [{ projectId: "fixture", github: { owner: "o", repo: "r", baseRef: "main", headRef: "h" }, git: { repositoryPath: item.repository, baseRef: "other", headRef: "h", checks: [{ id: "x", executable: "/usr/bin/true" }] } }] },
    ];
    for (const value of invalidCases) {
      const body = JSON.stringify(value);
      writeFileSync(item.policyPath, body);
      assert.throws(() => loadConnectorPolicy({
        path: item.policyPath,
        acceptedSha256: createHash("sha256").update(body).digest("hex"),
      }));
    }
  } finally {
    item.dispose();
  }
});

test("connector policy refuses symlinks and relative policy or repository paths", () => {
  const item = fixture();
  try {
    const link = join(item.root, "policy-link.json");
    symlinkSync(item.policyPath, link);
    assert.throws(() => loadConnectorPolicy({ path: link, acceptedSha256: item.digest }), /non-symlink/);
    assert.throws(() => loadConnectorPolicy({ path: "relative.json", acceptedSha256: item.digest }), /absolute/);
    const body = JSON.stringify({
      schemaVersion: "1.0.0",
      projects: [{
        projectId: "fixture",
        github: { owner: "o", repo: "r", baseRef: "main", headRef: "h" },
        git: { repositoryPath: "./repo", baseRef: "main", headRef: "h", checks: [{ id: "x", executable: "/usr/bin/true" }] },
      }],
    });
    writeFileSync(item.policyPath, body);
    assert.throws(() => loadConnectorPolicy({
      path: item.policyPath,
      acceptedSha256: createHash("sha256").update(body).digest("hex"),
    }), /repository path must be absolute/);
  } finally {
    item.dispose();
  }
});

test("connector configuration is disabled by default and fails closed around policy, auth, reset, and secret files", async () => {
  await withConnectorEnvironment(() => {
    const defaults = loadConfig().m7Connectors;
    assert.equal(defaults.policy, undefined);
    assert.equal(defaults.linear.mode, "disabled");
    assert.equal(defaults.github.mode, "disabled");

    const item = fixture();
    try {
      process.env.M7_CONNECTOR_POLICY_FILE = item.policyPath;
      process.env.M7_CONNECTOR_POLICY_SHA256 = item.digest;
      assert.throws(() => loadConfig(), /bearer authentication/);
      process.env.CONTROL_PLANE_AUTH_TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
      assert.throws(() => loadConfig(), /ENABLE_DEMO_RESET/);
      process.env.ENABLE_DEMO_RESET = "false";
      assert.equal(loadConfig().m7Connectors.policy?.digest, item.digest);

      process.env.LINEAR_CONNECTOR_MODE = "read-only";
      assert.throws(() => loadConfig(), /LINEAR_TOKEN_FILE/);
      const linearToken = join(item.root, "linear.token");
      writeFileSync(linearToken, "lin_api_fixture_secret", { mode: 0o600 });
      chmodSync(linearToken, 0o600);
      process.env.LINEAR_TOKEN_FILE = linearToken;
      process.env.LINEAR_AUTH_MODE = "personal-api-key";
      assert.equal(loadConfig().m7Connectors.linear.token, "lin_api_fixture_secret");

      process.env.GITHUB_CONNECTOR_MODE = "draft-pr";
      const githubToken = join(item.root, "github.token");
      writeFileSync(githubToken, "github_fixture_secret", { mode: 0o600 });
      chmodSync(githubToken, 0o600);
      process.env.GITHUB_TOKEN_FILE = githubToken;
      assert.throws(() => loadConfig(), /CONTROL_PLANE_OPERATOR_ID/);
      process.env.CONTROL_PLANE_OPERATOR_ID = "wesley-local";
      const enabled = loadConfig().m7Connectors;
      assert.equal(enabled.linear.mode, "read-only");
      assert.equal(enabled.github.mode, "draft-pr");
      assert.equal(enabled.github.token, "github_fixture_secret");
    } finally {
      item.dispose();
    }
  });
});
