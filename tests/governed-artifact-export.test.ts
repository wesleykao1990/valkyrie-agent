import test from "node:test";
import assert from "node:assert/strict";
import { linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactSecretDetectedError,
  exportGovernedArtifacts,
  scanArtifactSecrets,
} from "../apps/control-plane/src/governed-artifact-export.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-artifact-export-"));
  const workspace = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  mkdirSync(join(workspace, "reports"), { recursive: true });
  return { root, workspace, artifactRoot };
}

test("governed artifact export copies only reviewed manifest files with private modes", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.workspace, "reports", "checks.txt"), "checks: passed\n", "utf8");
    writeFileSync(join(item.workspace, "unlisted.txt"), "must stay in workspace\n", "utf8");
    const [exported] = exportGovernedArtifacts([{
      relativePath: "reports/checks.txt",
      kind: "deterministic-checks",
      mediaType: "text/plain",
    }], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_fixture" });

    assert.equal(exported.sourceRelativePath, "reports/checks.txt");
    assert.equal(readFileSync(exported.path, "utf8"), "checks: passed\n");
    assert.match(exported.checksum, /^[a-f0-9]{64}$/);
    assert.equal(exported.sizeBytes, 15);
    assert.equal(lstatSync(exported.path).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(item.artifactRoot, "run_fixture")).mode & 0o777, 0o700);
    assert.throws(() => readFileSync(join(item.artifactRoot, "run_fixture", "unlisted.txt")), /ENOENT/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("secret findings disclose rule IDs and fingerprints but never matched values", () => {
  const body = Buffer.from("ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456\n");
  const findings = scanArtifactSecrets(body);
  assert.ok(findings.some((finding) => finding.ruleId === "anthropic-api-key"));
  assert.ok(findings.some((finding) => finding.ruleId === "credential-assignment"));
  assert.ok(findings.every((finding) => /^[a-f0-9]{16}$/.test(finding.fingerprint)));
  assert.equal(JSON.stringify(findings).includes("sk-ant-"), false);
});

test("a secret blocks the complete batch before the artifact root is created", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.workspace, "reports", "clean.txt"), "clean\n", "utf8");
    writeFileSync(join(item.workspace, "reports", "leak.txt"), "token=ghp_abcdefghijklmnopqrstuvwxyz123456\n", "utf8");
    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "reports/clean.txt", kind: "checks", mediaType: "text/plain" },
      { relativePath: "reports/leak.txt", kind: "report", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_secret" }),
    (error: unknown) => error instanceof ArtifactSecretDetectedError && !error.message.includes("ghp_"));
    assert.equal(lstatSync(item.root).isDirectory(), true);
    assert.throws(() => lstatSync(item.artifactRoot), /ENOENT/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("artifact export rejects traversal, duplicate paths, links, and byte-limit overflow", () => {
  const item = fixture();
  const outside = join(item.root, "outside.txt");
  try {
    writeFileSync(outside, "outside\n", "utf8");
    writeFileSync(join(item.workspace, "reports", "large.txt"), "1234567890", "utf8");
    symlinkSync(outside, join(item.workspace, "reports", "link.txt"));
    linkSync(outside, join(item.workspace, "reports", "hardlink.txt"));

    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "../outside.txt", kind: "report", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_traversal" }), /parent segments/);
    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "reports/large.txt", kind: "report", mediaType: "text/plain" },
      { relativePath: "reports/large.txt", kind: "report", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_duplicate" }), /unique/);
    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "reports/link.txt", kind: "report", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_link" }), /symbolic links/);
    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "reports/hardlink.txt", kind: "report", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_hardlink" }), /Hard-linked/);
    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "reports/large.txt", kind: "report", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_large", maxFileBytes: 5 }), /byte limit/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("artifact export replays exact files but never overwrites conflicting run contents", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.workspace, "reports", "checks.txt"), "checks\n", "utf8");
    const first = exportGovernedArtifacts([
      { relativePath: "reports/checks.txt", kind: "checks", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_existing" });
    const replay = exportGovernedArtifacts([
      { relativePath: "reports/checks.txt", kind: "checks", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_existing" });
    assert.deepEqual(replay, first);
    writeFileSync(join(item.artifactRoot, "run_existing", "evidence.txt"), "old\n", "utf8");
    assert.throws(() => exportGovernedArtifacts([
      { relativePath: "reports/checks.txt", kind: "checks", mediaType: "text/plain" },
    ], { workspacePath: item.workspace, artifactRoot: item.artifactRoot, runId: "run_existing" }), /do not match/);
    assert.equal(readFileSync(join(item.artifactRoot, "run_existing", "evidence.txt"), "utf8"), "old\n");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
