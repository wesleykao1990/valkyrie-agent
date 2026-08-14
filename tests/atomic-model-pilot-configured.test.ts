import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildScopedInferencePolicy, createConfiguredInferenceUpstream } from "../apps/control-plane/src/atomic-model-pilot-configured.ts";
import type { AtomicFixtureModelPilotConfig } from "../apps/control-plane/src/config.ts";

function config(overrides: Partial<AtomicFixtureModelPilotConfig> = {}): AtomicFixtureModelPilotConfig {
  return {
    enabled: true, upstreamMode: "openai-compatible", provider: "provider", model: "model", upstreamBaseUrl: "http://127.0.0.1:11434/v1",
    credentialHeader: "bearer", allowCredentialFreeLoopback: true, gatewayPort: 8790,
    acceptedPackageSha256: "a".repeat(64), acceptedImageDigest: `sha256:${"b".repeat(64)}`,
    maxInputTokens: 32_000, maxOutputTokens: 8_000, maxCostUsd: 1,
    inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, codexReasoningEffort: "medium",
    ...overrides,
  };
}

test("configured pre-live policy fixes four roles and supports explicit credential-free loopback", () => {
  const value = buildScopedInferencePolicy(config());
  assert.deepEqual(value.roles, ["implementer", "verifier_initial", "repair", "verifier_final"]);
  assert.equal(value.maxRequests, 16);
  assert.doesNotThrow(() => createConfiguredInferenceUpstream(config()));
});

test("configured external upstream reads only an exact private credential file", () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-provider-secret-"));
  const path = join(root, "provider.token");
  writeFileSync(path, "dedicated-provider-token-123\n", { mode: 0o600 });
  try {
    assert.doesNotThrow(() => createConfiguredInferenceUpstream(config({
      upstreamBaseUrl: "https://provider.invalid/v1", allowCredentialFreeLoopback: false, credentialFile: path,
    })));
    chmodSync(path, 0o644);
    assert.throws(() => createConfiguredInferenceUpstream(config({
      upstreamBaseUrl: "https://provider.invalid/v1", allowCredentialFreeLoopback: false, credentialFile: path,
    })), /0600/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configured subscription upstream requires and preflights a dedicated ChatGPT profile", () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-codex-configured-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const command = join(root, "fake-codex");
  writeFileSync(command, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("scripts/fake-codex-subscription.ts"))} content "$@"\n`, { mode: 0o700 });
  try {
    assert.doesNotThrow(() => createConfiguredInferenceUpstream(config({
      upstreamMode: "codex-subscription", provider: "openai-codex-subscription", model: "gpt-5.6-sol",
      upstreamBaseUrl: undefined, allowCredentialFreeLoopback: false, credentialFile: undefined,
      codexCommand: command, codexExpectedVersion: "0.147.0", codexHome: home,
      codexScratchRoot: join(root, "scratch"),
      codexOutputSchemaPath: resolve("apps/control-plane/schemas/codex-subscription-broker-output.schema.json"),
    })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
