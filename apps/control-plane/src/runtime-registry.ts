import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import { AtomicConnectivityRuntimeAdapter } from "./atomic-runtime-adapter.ts";
import { DirectCliRuntimeAdapter } from "./direct-cli-runtimes.ts";
import { createMockAdapters } from "./mock-runtimes.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import type { ControlPlaneStore } from "./store.ts";
import type { RuntimeName } from "./types.ts";
import type { WorkspaceManager } from "./workspace.ts";

export function exactVersionPattern(commandName: string, version: string): RegExp {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s|\\))`);
}

export function createRuntimeAdapters(
  store: ControlPlaneStore,
  workspaces: WorkspaceManager,
  config: AppConfig,
): Map<RuntimeName, RuntimeAdapter> {
  const artifactRoot = join(config.dataDir, "artifacts");
  const adapters = createMockAdapters(store, workspaces, artifactRoot, config.stageDelayMs);

  if (config.runtimeAdapters.atomic === "native") {
    adapters.set("atomic", new AtomicConnectivityRuntimeAdapter({
      command: config.atomicCommand,
      expectedVersion: config.atomicExpectedVersion,
      packageDir: config.atomicPackageDir,
      dataDir: config.dataDir,
      artifactRoot,
      store,
      workspaces,
    }));
  }

  if (config.runtimeAdapters.codex === "native") {
    adapters.set("codex", new DirectCliRuntimeAdapter({
      name: "codex",
      command: config.codexCommand,
      expectedVersion: exactVersionPattern("codex", config.codexExpectedVersion),
      allowedEnvNames: config.codexRuntimeEnvAllowlist,
      store,
      workspaces,
      artifactRoot,
    }));
  }

  if (config.runtimeAdapters.claude === "native") {
    adapters.set("claude", new DirectCliRuntimeAdapter({
      name: "claude",
      command: config.claudeCommand,
      expectedVersion: exactVersionPattern("claude", config.claudeExpectedVersion),
      allowedEnvNames: config.claudeRuntimeEnvAllowlist,
      store,
      workspaces,
      artifactRoot,
    }));
  }

  return adapters;
}
