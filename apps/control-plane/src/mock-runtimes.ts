import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Approval, Artifact, Run, RunEvent, RuntimeCapabilities, RuntimeName } from "./types.ts";
import type { RuntimeAdapter, RuntimeContext } from "./runtime.ts";
import type { ControlPlaneStore } from "./store.ts";
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
  private store: ControlPlaneStore;
  private workspaces: WorkspaceManager;
  private artifactRoot: string;
  private stageDelayMs: number;

  constructor(
    name: RuntimeName,
    stages: Stage[],
    approvalAfter: string | null,
    store: ControlPlaneStore,
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

  async preflight() {
    return {
      runtime: this.name,
      adapter: "mock" as const,
      enabled: true,
      available: true,
      executionMode: "simulated" as const,
      capabilities: this.capabilities(),
      reason: "Deterministic scripted adapter; no native runtime process is started",
    };
  }

  async start(context: RuntimeContext) {
    const nativeRunId = `${this.name}-mock-${context.run.id}`;
    const first = this.stages[0];
    await this.store.updateRun(context.run.id, {
      status: "running",
      stage: first.name,
      stageIndex: 0,
      nativeRunId,
      startedAt: nowIso(),
      nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString(),
      metadata: { ...context.run.metadata, objective: context.objective, workspacePath: context.workspacePath, adapter: "mock", simulated: true }
    });
    await this.event(context.run.id, "run.started", `${this.name} accepted the run`, { nativeRunId });
    await this.event(context.run.id, "stage.started", first.label, { stage: first.name });
    return { runtime: this.name, nativeRunId };
  }

  async advance(run: Run): Promise<void> {
    if (run.status !== "running") return;
    const current = this.stages[run.stageIndex];
    if (!current) return;

    await this.createArtifactIfNeeded(run, current);
    const nextCost = Math.min(run.budgetUsd, Number((run.costUsd + current.cost).toFixed(2)));
    await this.store.updateRun(run.id, { costUsd: nextCost });
    await this.event(run.id, "stage.completed", `${current.label} completed`, { stage: current.name, costUsd: nextCost });

    if (this.approvalAfter === current.name) {
      const hasFreshVerifier = this.stages.some((stage) => stage.artifact === "verifier");
      const approval: Approval = {
        id: id("approval"),
        runId: run.id,
        action: "prepare_pr",
        exactEffect: "[SIMULATED] Allow the mock runtime to prepare a reviewable pull-request artifact. No real PR, merge, deployment, or candidate selection is permitted.",
        state: "pending",
        evidence: hasFreshVerifier
          ? ["[SIMULATED] Typecheck passed", "[SIMULATED] Unit tests passed", "[SIMULATED] Fresh verifier found no blocking defect"]
          : ["[SIMULATED] Focused checks passed", "Candidate remains subject to independent comparison and human review"],
        requestedAt: nowIso()
      };
      await this.store.requestApprovalTransaction({
        approval,
        event: this.eventRecord(
          run.id,
          "approval.requested",
          "Human approval is required before simulated PR preparation",
          { approvalId: approval.id },
        ),
      });
      return;
    }

    const nextIndex = run.stageIndex + 1;
    const next = this.stages[nextIndex];
    if (!next) {
      await this.complete(run);
      return;
    }

    await this.store.updateRun(run.id, {
      stageIndex: nextIndex,
      stage: next.name,
      nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString()
    });
    await this.event(run.id, "stage.started", next.label, { stage: next.name });
  }

  async steer(run: Run, message: string): Promise<void> {
    await this.event(run.id, "agent.message", `Steering instruction recorded by the mock runtime: ${message}`, { direction: "user_to_agent" });
  }

  async cancel(run: Run): Promise<void> {
    await this.store.updateRun(run.id, { status: "cancelled", completedAt: nowIso(), nextActionAt: null });
    if (run.workspaceId) await this.workspaces.release(run.workspaceId, run.id);
    await this.event(run.id, "run.cancelled", "Run cancelled by Wesley", {});
  }

  async resolveApproval(run: Run, approval: Approval, decision: string): Promise<void> {
    if (decision === "approve") {
      const currentIndex = this.stages.findIndex((s) => s.name === this.approvalAfter);
      const nextIndex = currentIndex + 1;
      const next = this.stages[nextIndex];
      if (!next) {
        await this.complete(run);
        return;
      }
      await this.store.updateRun(run.id, {
        status: "running", stageIndex: nextIndex, stage: next.name,
        nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString()
      });
      await this.event(run.id, "approval.resolved", "Approval granted; simulated execution resumed", { approvalId: approval.id, decision });
      await this.event(run.id, "stage.started", next.label, { stage: next.name });
      return;
    }

    if (decision === "request_changes") {
      const repairIndex = Math.max(0, this.stages.findIndex((s) => s.name === "implement"));
      const repair = this.stages[repairIndex];
      await this.store.updateRun(run.id, {
        status: "running", stageIndex: repairIndex, stage: repair.name,
        nextActionAt: new Date(Date.now() + this.stageDelayMs).toISOString(),
        metadata: { ...run.metadata, repairRequested: true }
      });
      await this.event(run.id, "approval.resolved", "Changes requested; returning to simulated implementation", { approvalId: approval.id, decision });
      await this.event(run.id, "stage.started", `Repair: ${repair.label}`, { stage: repair.name });
      return;
    }

    await this.store.updateRun(run.id, { status: "failed", completedAt: nowIso(), nextActionAt: null });
    if (run.workspaceId) await this.workspaces.release(run.workspaceId, run.id);
    await this.event(run.id, "approval.resolved", "Approval denied", { approvalId: approval.id, decision });
    await this.event(run.id, "run.failed", "Run stopped because approval was denied", {});
  }

  private async complete(run: Run): Promise<void> {
    const refreshed = (await this.store.getRun(run.id)) ?? run;
    const completedAt = nowIso();
    await this.store.updateRun(run.id, { status: "completed", stage: "completed", completedAt, nextActionAt: null });
    await this.event(run.id, "run.completed", `${this.name} completed the simulated run with stored mock evidence`, { costUsd: refreshed.costUsd });
    if (run.workspaceId) await this.workspaces.release(run.workspaceId, run.id);

    const existing = (await this.store.listMemoryProposals()).some((p) => p.runId === run.id);
    if (!existing) {
      await this.store.createMemoryProposal({
        id: id("memory"), projectId: run.projectId, runId: run.id,
        claim: `Record the simulated lifecycle and review lesson from mock run ${run.id}.`,
        evidence: [
          `[SIMULATED] Run ${run.id} completed`,
          this.stages.some((stage) => stage.artifact === "verifier")
            ? "[SIMULATED] Deterministic checks and independent verification were recorded"
            : "[SIMULATED] Deterministic checks were recorded; candidate selection remains a separate human decision"
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
      body = JSON.stringify({ simulated: true, typecheck: "simulated_pass", unitTests: "simulated_pass", browserCheck: "simulated_pass", generatedAt: nowIso() }, null, 2);
      await this.event(run.id, "check.passed", "Mock deterministic checks reported simulated passes", { checks: ["typecheck", "unit_tests", "browser_check"] });
    } else if (stage.artifact === "verifier") {
      name = "verifier-report.md";
      body = "# Simulated fresh verifier report\n\nThis mock did not execute a real verifier. Its scripted result reports no blocking correctness defect and one maintainability warning for human review.\n";
      await this.event(run.id, "check.passed", "Mock fresh verifier produced simulated evidence", { warningCount: 1 });
    } else {
      name = "run-summary.md";
      body = `# Simulated run summary\n\nRun: ${run.id}\nRuntime: ${run.rootRuntime}\nStatus: completed\n\nThis is a scripted prototype artifact, not evidence from a live runtime.\n`;
    }
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    const artifact: Artifact = { id: id("artifact"), runId: run.id, kind, uri: path, checksum: sha(body), mediaType, createdAt: nowIso() };
    await this.store.createArtifact(artifact);
    await this.event(run.id, "artifact.created", `${name} stored`, { artifactId: artifact.id, uri: artifact.uri, checksum: artifact.checksum });
  }

  private async event(runId: string, type: string, message: string, payload: Record<string, unknown>): Promise<void> {
    await this.store.appendEvent(this.eventRecord(runId, type, message, payload));
  }

  private eventRecord(runId: string, type: string, message: string, payload: Record<string, unknown>): Omit<RunEvent, "seq"> {
    return {
      id: id("event"),
      runId,
      type,
      message: `[simulated] ${message}`,
      payload: { ...payload, simulated: true, runtime: this.name },
      createdAt: nowIso(),
    };
  }
}

export function createMockAdapters(store: ControlPlaneStore, workspaces: WorkspaceManager, artifactRoot: string, delay: number): Map<RuntimeName, RuntimeAdapter> {
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
