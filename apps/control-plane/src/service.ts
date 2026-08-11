import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeAdapter } from "./runtime.ts";
import type { Approval, MemoryProposal, Project, Run, RuntimeName, StartRunInput, Task } from "./types.ts";
import type { SqliteStore } from "./store.ts";
import type { LocalProjectBrain } from "./project-brain.ts";
import type { WorkspaceManager } from "./workspace.ts";
import { id, nowIso } from "./ids.ts";
import { routeTask, validateBudget } from "./policy.ts";

export class ControlPlaneService {
  private store: SqliteStore;
  private brain: LocalProjectBrain;
  private workspaces: WorkspaceManager;
  private adapters: Map<RuntimeName, RuntimeAdapter>;

  constructor(
    store: SqliteStore,
    brain: LocalProjectBrain,
    workspaces: WorkspaceManager,
    adapters: Map<RuntimeName, RuntimeAdapter>
  ) {
    this.store = store;
    this.brain = brain;
    this.workspaces = workspaces;
    this.adapters = adapters;
  }

  listProjects(): Project[] { return this.store.listProjects(); }
  listTasks(projectId?: string): Task[] { return this.store.listTasks(projectId); }
  listRuns(): Run[] { return this.store.listRuns(); }
  listApprovals(): Approval[] { return this.store.listApprovals(); }
  listMemoryProposals(): MemoryProposal[] { return this.store.listMemoryProposals(); }

  portfolio() {
    const projects = this.store.listProjects();
    const runs = this.store.listRuns();
    const tasks = this.store.listTasks();
    const approvals = this.store.listApprovals("pending");
    const proposals = this.store.listMemoryProposals("proposed");
    return {
      generatedAt: nowIso(),
      prototype: true,
      decisions: {
        interface: "Hermes",
        roadmapAuthority: "Linear",
        codeAuthority: "Git/GitHub",
        memoryRollout: "canonical vault retrieval first; automatic capture deferred",
        atomicStatus: "pilot candidate; A/B gate required"
      },
      projects: projects.map((p) => ({
        ...p,
        taskCounts: {
          ideas: tasks.filter((t) => t.projectId === p.id && t.status === "idea").length,
          planned: tasks.filter((t) => t.projectId === p.id && t.status === "planned").length,
          inProgress: runs.filter((r) => r.projectId === p.id && ["running", "awaiting_approval"].includes(r.status)).length
        },
        activeRuns: runs.filter((r) => r.projectId === p.id && ["running", "awaiting_approval"].includes(r.status))
      })),
      needsWesley: {
        approvals,
        memoryProposals: proposals,
        failedRuns: runs.filter((r) => r.status === "failed")
      },
      recentRuns: runs.slice(0, 20)
    };
  }

  projectBrief(projectId: string) {
    const project = this.requireProject(projectId);
    const tasks = this.store.listTasks(projectId);
    const runs = this.store.listRuns().filter((r) => r.projectId === projectId);
    const decisions = this.brain.acceptedDecisions(project);
    return {
      project,
      linearProjection: {
        prototype: true,
        ideas: tasks.filter((t) => t.status === "idea"),
        planned: tasks.filter((t) => t.status === "planned"),
        note: "Production will query Linear live."
      },
      activeRuns: runs.filter((r) => ["running", "awaiting_approval"].includes(r.status)),
      recentRuns: runs.slice(0, 10),
      acceptedDecisions: decisions,
      pendingApprovals: this.store.listApprovals("pending").filter((a) => runs.some((r) => r.id === a.runId)),
      memoryProposals: this.store.listMemoryProposals("proposed").filter((m) => m.projectId === projectId),
      freshness: { linear: "prototype projection", git: "not connected", vault: nowIso() }
    };
  }

