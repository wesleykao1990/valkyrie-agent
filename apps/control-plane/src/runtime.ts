import type { Approval, NativeRunRef, Run, RuntimeCapabilities, RuntimeName, RuntimePreflight } from "./types.ts";
import type { WorkspaceLease, WorkspaceRecord } from "./store.ts";

export interface RuntimeArtifactRef {
  path: string;
  uri: string;
  checksum: string;
}

export interface RuntimeContext {
  run: Run;
  objective: string;
  workspacePath: string;
  workspace?: WorkspaceRecord;
  writerLease?: WorkspaceLease;
  contextPack?: RuntimeArtifactRef;
  runContract?: RuntimeArtifactRef;
  finalAction?: "analysis_only";
}

export interface RuntimeAdapter {
  readonly name: RuntimeName;
  capabilities(): RuntimeCapabilities;
  preflight(): Promise<RuntimePreflight>;
  start(context: RuntimeContext): Promise<NativeRunRef>;
  advance(run: Run): Promise<void>;
  steer(run: Run, message: string): Promise<void>;
  cancel(run: Run): Promise<void>;
  resolveApproval(run: Run, approval: Approval, decision: string): Promise<void>;
  shutdown?(): Promise<void>;
}

export class RuntimeCancelledError extends Error {
  constructor(message = "Native runtime was cancelled") {
    super(message);
    this.name = "RuntimeCancelledError";
  }
}
