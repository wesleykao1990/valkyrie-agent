import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { CONFIG_DIR_NAME, getAgentDir } from "@bastani/atomic";
import { routePrompt, type RouterConfig } from "../lib/router-core.mjs";

const CONFIG_FILE = "wesley-atomic-router.json";

function readJson(path: string): RouterConfig {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value as RouterConfig : {};
  } catch {
    return {};
  }
}

function loadConfig(cwd: string, projectTrusted: boolean): RouterConfig {
  const globalConfig = readJson(join(getAgentDir(), CONFIG_FILE));
  if (!projectTrusted) return globalConfig;
  const projectConfig = readJson(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE));
  return { ...globalConfig, ...projectConfig };
}

function sourceAllowed(source: "interactive" | "rpc" | "extension", config: RouterConfig): boolean {
  if (source === "extension") return false;
  if (source === "rpc") return config.routeRpcInput !== false;
  return config.routeInteractiveInput !== false;
}

export default function autoRoute(pi: ExtensionAPI) {
  let config: RouterConfig = {};
  let sessionEnabled: boolean | undefined;

  const effectiveConfig = (): RouterConfig => ({
    ...config,
    ...(sessionEnabled === undefined ? {} : { enabled: sessionEnabled }),
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
  });

  pi.registerCommand("atomic-routing", {
    description: "Show or toggle automatic routing through atomic-workflow-architect",
    handler: async (args, ctx: ExtensionContext) => {
      const raw = args?.trim() || "status";
      const [actionToken, ...rest] = raw.split(/\s+/);
      const action = actionToken.toLowerCase();
      if (action === "test") {
        const prompt = rest.join(" ").trim();
        if (!prompt) {
          ctx.ui.notify("Usage: /atomic-routing test <prompt>", "warning");
          return;
        }
        const decision = routePrompt(prompt, effectiveConfig());
        ctx.ui.notify(
          `Routing decision: ${decision.mode} · score ${decision.score} · ${decision.reasons.join(", ")}`,
          decision.mode === "route" ? "info" : "warning",
        );
        return;
      }
      if (action === "on") sessionEnabled = true;
      else if (action === "off") sessionEnabled = false;
      else if (action === "reset") sessionEnabled = undefined;
      else if (action !== "status") {
        ctx.ui.notify("Usage: /atomic-routing [status|on|off|reset|test <prompt>]", "warning");
        return;
      }
      const state = effectiveConfig().enabled !== false ? "enabled" : "disabled";
      ctx.ui.notify(`Atomic workflow auto-routing is ${state} for this session.`, "info");
    },
  });

  pi.on("input", async (event, ctx) => {
    // Workflow stages and extension-generated prompts use source=extension. Streaming
    // steering/follow-ups amend an existing run and must never be re-routed.
    if (!sourceAllowed(event.source, effectiveConfig()) || event.streamingBehavior) {
      return { action: "continue" };
    }

    const decision = routePrompt(event.text, effectiveConfig());
    if (decision.mode === "bypass") {
      if (!decision.text) {
        ctx.ui.notify("Nothing remained after the bypass prefix.", "warning");
        return { action: "handled" };
      }
      return { action: "transform", text: decision.text, images: event.images };
    }
    if (decision.mode !== "route") return { action: "continue" };
    if (!decision.text) {
      ctx.ui.notify("Nothing remained after the Atomic routing prefix.", "warning");
      return { action: "handled" };
    }

    return {
      action: "transform",
      text: `/skill:atomic-workflow-architect ${decision.text}`,
      images: event.images,
    };
  });
}