  captureIdea(input: { projectId: string; title: string }) {
    const project = this.requireProject(input.projectId);
    const title = input.title.trim();
    if (title.length < 5) throw new Error("Idea title must contain at least 5 characters");
    const duplicate = this.store.findTaskBySimilarTitle(project.id, title);
    const memoryMatches = this.brain.search(project, title, 3);
    if (duplicate) return { status: "duplicate", duplicate, relatedMemory: memoryMatches };
    const task: Task = {
      id: id("task"), projectId: project.id, source: "hermes-prototype", sourceId: null,
      title, objective: title, status: "idea", priority: "normal", createdAt: nowIso()
    };
    this.store.createTask(task);
    return { status: "created", task, relatedMemory: memoryMatches, linearAction: "Would create or update a Linear idea in production" };
  }

  async startRun(input: StartRunInput) {
    const project = this.requireProject(input.projectId);
    const budgetUsd = validateBudget(input.maxCostUsd);
    const route = routeTask(input);
    const task = input.taskId ? this.store.getTask(input.taskId) : null;
    if (input.taskId && !task) throw new Error("Task not found");

    const run: Run = {
      id: id("run"), taskId: task?.id ?? null, projectId: project.id, rootRuntime: route.runtime,
      workflow: input.workflow ?? (route.runtime === "atomic" ? "issue-to-pr-pilot" : "bounded-task"),
      status: "queued", stage: null, stageIndex: 0, budgetUsd, costUsd: 0,
      workspaceId: null, nativeRunId: null, nextActionAt: null, startedAt: null, completedAt: null,
      metadata: { routeReason: route.reason, requestedObjective: input.objective, approvalPolicy: input.approvalPolicy ?? { preparePr: "human" } },
      createdAt: nowIso()
    };
    this.store.createRun(run);
    const workspace = this.workspaces.create(run.id, project);
    this.store.updateRun(run.id, { workspaceId: workspace.workspaceId });
    const refreshed = this.store.getRun(run.id)!;
    const adapter = this.requireAdapter(route.runtime);
    const native = await adapter.start({ run: refreshed, objective: input.objective, workspacePath: workspace.path });
    this.store.updateRun(run.id, { nativeRunId: native.nativeRunId });
    return { run: this.getRun(run.id), route };
  }


  async compareRuns(input: {
    projectId: string;
    objective: string;
    runtimes?: RuntimeName[];
    perRunMaxCostUsd?: number;
  }) {
    this.requireProject(input.projectId);
    const runtimes = [...new Set(input.runtimes ?? (["atomic", "codex", "claude"] as RuntimeName[]))];
    if (runtimes.length < 2 || runtimes.length > 4) {
      throw new Error("Comparison requires between 2 and 4 distinct runtimes");
    }
    for (const runtime of runtimes) this.requireAdapter(runtime);

    const comparisonId = id("compare");
    const results = await Promise.all(runtimes.map(async (runtime, index) => {
      const started = await this.startRun({
        projectId: input.projectId,
        objective: input.objective,
        runtime,
        maxCostUsd: input.perRunMaxCostUsd ?? 8,
        workflow: runtime === "atomic" ? "issue-to-pr-pilot" : "bounded-comparison-candidate",
        approvalPolicy: { preparePr: "human" }
      });
      const current = this.requireRun(started.run.run.id);
      this.store.updateRun(current.id, {
        metadata: {
          ...current.metadata,
          comparisonId,
          comparisonIndex: index + 1,
          comparisonRuntimes: runtimes
        }
      });
      return this.getRun(current.id);
    }));

    return {
      comparisonId,
      projectId: input.projectId,
      objective: input.objective,
      selectionPolicy: "Human selects a candidate after evidence; completion never implies acceptance.",
      runs: results.map((result) => result.run)
    };
  }

  getRun(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    return {
      run,
      task: run.taskId ? this.store.getTask(run.taskId) : null,
      events: this.store.listEvents(runId),
      approvals: this.store.listApprovals().filter((a) => a.runId === runId),
      artifacts: this.store.listArtifacts(runId)
    };
  }

  async steerRun(runId: string, message: string) {
    const run = this.requireRun(runId);
    const adapter = this.requireAdapter(run.rootRuntime);
    if (!adapter.capabilities().steer) throw new Error("Runtime does not support steering");
    await adapter.steer(run, message);
    return this.getRun(runId);
  }

