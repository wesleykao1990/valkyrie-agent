declare module "@bastani/atomic" {
  export const CONFIG_DIR_NAME: string;
  export function getAgentDir(): string;

  export interface ExtensionContext {
    cwd: string;
    isProjectTrusted(): boolean;
    ui: {
      notify(message: string, level?: "info" | "warning" | "error"): void;
    };
  }

  export interface InputEvent {
    source: "interactive" | "rpc" | "extension";
    text: string;
    images?: unknown[];
    streamingBehavior?: "steer" | "followUp";
  }

  export type InputEventResult =
    | { action: "continue" }
    | { action: "transform"; text: string; images?: unknown[] }
    | { action: "handled" };

  export interface ExtensionAPI {
    on(name: "session_start", handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    on(name: "input", handler: (event: InputEvent, ctx: ExtensionContext) => InputEventResult | Promise<InputEventResult>): void;
    registerCommand(name: string, command: {
      description: string;
      handler: (args: string | undefined, ctx: ExtensionContext) => unknown;
    }): void;
  }
}
