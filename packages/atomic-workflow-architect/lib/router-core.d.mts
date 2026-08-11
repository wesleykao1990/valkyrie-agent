export interface RouterConfig {
  enabled?: boolean;
  minimumScore?: number;
  forcePrefixes?: string[];
  bypassPrefixes?: string[];
  projectKeywords?: string[];
  routeRpcInput?: boolean;
  routeInteractiveInput?: boolean;
  defaultWorkspaceOwner?: "control-plane" | "atomic";
  requireDurableBackendForBackgroundRuns?: boolean;
}

export interface RouteDecision {
  mode: "continue" | "route" | "bypass";
  text: string;
  score: number;
  reasons: string[];
}

export function scorePrompt(input: string, config?: RouterConfig): { score: number; reasons: string[] };
export function routePrompt(input: string, config?: RouterConfig): RouteDecision;
export const DEFAULT_ROUTER_CONFIG: Readonly<Required<Pick<RouterConfig, "enabled" | "minimumScore" | "forcePrefixes" | "bypassPrefixes" | "projectKeywords">>>;