  async cancelRun(runId: string) {
    const run = this.requireRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return this.getRun(runId);
    await this.requireAdapter(run.rootRuntime).cancel(run);
    return this.getRun(runId);
  }

  async resolveApproval(approvalId: string, decision: string, resolvedBy = "wesley") {
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.state !== "pending") throw new Error("Approval has already been resolved");
    const run = this.requireRun(approval.runId);
    const state = decision === "approve" ? "approved" : decision === "request_changes" ? "changes_requested" : "denied";
    this.store.resolveApproval(approvalId, state, decision, resolvedBy);
    await this.requireAdapter(run.rootRuntime).resolveApproval(run, { ...approval, state: state as any, decision }, decision);
    return this.getRun(run.id);
  }

  searchMemory(projectId: string, query: string) {
    const project = this.requireProject(projectId);
    return { projectId, query, mode: "read-only-local-vault-prototype", results: this.brain.search(project, query) };
  }

  proposeMemory(input: { projectId: string; claim: string; evidence?: string[]; runId?: string }) {
    this.requireProject(input.projectId);
    const proposal: MemoryProposal = {
      id: id("memory"), projectId: input.projectId, runId: input.runId ?? null,
      claim: input.claim.trim(), evidence: input.evidence ?? [], state: "proposed", createdAt: nowIso()
    };
    if (proposal.claim.length < 10) throw new Error("Memory proposal must contain at least 10 characters");
    this.store.createMemoryProposal(proposal);
    return proposal;
  }

  resolveMemoryProposal(proposalId: string, decision: "promote" | "reject") {
    const proposal = this.store.getMemoryProposal(proposalId);
    if (!proposal) throw new Error("Memory proposal not found");
    if (proposal.state !== "proposed") throw new Error("Memory proposal has already been resolved");
    if (decision === "reject") {
      this.store.resolveMemoryProposal(proposalId, "rejected", "wesley");
      return this.store.getMemoryProposal(proposalId);
    }
    const project = this.requireProject(proposal.projectId);
    const target = this.brain.promote(project, proposal.id, proposal.claim, proposal.evidence);
    this.store.resolveMemoryProposal(proposalId, "promoted", "wesley", target);
    return this.store.getMemoryProposal(proposalId);
  }

  async tick(): Promise<void> {
    const runs = this.store.listRunnableRuns(nowIso());
    for (const run of runs) await this.requireAdapter(run.rootRuntime).advance(run);
  }

  resetDemo(seedTasks = true): void {
    this.store.resetOperationalData();
    if (seedTasks) {
      const seed: Array<Omit<Task, "createdAt">> = [
        { id: "task_ova_388", projectId: "ovalo", source: "linear-prototype", sourceId: "OVA-388", title: "Improve live pronunciation feedback", objective: "Implement verified low-latency pronunciation feedback", status: "planned", priority: "high" },
        { id: "task_sig_142", projectId: "signal-ledger", source: "linear-prototype", sourceId: "SIG-142", title: "Repair Instagram and Threads ingestion", objective: "Diagnose and repair ingestion while preserving source provenance", status: "planned", priority: "high" },
        { id: "task_aww_017", projectId: "ai-workflow-watch", source: "linear-prototype", sourceId: "AWW-17", title: "Improve deduplication for tool alerts", objective: "Prevent repeated workflow and tool announcements", status: "planned", priority: "normal" }
      ];
      for (const task of seed) this.store.createTask({ ...task, createdAt: nowIso() });
    }
  }

  private requireProject(id: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw new Error(`Project ${id} not found`);
    return project;
  }

  private requireRun(id: string): Run {
    const run = this.store.getRun(id);
    if (!run) throw new Error("Run not found");
    return run;
  }

  private requireAdapter(name: RuntimeName): RuntimeAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`Runtime adapter ${name} is not configured`);
    return adapter;
  }
}
