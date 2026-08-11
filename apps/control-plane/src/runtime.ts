import type { Approval, NativeRunRef, Run, RuntimeCapabilities, RuntimeName } from "./types.ts";

export interface RuntimeContext {
  run: Run;
  objective: string;
  workspacePath: string;
}

export interface RuntimeAdapter {
  readonly name: RuntimeName;
  capabilities(): RuntimeCapabilities;
  start(context: RuntimeContext): Promise<NativeRunRef>;
  advance(run: Run): Promise<void>;
  steer(run: Run, message: string): Promise<void>;
  cancel(run: Run): Promise<void>;
  resolveApproval(run: Run, approval: Approval, decision: string): Promise<void>;
}
