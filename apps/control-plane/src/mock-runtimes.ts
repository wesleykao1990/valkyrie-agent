import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Approval, Artifact, Run, RuntimeCapabilities, RuntimeName } from "./types.ts";
import type { RuntimeAdapter, RuntimeContext } from "./runtime.ts";
import type { SqliteStore } from "./store.ts";
import type { WorkspaceManager } from "./workspace.ts";
import { id, nowIso } from "./ids.ts";

interface Stage {
  name: string;
  label: string;
  cost: number;
  artifact?: "checks" | "verifier" | "summary";
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class MockRuntimeAdapter implements RuntimeAdapter {
  public readonly name: RuntimeName;
  private stages: Stage[];
  private approvalAfter: string | null;
  private store: SqliteStore;
  private workspaces: WorkspaceManager;
  private artifactRoot: string;
  private stageDelayMs: number;

  constructor(
    name: RuntimeName,
    stages: Stage[],
    approvalAfter: string | null,
    store: SqliteStore,
    workspaces: WorkspaceManager,
    artifactRoot: string,
    stageDelayMs: number
  ) {
    this.name = name;
    this.stages = stages;
    this.approvalAfter = approvalAfter;
    this.store = store;
    this.workspaces = workspaces;
    this.artifactRoot = artifactRoot;
    this.stageDelayMs = stageDelayMs;
    mkdirSync(artifactRoot, { recursive: true });
  }

  capabilities(): RuntimeCapabilities {
    return { steer: true, pause: false, resume: false, approve: true, artifacts: true };
  }

  async start(context: RuntimeContext) {
    const nativeRunId = `${this.name}-mock-${context.run.id}`;
    const first = this.stages[0];
    this.store.updateRun(context.run.id, {
      status: "running",
      stage: first.name,
      stageIndex: 0,
      nativeRunId,
      startedAt: nowIso(),
      nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString(),
      metadata: { ...context.run.metadata, objective: context.objective, workspacePath: context.workspacePath, adapter: "mock" }
    });
    this.event(context.run.id, "run.started", `${this.name} accepted the run`, { nativeRunId });
    this.event(context.run.id, "stage.started", first.label, { stage: first.name });
    return { runtime: this.name, nativeRunId };
  }

  async advance(run: Run): Promise<void> {
    if (run.status !== "running") return;
    const current = this.stages[run.stageIndex];
    if (!current) return;

    await this.createArtifactIfNeeded(run, current);
    const nextCost = Math.min(run.budgetUsd, Number((run.costUsd + current.cost).toFixed(2)));
    this.store.updateRun(run.id, { costUsd: nextCost });
    this.event(run.id, "stage.completed", `${current.label} completed`, { stage: current.name, costUsd: nextCost });

    if (this.approvalAfter === current.name) {
      const hasFreshVerifier = this.stages.some((stage) => stage.artifact === "verifier");
      const approval: Approval = {
        id: id("approval"),
        runId: run.id,
        action: "prepare_pr",
        exactEffect: "Allow the runtime to prepare a reviewable pull-request artifact. No merge, deployment, or candidate selection is permitted.",
        state: "pending",
        evidence: hasFreshVerifier
          ? ["Typecheck passed", "Unit tests passed", "Fresh verifier found no blocking defect"]
          : ["Focused checks passed", "Candidate remains subject to independent comparison and human review"],
        requestedAt: nowIso()
      };
      this.store.createApproval(approval);
      this.store.updateRun(run.id, { status: "awaiting_approval", stage: "approval", nextActionAt: null });
      this.event(run.id, "approval.requested", "Human approval is required before PR preparation", { approvalId: approval.id });
      return;
    }

    const nextIndex = run.stageIndex + 1;
    const next = this.stages[nextIndex];
    if (!next) {
      this.complete(run);
      return;
    }

    this.store.updateRun(run.id, {
      stageIndex: nextIndex,
      stage: next.name,
      nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString()
    });
    this.event(run.id, "stage.started", next.label, { stage: next.name });
  }

  async steer(run: Run, message: string): Promise<void> {
    this.event(run.id, "agent.message", `Steering instruction queued: ${message}`, { direction: "user_to_agent" });
  }

  async cancel(run: Run): Promise<void> {
    this.store.updateRun(run.id, { status: "cancelled", completedAt: nowIso(), nextActionAt: null });
    if (run.workspaceId) this.workspaces.release(run.workspaceId);
    this.event(run.id, "run.cancelled", "Run cancelled by Wesley", {});
  }

  async resolveApproval(run: Run, approval: Approval, decision: string): Promise<void> {
    if (decision === "approve") {
      const currentIndex = this.stages.findIndex((s) => s.name === this.approvalAfter);
      const nextIndex = currentIndex + 1;
      const next = this.stages[nextIndex];
      if (!next) {
        this.complete(run);
        return;
      }
      this.store.updateRun(run.id, {
        status: "running", stageIndex: nextIndex, stage: next.name,
        nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString()
      });
      this.event(run.id, "approval.resolved", "Approval granted; execution resumed", { approvalId: approval.id, decision });
      this.event(run.id, "stage.started", next.label, { stage: next.name });
      return;
    }

    if (decision === "request_changes") {
      const repairIndex = Math.max(0, this.stages.findIndex((s) => s.name === "implement"));
      const repair = this.stages[repairIndex];
      this.store.updateRun(run.id, {
        status: "running", stageIndex: repairIndex, stage: repair.name,
        nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString(),
        metadata: { ...run.metadata, repairRequested: true }
      });
      this.event(run.id, "approval.resolved", "Changes requested; returning to implementation", { approvalId: approval.id, decision });
      this.event(run.id, "stage.started", `Repair: ${repair.label}`, { stage: repair.name });
      return;
    }

    this.store.updateRun(run.id, { status: "failed", completedAt: nowIso(), nextActionAt: null });
    if (run.workspaceId) this.workspaces.release(run.workspaceId);
    this.event(run.id, "approval.resolved", "Approval denied", { approvalId: approval.id, decision });
    this.event(run.id, "run.failed", "Run stopped because approval was denied", {});
  }

  private complete(run: Run): void {
    const refreshed = this.store.getRun(run.id) ?? run;
    const completedAt = nowIso();
    this.store.updateRun(run.id, { status: "completed", stage: "completed", completedAt, nextActionAt: null });
    this.event(run.id, "run.completed", `${this.name} completed the run with stored evidence`, { costUsd: refreshed.costUsd });
    if (run.workspaceId) this.workspaces.release(run.workspaceId);

    const existing = this.store.listMemoryProposals().some((p) => p.runId === run.id);
    if (!existing) {
      this.store.createMemoryProposal({
        id: id("memory"), projectId: run.projectId, runId: run.id,
        claim: `Record the verified implementation and review lesson from run ${run.id}.`,
        evidence: [
          `Run ${run.id} completed`,
          this.stages.some((stage) => stage.artifact === "verifier")
            ? "Deterministic checks and independent verification were recorded"
            : "Deterministic checks were recorded; candidate selection remains a separate human decision"
        ],
        state: "proposed", createdAt: completedAt
      });
    }
  }

  private async createArtifactIfNeeded(run: Run, stage: Stage): Promise<void> {
    if (!stage.artifact) return;
    const dir = join(this.artifactRoot, run.id);
    mkdirSync(dir, { recursive: true });
    let name = "artifact.txt";
    let body = "";
    let kind = stage.artifact;
    let mediaType = "text/plain";
    if (stage.artifact === "checks") {
      name = "checks.json";
      mediaType = "application/json";
      body = JSON.stringify({ typecheck: "passed", unitTests: "passed", browserCheck: "passed", generatedAt: nowIso() }, null, 2);
      this.event(run.id, "check.passed", "Deterministic checks passed", { checks: ["typecheck", "unit_tests", "browser_check"] });
    } else if (stage.artifact === "verifier") {
      name = "verifier-report.md";
      body = "# Fresh verifier report\n\nNo blocking correctness defect was found. One maintainability warning remains for human review.\n";
      this.event(run.id, "check.passed", "Fresh verifier produced evidence-backed approval", { warningCount: 1 });
    } else {
      name = "run-summary.md";
      body = `# Run summary\n\nRun: ${run.id}\nRuntime: ${run.rootRuntime}\nStatus: completed\n\nThis is a prototype artifact.\n`;
    }
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    const artifact: Artifact = { id: id("artifact"), runId: run.id, kind, uri: path, checksum: sha(body), mediaType, createdAt: nowIso() };
    this.store.createArtifact(artifact);
    this.event(run.id, "artifact.created", `${name} stored`, { artifactId: artifact.id, uri: artifact.uri, checksum: artifact.checksum });
  }

  private event(runId: string, type: string, message: string, payload: Record<string, unknown>): void {
    this.store.appendEvent({ id: id("event"), runId, type, message, payload, createdAt: nowIso() });
  }
}

export function createMockAdapters(store: SqliteStore, workspaces: WorkspaceManager, artifactRoot: string, delay: number): Map<RuntimeName, RuntimeAdapter> {
  const map = new Map<RuntimeName, RuntimeAdapter>();
  map.set("atomic", new MockRuntimeAdapter("atomic", [
    { name: "research", label: "Research project context", cost: 0.2 },
    { name: "plan", label: "Create an explicit implementation plan", cost: 0.25 },
    { name: "implement", label: "Implement the bounded change", cost: 0.9 },
    { name: "checks", label: "Run deterministic checks", cost: 0.12, artifact: "checks" },
    { name: "fresh-verifier", label: "Run a fresh-context verifier", cost: 0.3, artifact: "verifier" },
    { name: "finalize", label: "Prepare the reviewable result", cost: 0.08, artifact: "summary" }
  ], "fresh-verifier", store, workspaces, artifactRoot, delay));

  map.set("codex", new MockRuntimeAdapter("codex", [
    { name: "inspect", label: "Inspect the focused task", cost: 0.15 },
    { name: "implement", label: "Implement the focused edit", cost: 0.55 },
    { name: "checks", label: "Run focused checks", cost: 0.1, artifact: "checks" },
    { name: "finalize", label: "Prepare result", cost: 0.05, artifact: "summary" }
  ], "checks", store, workspaces, artifactRoot, delay));

  map.set("claude", new MockRuntimeAdapter("claude", [
    { name: "inspect", label: "Inspect architecture and task context", cost: 0.18 },
    { name: "implement", label: "Implement the candidate", cost: 0.62 },
    { name: "checks", label: "Run focused checks", cost: 0.1, artifact: "checks" },
    { name: "finalize", label: "Prepare result", cost: 0.06, artifact: "summary" }
  ], "checks", store, workspaces, artifactRoot, delay));

  map.set("prime", new MockRuntimeAdapter("prime", [
    { name: "scope", label: "Scope the research objective", cost: 0.15 },
    { name: "investigate", label: "Investigate candidate explanations", cost: 0.65 },
    { name: "experiment", label: "Run a bounded experiment", cost: 0.55 },
    { name: "synthesize", label: "Synthesize findings and caveats", cost: 0.25, artifact: "summary" }
  ], null, store, workspaces, artifactRoot, delay));

  map.set("hermes", new MockRuntimeAdapter("hermes", [
    { name: "plan", label: "Plan the monitoring or personal task", cost: 0.05 },
    { name: "execute", label: "Execute the bounded task", cost: 0.1 },
    { name: "summarize", label: "Prepare mobile briefing", cost: 0.05, artifact: "summary" }
  ], null, store, workspaces, artifactRoot, delay));
  return map;
}
