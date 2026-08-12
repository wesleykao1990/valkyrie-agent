export type RuntimeName = "atomic" | "codex" | "claude" | "prime" | "hermes";
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface Project {
  id: string;
  name: string;
  objective: string;
  currentMilestone: string;
  health: "on_track" | "at_risk" | "exploring";
  linearTeam: string;
  repository: string;
  vaultPath: string;
  memoryNamespace: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  source: string;
  sourceId?: string | null;
  title: string;
  objective: string;
  status: string;
  priority: string;
  createdAt: string;
}

export interface Run {
  id: string;
  taskId?: string | null;
  projectId: string;
  rootRuntime: RuntimeName;
  workflow?: string | null;
  status: RunStatus;
  stage?: string | null;
  stageIndex: number;
  budgetUsd: number;
  costUsd: number;
  workspaceId?: string | null;
  nativeRunId?: string | null;
  nextActionAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunEvent {
  seq: number;
  id: string;
  runId: string;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  action: string;
  exactEffect: string;
  state: "pending" | "approved" | "denied" | "changes_requested";
  evidence: string[];
  requestedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  decision?: string | null;
  /**
   * Optional, immutable binding for evidence-gated pilot approvals. Legacy
   * and mock approvals leave every binding field null.
   */
  projectId?: string | null;
  workflow?: string | null;
  evidenceDigest?: string | null;
  policyHash?: string | null;
  expiresAt?: string | null;
}

export interface Artifact {
  id: string;
  runId: string;
  kind: string;
  uri: string;
  checksum: string;
  mediaType: string;
  createdAt: string;
}

export interface MemoryProposal {
  id: string;
  projectId: string;
  runId?: string | null;
  claim: string;
  evidence: string[];
  state: "proposed" | "promoted" | "rejected";
  createdAt: string;
  resolvedAt?: string | null;
  reviewer?: string | null;
  targetNote?: string | null;
}

export interface StartRunInput {
  projectId: string;
  taskId?: string;
  objective: string;
  runtime?: RuntimeName;
  workflow?: string;
  maxCostUsd?: number;
  idempotencyKey?: string;
  approvalPolicy?: {
    preparePr?: "human" | "automatic";
  };
}

export interface RuntimeCapabilities {
  steer: boolean;
  pause: boolean;
  resume: boolean;
  approve: boolean;
  artifacts: boolean;
}

export interface RuntimePreflight {
  runtime: RuntimeName;
  adapter: "mock" | "native";
  enabled: boolean;
  available: boolean;
  executionMode: "simulated" | "read-only" | "isolated-writer";
  workflow?: string;
  modelExecutionAttempted?: boolean;
  command?: string;
  version?: string;
  authenticated?: boolean | "unknown";
  capabilities: RuntimeCapabilities;
  /** A separate control-plane gate, not a native runtime HIL capability. */
  controlPlaneFinalAcceptance?: boolean;
  reason?: string;
}

export interface NativeRunRef {
  runtime: RuntimeName;
  nativeRunId: string;
  nativeSessionId?: string;
  runtimeVersion?: string;
  metadata?: Record<string, unknown>;
}
