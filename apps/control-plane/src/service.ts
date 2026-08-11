import { createHash } from "node:crypto";
import type { RuntimeAdapter } from "./runtime.ts";
import type { Approval, MemoryProposal, Project, Run, RuntimeName, StartRunInput, Task } from "./types.ts";
import { canonicalJson, IdempotencyConflictError, type ControlPlaneStore, type RunBundleResult } from "./store.ts";
import type { LocalProjectBrain } from "./project-brain.ts";
import type { WorkspaceManager } from "./workspace.ts";
import { id, nowIso } from "./ids.ts";
import { routeTask, validateBudget } from "./policy.ts";

function requestHash(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

const approvalDecisions = new Set(["approve", "deny", "request_changes"]);
const memoryDecisions = new Set(["promote", "reject"]);

export class ControlPlaneService {
  private store: ControlPlaneStore;
  private brain: LocalProjectBrain;
  private workspaces: WorkspaceManager;
  private adapters: Map<RuntimeName, RuntimeAdapter>;
  private readonly workerId = id("worker");
  private currentTick: Promise<void> | null = null;
  private approvalQueue = new Map<string, Promise<unknown>>();

  constructor(
    store: ControlPlaneStore,
    brain: LocalProjectBrain,
    workspaces: WorkspaceManager,
    adapters: Map<RuntimeName, RuntimeAdapter>
  ) {
    this.store = store;
    this.brain = brain;
    this.workspaces = workspaces;
    this.adapters = adapters;
  }

  listProjects(): Promise<Project[]> { return this.store.listProjects(); }
  listTasks(projectId?: string): Promise<Task[]> { return this.store.listTasks(projectId); }
  listRuns(): Promise<Run[]> { return this.store.listRuns(); }
  listApprovals(): Promise<Approval[]> { return this.store.listApprovals(); }
  listMemoryProposals(): Promise<MemoryProposal[]> { return this.store.listMemoryProposals(); }

  async portfolio() {
    const [projects, runs, tasks, approvals, proposals] = await Promise.all([
      this.store.listProjects(),
      this.store.listRuns(),
      this.store.listTasks(),
      this.store.listApprovals("pending"),
      this.store.listMemoryProposals("proposed"),
    ]);
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

  async projectBrief(projectId: string) {
    const project = await this.requireProject(projectId);
    const [tasks, allRuns, pendingApprovals, proposedMemory] = await Promise.all([
      this.store.listTasks(projectId),
      this.store.listRuns(),
      this.store.listApprovals("pending"),
      this.store.listMemoryProposals("proposed"),
    ]);
    const runs = allRuns.filter((r) => r.projectId === projectId);
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
      pendingApprovals: pendingApprovals.filter((a) => runs.some((r) => r.id === a.runId)),
      memoryProposals: proposedMemory.filter((m) => m.projectId === projectId),
      freshness: { linear: "prototype projection", git: "not connected", vault: nowIso() }
    };
  }

  async captureIdea(input: { projectId: string; title: string }) {
    const project = await this.requireProject(input.projectId);
    const title = input.title.trim();
    if (title.length < 5) throw new Error("Idea title must contain at least 5 characters");
    const duplicate = await this.store.findTaskBySimilarTitle(project.id, title);
    const memoryMatches = this.brain.search(project, title, 3);
    if (duplicate) return { status: "duplicate", duplicate, relatedMemory: memoryMatches };
    const task: Task = {
      id: id("task"), projectId: project.id, source: "hermes-prototype", sourceId: null,
      title, objective: title, status: "idea", priority: "normal", createdAt: nowIso()
    };
    await this.store.createTask(task);
    return { status: "created", task, relatedMemory: memoryMatches, linearAction: "Would create or update a Linear idea in production" };
  }

  async startRun(input: StartRunInput) {
    const project = await this.requireProject(input.projectId);
    const budgetUsd = validateBudget(input.maxCostUsd);
    const route = routeTask(input);
    const task = input.taskId ? await this.store.getTask(input.taskId) : null;
    if (input.taskId && !task) throw new Error("Task not found");
    if (task && task.projectId !== project.id) throw new Error("Task does not belong to the selected project");

    const key = input.idempotencyKey?.trim();
    if (input.idempotencyKey !== undefined && !key) throw new Error("Idempotency key must not be empty");
    const { idempotencyKey: _ignored, ...hashInput } = input;
    const hash = key ? requestHash(hashInput) : null;
    if (key && hash) {
      const existing = await this.store.getIdempotencyRecord("run.create", key);
      if (existing) {
        if (existing.requestHash !== hash) throw new IdempotencyConflictError();
        if (existing.resourceType !== "run") throw new IdempotencyConflictError("Idempotency key refers to another resource type");
        const replayed = await this.getRun(existing.resourceId);
        return {
          run: replayed,
          route: {
            runtime: replayed.run.rootRuntime,
            reason: String(replayed.run.metadata.routeReason ?? route.reason),
          },
        };
      }
    }

    const runId = id("run");
    const workspace = this.workspaces.prepare(runId, project);
    const run: Run = {
      id: runId, taskId: task?.id ?? null, projectId: project.id, rootRuntime: route.runtime,
      workflow: input.workflow ?? (route.runtime === "atomic" ? "issue-to-pr-pilot" : "bounded-task"),
      status: "queued", stage: null, stageIndex: 0, budgetUsd, costUsd: 0,
      workspaceId: workspace.workspaceId, nativeRunId: null, nextActionAt: null, startedAt: null, completedAt: null,
      metadata: { routeReason: route.reason, requestedObjective: input.objective, approvalPolicy: input.approvalPolicy ?? { preparePr: "human" } },
      createdAt: nowIso()
    };
    let created: RunBundleResult;
    try {
      created = await this.store.createRunBundle({
        run,
        workspace: workspace.workspace,
        lease: workspace.lease,
        idempotency: key && hash ? { scope: "run.create", key, requestHash: hash } : undefined,
      });
    } catch (error) {
      await this.workspaces.discard(workspace);
      throw error;
    }
    if (created.replayed) {
      await this.workspaces.discard(workspace);
      const replayed = await this.getRun(created.run.id);
      return {
        run: replayed,
        route: {
          runtime: replayed.run.rootRuntime,
          reason: String(replayed.run.metadata.routeReason ?? route.reason),
        },
      };
    }

    const adapter = this.requireAdapter(route.runtime);
    try {
      const native = await adapter.start({ run: created.run, objective: input.objective, workspacePath: workspace.path });
      await this.store.updateRun(run.id, { nativeRunId: native.nativeRunId });
    } catch (error) {
      const completedAt = nowIso();
      await this.store.updateRun(run.id, {
        status: "failed",
        stage: "startup_failed",
        completedAt,
        nextActionAt: null,
        metadata: { ...run.metadata, startupFailed: true },
      });
      await this.workspaces.release(workspace.workspaceId, run.id);
      await this.store.appendEvent({
        id: id("event"),
        runId: run.id,
        type: "run.failed",
        message: "Runtime failed to start; the writer lease was released",
        payload: { phase: "runtime_start" },
        createdAt: completedAt,
      });
      throw error;
    }
    return { run: await this.getRun(run.id), route };
  }


  async compareRuns(input: {
    projectId: string;
    objective: string;
    runtimes?: RuntimeName[];
    perRunMaxCostUsd?: number;
  }) {
    await this.requireProject(input.projectId);
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
      const current = await this.requireRun(started.run.run.id);
      await this.store.updateRun(current.id, {
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

  async getRun(runId: string) {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    const [task, events, approvals, artifacts] = await Promise.all([
      run.taskId ? this.store.getTask(run.taskId) : Promise.resolve(null),
      this.store.listEvents(runId),
      this.store.listApprovals(),
      this.store.listArtifacts(runId),
    ]);
    return {
      run,
      task,
      events,
      approvals: approvals.filter((a) => a.runId === runId),
      artifacts,
    };
  }

  async steerRun(runId: string, message: string) {
    const run = await this.requireRun(runId);
    const adapter = this.requireAdapter(run.rootRuntime);
    if (!adapter.capabilities().steer) throw new Error("Runtime does not support steering");
    await adapter.steer(run, message);
    return this.getRun(runId);
  }

  async cancelRun(runId: string) {
    const run = await this.requireRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return this.getRun(runId);
    await this.requireAdapter(run.rootRuntime).cancel(run);
    return this.getRun(runId);
  }

  async resolveApproval(approvalId: string, decision: string, resolvedBy = "wesley") {
    if (!approvalDecisions.has(decision)) {
      throw new Error("Approval decision must be approve, deny, or request_changes");
    }
    const previous = this.approvalQueue.get(approvalId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined)
      .then(() => this.resolveApprovalOnce(approvalId, decision, resolvedBy));
    this.approvalQueue.set(approvalId, operation);
    try {
      return await operation;
    } finally {
      if (this.approvalQueue.get(approvalId) === operation) this.approvalQueue.delete(approvalId);
    }
  }

  private async resolveApprovalOnce(approvalId: string, decision: string, resolvedBy: string) {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error("Approval not found");
    const run = await this.requireRun(approval.runId);
    const state = decision === "approve" ? "approved" : decision === "request_changes" ? "changes_requested" : "denied";
    const resolvedAt = nowIso();
    const resolution = await this.store.resolveApprovalTransaction({
      approvalId,
      state,
      decision,
      resolvedBy,
      resolvedAt,
      event: {
        id: id("event"),
        runId: run.id,
        type: "approval.decision_recorded",
        message: "The control plane recorded a human approval decision",
        payload: { approvalId, decision, resolvedBy },
        createdAt: resolvedAt,
      },
    });
    if (!resolution.replayed || resolution.run.status === "awaiting_approval") {
      await this.requireAdapter(resolution.run.rootRuntime).resolveApproval(resolution.run, resolution.approval, decision);
    }
    return this.getRun(run.id);
  }

  async searchMemory(projectId: string, query: string) {
    const project = await this.requireProject(projectId);
    return { projectId, query, mode: "read-only-local-vault-prototype", results: this.brain.search(project, query) };
  }

  async proposeMemory(input: { projectId: string; claim: string; evidence?: string[]; runId?: string }) {
    await this.requireProject(input.projectId);
    if (input.runId) {
      const run = await this.requireRun(input.runId);
      if (run.projectId !== input.projectId) throw new Error("Run does not belong to the selected project");
    }
    const proposal: MemoryProposal = {
      id: id("memory"), projectId: input.projectId, runId: input.runId ?? null,
      claim: input.claim.trim(), evidence: input.evidence ?? [], state: "proposed", createdAt: nowIso()
    };
    if (proposal.claim.length < 10) throw new Error("Memory proposal must contain at least 10 characters");
    await this.store.createMemoryProposal(proposal);
    return proposal;
  }

  async resolveMemoryProposal(proposalId: string, decision: string) {
    if (!memoryDecisions.has(decision)) {
      throw new Error("Memory decision must be promote or reject");
    }
    const proposal = await this.store.getMemoryProposal(proposalId);
    if (!proposal) throw new Error("Memory proposal not found");
    if (proposal.state !== "proposed") throw new Error("Memory proposal has already been resolved");
    if (decision === "reject") {
      await this.store.resolveMemoryProposal(proposalId, "rejected", "wesley");
      return this.store.getMemoryProposal(proposalId);
    }
    const project = await this.requireProject(proposal.projectId);
    const target = this.brain.promote(project, proposal.id, proposal.claim, proposal.evidence);
    await this.store.resolveMemoryProposal(proposalId, "promoted", "wesley", target);
    return this.store.getMemoryProposal(proposalId);
  }

  tick(): Promise<void> {
    if (this.currentTick) return this.currentTick;
    const current = this.tickOnce();
    this.currentTick = current;
    current.then(
      () => { if (this.currentTick === current) this.currentTick = null; },
      () => { if (this.currentTick === current) this.currentTick = null; },
    );
    return current;
  }

  async reconcileStartup() {
    const candidates = await this.store.listReconciliationCandidates(nowIso());
    let queuedRunsFailed = 0;
    let terminalLeasesReleased = 0;
    let expiredLeasesQuarantined = 0;
    let strandedApprovalsRecovered = 0;
    let strandedApprovalsNeedingAttention = 0;
    let strandedApprovalsAlreadySettled = 0;
    const released = new Set<string>();

    for (const run of candidates.queuedRuns) {
      const completedAt = nowIso();
      await this.store.updateRun(run.id, {
        status: "failed",
        stage: "startup_reconciliation",
        completedAt,
        nextActionAt: null,
        metadata: { ...run.metadata, reconciliationReason: "runtime_start_not_confirmed" },
      });
      if (run.workspaceId) {
        await this.workspaces.release(run.workspaceId, run.id);
        released.add(run.workspaceId);
      }
      await this.store.appendEvent({
        id: id("event"),
        runId: run.id,
        type: "run.failed",
        message: "Startup reconciliation failed a queued run whose runtime start was not confirmed",
        payload: { reconciliation: true, reason: "runtime_start_not_confirmed" },
        createdAt: completedAt,
      });
      queuedRunsFailed += 1;
    }

    for (const lease of candidates.terminalLeases) {
      if (released.has(lease.workspaceId)) continue;
      await this.workspaces.release(lease.workspaceId, lease.runId);
      released.add(lease.workspaceId);
      terminalLeasesReleased += 1;
    }

    for (const lease of candidates.expiredLeases) {
      if (released.has(lease.workspaceId)) continue;
      const run = await this.store.getRun(lease.runId);
      const completedAt = nowIso();
      if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
        await this.store.updateRun(run.id, {
          status: "failed",
          stage: "workspace_quarantined",
          completedAt,
          nextActionAt: null,
          metadata: { ...run.metadata, reconciliationReason: "writer_lease_expired" },
        });
        await this.store.appendEvent({
          id: id("event"),
          runId: run.id,
          type: "run.failed",
          message: "Startup reconciliation quarantined a run with an expired writer lease",
          payload: { reconciliation: true, reason: "writer_lease_expired" },
          createdAt: completedAt,
        });
        expiredLeasesQuarantined += 1;
      }
      await this.workspaces.release(lease.workspaceId, lease.runId);
      released.add(lease.workspaceId);
    }

    const reconciliationTime = Date.now();
    const activeLeases = await this.store.listLeases();
    for (const { approval, run: candidateRun } of candidates.strandedApprovals) {
      const run = await this.store.getRun(candidateRun.id);
      if (!run) {
        strandedApprovalsNeedingAttention += 1;
        continue;
      }
      const decision = approval.decision
        ?? (approval.state === "approved" ? "approve" : approval.state === "changes_requested" ? "request_changes" : "deny");
      const activeWriterLease = activeLeases.find((lease) =>
        lease.runId === run.id
        && lease.workspaceId === run.workspaceId
        && lease.mode === "writer"
        && Date.parse(lease.expiresAt) > reconciliationTime
      );

      if (run.status !== "awaiting_approval") {
        if (["completed", "failed", "cancelled"].includes(run.status)) {
          await this.flagApprovalReconciliation(run, approval.id, "resolved_approval_reached_terminal_state_before_replay");
          strandedApprovalsNeedingAttention += 1;
        } else {
          strandedApprovalsAlreadySettled += 1;
        }
        continue;
      }

      if (!activeWriterLease) {
        await this.flagApprovalReconciliation(run, approval.id, "resolved_approval_without_active_writer_lease");
        strandedApprovalsNeedingAttention += 1;
        continue;
      }

      if (run.metadata.adapter === "mock") {
        await this.requireAdapter(run.rootRuntime).resolveApproval(run, approval, decision);
        strandedApprovalsRecovered += 1;
        continue;
      }

      strandedApprovalsNeedingAttention += 1;
      await this.flagApprovalReconciliation(run, approval.id, "native_approval_replay_not_verified");
    }

    return {
      queuedRunsFailed,
      terminalLeasesReleased,
      expiredLeasesQuarantined,
      strandedApprovalsRecovered,
      strandedApprovalsNeedingAttention,
      strandedApprovalsAlreadySettled,
      pendingOutbox: candidates.pendingOutbox.length,
    };
  }

  async resetDemo(seedTasks = true): Promise<void> {
    if (this.store.backend !== "sqlite") throw new Error("Demo reset is disabled for PostgreSQL storage");
    await this.store.resetOperationalData();
    if (seedTasks) {
      const seed: Array<Omit<Task, "createdAt">> = [
        { id: "task_ova_388", projectId: "ovalo", source: "linear-prototype", sourceId: "OVA-388", title: "Improve live pronunciation feedback", objective: "Implement verified low-latency pronunciation feedback", status: "planned", priority: "high" },
        { id: "task_sig_142", projectId: "signal-ledger", source: "linear-prototype", sourceId: "SIG-142", title: "Repair Instagram and Threads ingestion", objective: "Diagnose and repair ingestion while preserving source provenance", status: "planned", priority: "high" },
        { id: "task_aww_017", projectId: "ai-workflow-watch", source: "linear-prototype", sourceId: "AWW-17", title: "Improve deduplication for tool alerts", objective: "Prevent repeated workflow and tool announcements", status: "planned", priority: "normal" }
      ];
      for (const task of seed) await this.store.createTask({ ...task, createdAt: nowIso() });
    }
  }

  private async tickOnce(): Promise<void> {
    const now = new Date();
    const runs = await this.store.claimRunnableRuns(
      now.toISOString(),
      new Date(now.getTime() + 30_000).toISOString(),
      this.workerId,
    );
    let firstError: unknown = null;
    for (const run of runs) {
      try {
        await this.requireAdapter(run.rootRuntime).advance(run);
      } catch (error) {
        firstError ??= error;
      } finally {
        try {
          await this.store.releaseRunClaim(run.id, this.workerId);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    if (firstError) throw firstError;
  }

  private async flagApprovalReconciliation(run: Run, approvalId: string, reason: string): Promise<void> {
    if (run.metadata.approvalReconciliationReason === reason) return;
    const createdAt = nowIso();
    await this.store.updateRun(run.id, {
      metadata: {
        ...run.metadata,
        reconciliationRequired: true,
        approvalReconciliationReason: reason,
      },
    });
    await this.store.appendEvent({
      id: id("event"),
      runId: run.id,
      type: "run.reconciliation_required",
      message: "A resolved approval could not be safely replayed and requires operator reconciliation",
      payload: { reconciliation: true, approvalId, reason },
      createdAt,
    });
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.store.getProject(id);
    if (!project) throw new Error(`Project ${id} not found`);
    return project;
  }

  private async requireRun(id: string): Promise<Run> {
    const run = await this.store.getRun(id);
    if (!run) throw new Error("Run not found");
    return run;
  }

  private requireAdapter(name: RuntimeName): RuntimeAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`Runtime adapter ${name} is not configured`);
    return adapter;
  }
}
