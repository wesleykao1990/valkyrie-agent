import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { RuntimeAdapter } from "./runtime.ts";
import type { Approval, Artifact, MemoryProposal, Project, Run, RuntimeName, RuntimePreflight, StartRunInput, Task } from "./types.ts";
import {
  canonicalJson,
  IdempotencyConflictError,
  type AuthorityBinding,
  type ControlPlaneStore,
  type ExternalActionPlanListInput,
  type EngineeringRoutingAssessmentRecord,
  type RunBundleResult,
} from "./store.ts";
import { contextPackChecksum, type LocalProjectBrain, type PromotionPreview } from "./project-brain.ts";
import {
  LocalProjectBrainProvider,
  type ProjectBrainReadProvider,
} from "./project-brain-provider.ts";
import type { WorkspaceManager } from "./workspace.ts";
import { id, nowIso } from "./ids.ts";
import {
  assessEngineeringRequest as deriveEngineeringRouting,
  type EngineeringIntakeInput,
  routeTask,
  validateBudget,
} from "./policy.ts";
import {
  ATOMIC_FIXTURE_WORKFLOW_NAME,
  type AtomicFixturePilotCoordinator,
} from "./atomic-fixture-pilot.ts";
import {
  ATOMIC_MODEL_PILOT_APPROVAL_ACTION,
  ATOMIC_MODEL_PILOT_WORKFLOW,
} from "./atomic-model-pilot-coordinator.ts";
import type { AtomicModelPilotLifecycleCoordinator } from "./atomic-model-pilot-lifecycle.ts";
import { ATOMIC_MODEL_PILOT_TASK_ID } from "./atomic-model-pilot-lifecycle.ts";
import { ATOMIC_FIXTURE_MODEL_REQUEST } from "../../../packages/atomic-workflow-architect/lib/atomic-fixture-model-pilot-core.mjs";
import {
  DIRECT_CODEX_APPROVAL_ACTION,
  DIRECT_CODEX_MODEL_WORKFLOW,
  DIRECT_CLAUDE_MODEL_WORKFLOW,
  type DirectModelPilotCoordinator,
} from "./direct-model-pilot.ts";
import type { ProductionConnectorRegistry } from "./production-connectors.ts";
import type {
  ExternalFinalActionCoordinator,
  PrepareGithubDraftPrInput,
  PrepareLinearEvidenceCommentInput,
  PrepareLinearIssueInput,
} from "./external-final-action.ts";
import type { ManagedSkillSuiteManager } from "./managed-skill-suites.ts";

function requestHash(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

const approvalDecisions = new Set(["approve", "deny", "request_changes"]);
const memoryDecisions = new Set(["promote", "reject"]);
export const MEMORY_PROMOTION_PREVIEW_MAX_AGE_MS = 15 * 60 * 1_000;
export const MEMORY_PROMOTION_PREVIEW_MAX_FUTURE_SKEW_MS = 30 * 1_000;
export const ENGINEERING_ROUTING_ASSESSMENT_TTL_MS = 15 * 60 * 1_000;

interface ControlPlaneServiceOptions {
  now?: () => Date;
  projectBrainReadProvider?: ProjectBrainReadProvider;
  atomicFixturePilot?: AtomicFixturePilotCoordinator;
  atomicModelPilot?: AtomicModelPilotLifecycleCoordinator;
  directModelPilot?: DirectModelPilotCoordinator;
  directClaudeModelPilotEnabled?: boolean;
  connectors?: ProductionConnectorRegistry;
  externalFinalActions?: ExternalFinalActionCoordinator;
  skillSuites?: Pick<ManagedSkillSuiteManager, "status">;
}

export class ControlPlaneService {
  private store: ControlPlaneStore;
  private brain: LocalProjectBrain;
  private readonly brainReads: ProjectBrainReadProvider;
  private workspaces: WorkspaceManager;
  private adapters: Map<RuntimeName, RuntimeAdapter>;
  private readonly workerId = id("worker");
  private readonly now: () => Date;
  private readonly atomicFixturePilot?: AtomicFixturePilotCoordinator;
  private readonly atomicModelPilot?: AtomicModelPilotLifecycleCoordinator;
  private readonly directModelPilot?: DirectModelPilotCoordinator;
  private readonly directClaudeModelPilotEnabled: boolean;
  private readonly connectors?: ProductionConnectorRegistry;
  private readonly externalFinalActions?: ExternalFinalActionCoordinator;
  private readonly skillSuites?: Pick<ManagedSkillSuiteManager, "status">;
  private currentTick: Promise<void> | null = null;
  private approvalQueue = new Map<string, Promise<unknown>>();

  constructor(
    store: ControlPlaneStore,
    brain: LocalProjectBrain,
    workspaces: WorkspaceManager,
    adapters: Map<RuntimeName, RuntimeAdapter>,
    options: ControlPlaneServiceOptions = {},
  ) {
    this.store = store;
    this.brain = brain;
    this.brainReads = options.projectBrainReadProvider ?? new LocalProjectBrainProvider(brain);
    this.workspaces = workspaces;
    this.adapters = adapters;
    this.now = options.now ?? (() => new Date());
    this.atomicFixturePilot = options.atomicFixturePilot;
    this.atomicModelPilot = options.atomicModelPilot;
    this.directModelPilot = options.directModelPilot;
    this.directClaudeModelPilotEnabled = options.directClaudeModelPilotEnabled ?? false;
    this.connectors = options.connectors;
    this.externalFinalActions = options.externalFinalActions;
    this.skillSuites = options.skillSuites;
  }

  listProjects(): Promise<Project[]> { return this.store.listProjects(); }
  listTasks(projectId?: string): Promise<Task[]> { return this.store.listTasks(projectId); }
  listRuns(): Promise<Run[]> { return this.store.listRuns(); }
  listApprovals(): Promise<Approval[]> { return this.store.listApprovals(); }
  listMemoryProposals(): Promise<MemoryProposal[]> { return this.store.listMemoryProposals(); }

  async connectorStatus() {
    const registry = this.connectors?.status() ?? {
      enabled: false,
      policyDigest: null,
      linear: { mode: "disabled" as const, configuredProjects: [], credentialLoaded: false },
      github: { mode: "disabled" as const, configuredProjects: [], credentialLoaded: false },
      git: { configuredProjects: [] },
      externalEffects: {
        linearIssueCreation: false,
        linearEvidenceComment: false,
        githubDraftPr: false,
        branchPublication: false as const,
        merge: false as const,
        deployment: false as const,
      },
    };
    return {
      ...registry,
      outbox: this.externalFinalActions ? await this.externalFinalActions.deliveryStatus() : null,
      externalActions: this.externalFinalActions ? {
        pendingApproval: (await this.externalFinalActions.listPlans({ state: "pending_approval", limit: 100 })).length,
        ambiguous: (await this.externalFinalActions.listPlans({ state: "ambiguous", limit: 100 })).length,
        executing: (await this.externalFinalActions.listPlans({ state: "executing", limit: 100 })).length,
      } : null,
    };
  }

  skillSuiteStatus() {
    return this.skillSuites?.status() ?? {
      enabled: false,
      rootRef: "private-managed-skill-suites" as const,
      suites: [],
    };
  }

  listConnectorDeadLetters(limit = 100) {
    return this.requireExternalFinalActions().listDeadDeliveries(limit);
  }

  replayConnectorDeadLetter(outboxId: string, resolvedBy: string) {
    return this.requireExternalFinalActions().replayDeadDelivery(outboxId, resolvedBy);
  }

  prepareGithubDraftPr(input: PrepareGithubDraftPrInput) {
    return this.requireExternalFinalActions().prepareGithubDraftPr(input);
  }

  prepareLinearEvidenceComment(input: PrepareLinearEvidenceCommentInput) {
    return this.requireExternalFinalActions().prepareLinearEvidenceComment(input);
  }

  prepareLinearIssue(input: PrepareLinearIssueInput) {
    return this.requireExternalFinalActions().prepareLinearIssue(input);
  }

  listExternalActionPlans(input: ExternalActionPlanListInput = {}) {
    return this.requireExternalFinalActions().listPlans(input);
  }

  async getExternalActionPlan(planId: string) {
    const plan = await this.requireExternalFinalActions().getPlan(planId);
    if (!plan) throw new Error("External action plan not found");
    return plan;
  }

  resolveExternalActionPlan(
    planId: string,
    decision: "approve" | "deny" | "request_changes",
    resolvedBy: string,
    idempotencyKey?: string,
  ) {
    const state = decision === "approve" ? "approved" : decision === "deny" ? "denied" : "changes_requested";
    return this.requireExternalFinalActions().resolveApproval({
      planId,
      state,
      decision,
      resolvedBy,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  reconcileExternalActionPlan(
    planId: string,
    input: {
      outcome: "zero" | "one" | "multiple";
      matchCount?: number;
      externalId?: string;
      externalRevision?: string;
      payloadHash?: string;
      observedAt?: string;
    },
    operatorId: string,
  ) {
    return this.requireExternalFinalActions().reconcileAmbiguousPlan({
      planId,
      operatorId,
      ...input,
    });
  }

  async assessEngineeringRequest(input: EngineeringIntakeInput) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Engineering intake must be an object");
    const allowedKeys = new Set(["projectId", "taskId", "request", "preference", "finalAction", "idempotencyKey"]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
      throw new Error("Engineering intake received an unsupported field; routing scores are control-plane owned");
    }
    const project = await this.requireProject(input.projectId);
    const task = input.taskId ? await this.store.getTask(input.taskId) : null;
    if (input.taskId && !task) throw new Error("Task not found");
    if (task && task.projectId !== project.id) throw new Error("Task does not belong to the selected project");
    const finalAction = input.finalAction ?? "analysis_only";
    const derived = deriveEngineeringRouting({
      request: input.request,
      preference: input.preference ?? "auto",
      finalAction,
      projectHealth: project.health,
      ...(task ? { task: {
        title: task.title,
        objective: task.objective,
        status: task.status,
        priority: task.priority,
      } } : {}),
    });
    const key = input.idempotencyKey?.trim();
    if (input.idempotencyKey !== undefined
        && (!key || key !== input.idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(key))) {
      throw new Error("Engineering assessment idempotency key must be a safe 1-128 character ID without surrounding whitespace");
    }
    const hashInput = {
      projectId: project.id,
      taskId: task?.id ?? null,
      request: input.request,
      preference: input.preference ?? "auto",
      finalAction,
    };
    const idempotencyRequestHash = requestHash(hashInput);
    if (key) {
      const existing = await this.store.getIdempotencyRecord("engineering.assess", key);
      if (existing) {
        if (existing.requestHash !== idempotencyRequestHash
            || existing.resourceType !== "engineering-routing-assessment") {
          throw new IdempotencyConflictError();
        }
        const assessment = await this.store.getEngineeringRoutingAssessment(existing.resourceId);
        if (!assessment) throw new Error("Engineering assessment idempotency record refers to missing state");
        return {
          assessment,
          replayed: true,
          launch: {
            supported: false,
            reason: "The assessment is durable, but general execution remains fail-closed until a reviewed general launcher revalidates current authority and consumes it.",
          },
        };
      }
    }
    const assessmentId = id("route");
    const contextPack = await this.brainReads.buildContextPack(project, input.request, {
      runId: assessmentId,
      ...(task ? { taskId: task.id } : {}),
    });
    const connectorContext = await this.readConnectorAuthority(project, task);
    const contextSources: EngineeringRoutingAssessmentRecord["contextSources"] = {
      linear: connectorContext.linear,
      git: connectorContext.git,
      projectBrain: {
        status: this.brainReads.mode === "local-markdown-readonly" ? "accepted-local" : "candidate-read-only",
        providerId: this.brainReads.providerId,
        providerMode: this.brainReads.mode,
        revision: this.brainReads.revision,
        checksum: contextPackChecksum(contextPack),
        acceptedEntries: contextPack.entries.length,
      },
    };
    const contextDigest = requestHash({
      project: {
        id: project.id,
        objective: project.objective,
        currentMilestone: project.currentMilestone,
        health: project.health,
        repository: project.repository,
      },
      task: task ? {
        id: task.id,
        source: task.source,
        sourceId: task.sourceId ?? null,
        title: task.title,
        objective: task.objective,
        status: task.status,
        priority: task.priority,
      } : null,
      contextSources,
    });
    const unsupportedReasons = [
      ...(connectorContext.linear.status === "revision-bound" ? [] : ["live-linear-authority-unavailable"]),
      ...(connectorContext.git.status === "revision-bound" ? [] : ["live-git-authority-unavailable"]),
      "reviewed-general-launcher-unavailable",
      `general-${derived.decision.shape}-launch-unavailable`,
    ];
    const observedAt = this.now();
    const createdAt = observedAt.toISOString();
    const assessment: EngineeringRoutingAssessmentRecord = {
      id: assessmentId,
      projectId: project.id,
      taskId: task?.id ?? null,
      literalRequest: input.request,
      requestHash: requestHash({
        projectId: project.id,
        taskId: task?.id ?? null,
        request: input.request,
        preference: input.preference ?? "auto",
        finalAction,
      }),
      contextDigest,
      contextSources,
      dimensions: {
        structure: derived.assessment.structure,
        verifiability: derived.assessment.verifiability,
        iteration: derived.assessment.iteration,
        risk: derived.assessment.risk,
        duration: derived.assessment.duration,
        isolation: derived.assessment.isolation,
      },
      hardSignals: {
        explicitLoop: derived.assessment.hardSignals?.explicitLoop ?? false,
        durableBackground: derived.assessment.hardSignals?.durableBackground ?? false,
        approvalOrEvidenceGate: derived.assessment.hardSignals?.approvalOrEvidenceGate ?? false,
        multipleCandidates: derived.assessment.hardSignals?.multipleCandidates ?? false,
      },
      preference: derived.decision.preference,
      finalAction,
      baselineShape: derived.decision.baselineShape,
      selectedShape: derived.decision.shape,
      score: derived.decision.score,
      reasons: [...derived.decision.reasons, ...derived.matchedSignals.map((signal) => `matched:${signal}`)],
      policyVersion: derived.policyVersion,
      executionSupported: false,
      unsupportedReasons,
      status: "unsupported",
      runId: null,
      createdAt,
      expiresAt: new Date(observedAt.getTime() + ENGINEERING_ROUTING_ASSESSMENT_TTL_MS).toISOString(),
    };
    const result = await this.store.createEngineeringRoutingAssessment({
      assessment,
      ...(key ? { idempotency: {
        scope: "engineering.assess",
        key,
        requestHash: idempotencyRequestHash,
        expiresAt: assessment.expiresAt,
      } } : {}),
    });
    return {
      ...result,
      launch: {
        supported: false,
        reason: "The assessment is durable, but general execution remains fail-closed until a reviewed general launcher revalidates current authority and consumes it.",
      },
    };
  }

  async getEngineeringRoutingAssessment(assessmentId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(assessmentId)) throw new Error("Engineering assessment ID is invalid");
    const assessment = await this.store.getEngineeringRoutingAssessment(assessmentId);
    if (!assessment) throw new Error("Engineering routing assessment not found");
    return {
      assessment,
      expired: Date.parse(assessment.expiresAt) <= this.now().getTime(),
      launch: {
        supported: assessment.executionSupported,
        reason: assessment.executionSupported
          ? "A verified implementation is available for this recorded shape."
          : "No general runtime launch is authorized from this assessment; fixed pilots are never substituted.",
      },
    };
  }

  async runtimeStatus(): Promise<RuntimePreflight[]> {
    const adapterStatuses = await Promise.all([...this.adapters.values()].map(async (adapter) => {
      try {
        return await adapter.preflight();
      } catch (error) {
        return {
          runtime: adapter.name,
          adapter: "native",
          enabled: true,
          available: false,
          executionMode: "read-only",
          authenticated: "unknown",
          capabilities: adapter.capabilities(),
          reason: error instanceof Error ? error.message : String(error),
        } satisfies RuntimePreflight;
      }
    }));
    const results = [...adapterStatuses];
    if (this.atomicFixturePilot) {
      const pilot = await this.atomicFixturePilot.preflight();
      results.push({
        runtime: "atomic",
        adapter: "native",
        enabled: pilot.enabled,
        available: pilot.available,
        executionMode: pilot.executionMode,
        workflow: pilot.workflow,
        modelExecutionAttempted: pilot.modelExecutionAttempted,
        version: pilot.runner?.atomicVersion,
        authenticated: false,
        capabilities: { steer: false, pause: false, resume: false, approve: false, artifacts: true },
        controlPlaneFinalAcceptance: true,
        reason: pilot.reason,
      });
    }
    if (this.atomicModelPilot) {
      const pilot = await this.atomicModelPilot.preflight();
      results.push({
        runtime: "atomic",
        adapter: "native",
        enabled: pilot.enabled,
        available: pilot.available,
        executionMode: pilot.executionMode,
        workflow: pilot.workflow,
        modelExecutionAttempted: pilot.modelExecutionAttempted,
        version: pilot.runner?.atomicVersion,
        authenticated: "unknown",
        capabilities: { steer: false, pause: false, resume: false, approve: false, artifacts: true },
        controlPlaneFinalAcceptance: true,
        reason: pilot.reason,
      });
    }
    if (this.directModelPilot) {
      const pilot = await this.directModelPilot.preflight();
      results.push({
        runtime: "codex",
        adapter: "native",
        enabled: pilot.enabled,
        available: pilot.available,
        executionMode: pilot.executionMode,
        workflow: pilot.workflow,
        modelExecutionAttempted: pilot.modelExecutionAttempted,
        authenticated: pilot.authenticated,
        capabilities: { steer: false, pause: false, resume: false, approve: false, artifacts: true },
        controlPlaneFinalAcceptance: true,
        reason: pilot.reason,
      });
    }
    results.push({
      runtime: "claude",
      adapter: "native",
      enabled: this.directClaudeModelPilotEnabled,
      available: false,
      executionMode: "isolated-writer",
      workflow: DIRECT_CLAUDE_MODEL_WORKFLOW,
      modelExecutionAttempted: false,
      authenticated: false,
      capabilities: { steer: false, pause: false, resume: false, approve: false, artifacts: true },
      controlPlaneFinalAcceptance: true,
      reason: this.directClaudeModelPilotEnabled
        ? "Claude Code comparison remains fail-closed until a separately reviewed API-key or subscription broker is configured and exercised"
        : "Direct Claude Code comparison is disabled by default",
    });
    return results;
  }

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
    const [tasks, allRuns, pendingApprovals, proposedMemory, authority] = await Promise.all([
      this.store.listTasks(projectId),
      this.store.listRuns(),
      this.store.listApprovals("pending"),
      this.store.listMemoryProposals("proposed"),
      this.readConnectorAuthority(project, null),
    ]);
    const runs = allRuns.filter((r) => r.projectId === projectId);
    const decisions = await this.brainReads.acceptedDecisions(project);
    return {
      project,
      linearProjection: {
        prototype: authority.linear.status !== "revision-bound",
        ideas: tasks.filter((t) => t.status === "idea"),
        planned: tasks.filter((t) => t.status === "planned"),
        authority: authority.linear,
        note: authority.linear.status === "revision-bound"
          ? "Current Linear project authority is revision-bound; task lists remain a narrow local projection, not a roadmap mirror."
          : "Task lists are a local projection because current Linear authority is unavailable.",
      },
      activeRuns: runs.filter((r) => ["running", "awaiting_approval"].includes(r.status)),
      recentRuns: runs.slice(0, 10),
      acceptedDecisions: decisions,
      pendingApprovals: pendingApprovals.filter((a) => runs.some((r) => r.id === a.runId)),
      memoryProposals: proposedMemory.filter((m) => m.projectId === projectId),
      freshness: {
        linear: authority.linear,
        git: authority.git,
        projectBrain: {
          providerId: this.brainReads.providerId,
          mode: this.brainReads.mode,
          revision: this.brainReads.revision,
          observedAt: nowIso(),
        },
      }
    };
  }

  async captureIdea(input: { projectId: string; title: string }) {
    const project = await this.requireProject(input.projectId);
    const title = input.title.trim();
    if (title.length < 5) throw new Error("Idea title must contain at least 5 characters");
    const duplicate = await this.store.findTaskBySimilarTitle(project.id, title);
    const memoryMatches = await this.brainReads.search(project, title, 3);
    if (duplicate) return { status: "duplicate", duplicate, relatedMemory: memoryMatches };
    const task: Task = {
      id: id("task"), projectId: project.id, source: "hermes-prototype", sourceId: null,
      title, objective: title, status: "idea", priority: "normal", createdAt: nowIso()
    };
    await this.store.createTask(task);
    return {
      status: "created",
      task,
      relatedMemory: memoryMatches,
      linearAction: "Retained locally; any Linear issue requires a separate evidence-bound external-action plan and approval",
    };
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
        if (this.atomicFixturePilot?.isPilotRun(replayed.run) && replayed.run.status === "queued") {
          this.atomicFixturePilot.schedule(replayed.run.id);
        }
        if (this.atomicModelPilot?.isPilotRun(replayed.run) && replayed.run.status === "queued") {
          this.atomicModelPilot.schedule(replayed.run.id);
        }
        if (this.directModelPilot?.isPilotRun(replayed.run) && replayed.run.status === "queued") {
          this.directModelPilot.schedule(replayed.run.id);
        }
        return {
          run: replayed,
          route: {
            runtime: replayed.run.rootRuntime,
            reason: String(replayed.run.metadata.routeReason ?? route.reason),
          },
        };
      }
    }

    if (input.workflow === ATOMIC_FIXTURE_WORKFLOW_NAME) {
      if (!this.atomicFixturePilot) throw new Error("Atomic fixture pilot is disabled");
      const pilotBudgetUsd = this.atomicFixturePilot.validateStart(input);
      if (input.approvalPolicy?.preparePr === "automatic") {
        throw new Error("Atomic fixture pilot requires a human final-action boundary");
      }
      const preflight = await this.atomicFixturePilot.preflight();
      if (!preflight.available) throw new Error(`Atomic fixture pilot is unavailable: ${preflight.reason ?? "preflight failed"}`);
      const runner = preflight.runner;
      if (!runner?.available || !runner.atomicVersion || !runner.imageDigest
          || !runner.provenanceDigest || !runner.provenanceLabels) {
        throw new Error("Atomic fixture pilot preflight omitted exact runner evidence");
      }
      const run: Run = {
        id: id("run"),
        taskId: task!.id,
        projectId: project.id,
        rootRuntime: "atomic",
        workflow: ATOMIC_FIXTURE_WORKFLOW_NAME,
        status: "queued",
        stage: null,
        stageIndex: 0,
        budgetUsd: pilotBudgetUsd,
        costUsd: 0,
        workspaceId: null,
        nativeRunId: null,
        nextActionAt: null,
        startedAt: null,
        completedAt: null,
        metadata: {
          routeReason: route.reason,
          requestedObjective: input.objective,
          approvalPolicy: { preparePr: "human" },
          adapter: "atomic-fixture-pilot",
          executionMode: "isolated-writer",
          atomicVersion: runner.atomicVersion,
          atomicRunnerImageRef: runner.imageRef,
          atomicRunnerImageDigest: runner.imageDigest,
          atomicRunnerProvenanceDigest: runner.provenanceDigest,
          atomicRunnerProvenanceLabels: { ...runner.provenanceLabels },
          atomicRunnerPreflightNetwork: "none",
          modelExecutionAttempted: false,
          automaticEpisodicCapture: false,
          crossProcessResume: false,
          externalActionPerformed: false,
        },
        createdAt: this.now().toISOString(),
      };
      const created = await this.store.createRunBundle({
        run,
        idempotency: key && hash ? { scope: "run.create", key, requestHash: hash } : undefined,
        admission: { workflow: ATOMIC_FIXTURE_WORKFLOW_NAME, maxNonterminal: 1 },
      });
      if (created.run.status === "queued") this.atomicFixturePilot.schedule(created.run.id);
      return {
        run: await this.getRun(created.run.id),
        route: { runtime: "atomic" as const, reason: route.reason },
      };
    }

    if (input.workflow === ATOMIC_MODEL_PILOT_WORKFLOW) {
      if (!this.atomicModelPilot) throw new Error("Atomic model pilot is disabled");
      const pilotBudgetUsd = this.atomicModelPilot.validateStart(input);
      if (input.approvalPolicy?.preparePr === "automatic") {
        throw new Error("Atomic model pilot requires a separate operator-intended final-action boundary");
      }
      const preflight = await this.atomicModelPilot.preflight();
      if (!preflight.available) throw new Error(`Atomic model pilot is unavailable: ${preflight.reason ?? "preflight failed"}`);
      const runner = preflight.runner;
      if (!runner?.available || !runner.atomicVersion || !runner.imageDigest
          || !runner.provenanceDigest || !runner.provenanceLabels) {
        throw new Error("Atomic model pilot preflight omitted exact runner evidence");
      }
      const run: Run = {
        id: id("run"),
        taskId: task!.id,
        projectId: project.id,
        rootRuntime: "atomic",
        workflow: ATOMIC_MODEL_PILOT_WORKFLOW,
        status: "queued",
        stage: null,
        stageIndex: 0,
        budgetUsd: pilotBudgetUsd,
        costUsd: 0,
        workspaceId: null,
        nativeRunId: null,
        nextActionAt: null,
        startedAt: null,
        completedAt: null,
        metadata: {
          routeReason: route.reason,
          requestedObjective: input.objective,
          approvalPolicy: { preparePr: "human" },
          adapter: "atomic-model-pilot",
          executionMode: "isolated-writer-scoped-inference",
          atomicVersion: runner.atomicVersion,
          atomicRunnerImageRef: runner.imageRef,
          atomicRunnerImageDigest: runner.imageDigest,
          atomicRunnerProvenanceDigest: runner.provenanceDigest,
          atomicRunnerProvenanceLabels: { ...runner.provenanceLabels },
          modelExecutionAttempted: false,
          liveProviderExpected: preflight.liveProviderExpected,
          liveProviderVerified: false,
          automaticEpisodicCapture: false,
          crossProcessResume: false,
          externalActionPerformed: false,
        },
        createdAt: this.now().toISOString(),
      };
      const created = await this.store.createRunBundle({
        run,
        idempotency: key && hash ? { scope: "run.create", key, requestHash: hash } : undefined,
        admission: { workflow: ATOMIC_MODEL_PILOT_WORKFLOW, maxNonterminal: 1 },
      });
      if (created.run.status === "queued") this.atomicModelPilot.schedule(created.run.id);
      return {
        run: await this.getRun(created.run.id),
        route: { runtime: "atomic" as const, reason: route.reason },
      };
    }

    if (input.workflow === DIRECT_CODEX_MODEL_WORKFLOW) {
      if (!this.directModelPilot) throw new Error("Direct Codex model pilot is disabled");
      const pilotBudgetUsd = this.directModelPilot.validateStart(input);
      if (input.approvalPolicy?.preparePr === "automatic") {
        throw new Error("Direct Codex model pilot requires a separate operator-intended final-action boundary");
      }
      const preflight = await this.directModelPilot.preflight();
      if (!preflight.available) throw new Error(`Direct Codex model pilot is unavailable: ${preflight.reason ?? "preflight failed"}`);
      const run: Run = {
        id: id("run"), taskId: task!.id, projectId: project.id, rootRuntime: "codex",
        workflow: DIRECT_CODEX_MODEL_WORKFLOW, status: "queued", stage: null, stageIndex: 0,
        budgetUsd: pilotBudgetUsd, costUsd: 0, workspaceId: null, nativeRunId: null,
        nextActionAt: null, startedAt: null, completedAt: null,
        metadata: {
          routeReason: route.reason, requestedObjective: input.objective,
          approvalPolicy: { preparePr: "human" }, adapter: "direct-codex-model-pilot",
          executionMode: "isolated-writer-scoped-inference", modelExecutionAttempted: false,
          automaticEpisodicCapture: false, crossProcessResume: false, externalActionPerformed: false,
        },
        createdAt: this.now().toISOString(),
      };
      const created = await this.store.createRunBundle({
        run,
        idempotency: key && hash ? { scope: "run.create", key, requestHash: hash } : undefined,
        admission: { workflow: DIRECT_CODEX_MODEL_WORKFLOW, maxNonterminal: 1 },
      });
      if (created.run.status === "queued") this.directModelPilot.schedule(created.run.id);
      return { run: await this.getRun(created.run.id), route: { runtime: "codex" as const, reason: route.reason } };
    }

    if (input.workflow === DIRECT_CLAUDE_MODEL_WORKFLOW) {
      throw new Error("Direct Claude Code model pilot is not available until its separate credential boundary is reviewed and exercised");
    }

    if (!route.supported || !route.runtime) throw new Error(route.reason);
    const adapter = this.requireAdapter(route.runtime);
    const preflight = await adapter.preflight();
    if (!preflight.enabled || !preflight.available) {
      throw new Error(`${route.runtime} runtime is unavailable: ${preflight.reason ?? "preflight failed"}`);
    }
    if (preflight.adapter === "native" && input.workflow !== "runtime-connectivity") {
      throw new Error("Native adapters are limited to the explicit runtime-connectivity workflow in this milestone");
    }
    if (
      preflight.adapter === "native"
      && (route.runtime === "codex" || route.runtime === "claude")
      && !/^Return exactly [A-Z][A-Z0-9_]{2,63} and nothing else\.$/.test(input.objective)
    ) {
      throw new Error("Native Codex/Claude connectivity runs require: Return exactly MARKER and nothing else.");
    }

    const runId = id("run");
    const workspace = this.workspaces.prepare(runId, project);
    const run: Run = {
      id: runId, taskId: task?.id ?? null, projectId: project.id, rootRuntime: route.runtime,
      workflow: input.workflow ?? (route.runtime === "atomic" ? "issue-to-pr-pilot" : "bounded-task"),
      status: "queued", stage: null, stageIndex: 0, budgetUsd, costUsd: 0,
      workspaceId: workspace.workspaceId, nativeRunId: null, nextActionAt: null, startedAt: null, completedAt: null,
      metadata: {
        routeReason: route.reason,
        requestedObjective: input.objective,
        approvalPolicy: input.approvalPolicy ?? { preparePr: "human" },
        adapter: preflight.adapter,
        executionMode: preflight.executionMode,
        runtimeVersion: preflight.version,
      },
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

    try {
      const runtimeContext = await this.createRuntimeContextArtifacts(
        project,
        task,
        created.run,
        input.objective,
        workspace.path,
        created.workspace,
        created.lease,
      );
      const native = await adapter.start({
        run: runtimeContext.run,
        objective: input.objective,
        workspacePath: workspace.path,
        workspace: created.workspace,
        writerLease: created.lease,
        contextPack: runtimeContext.contextPack,
        runContract: runtimeContext.runContract,
        finalAction: "analysis_only",
      });
      const current = await this.store.getRun(run.id) ?? run;
      await this.store.updateRun(run.id, {
        nativeRunId: native.nativeRunId,
        metadata: {
          ...current.metadata,
          nativeSessionId: native.nativeSessionId,
          runtimeVersion: native.runtimeVersion ?? preflight.version,
          native: native.metadata ?? {},
        },
      });
    } catch (error) {
      let current = await this.store.getRun(run.id) ?? run;
      if (preflight.adapter === "native" && current.status === "running") {
        try {
          await adapter.cancel(current);
        } catch {
          // The adapter's bounded termination path runs before its persistence;
          // retain the original startup/registration error below.
        }
        current = await this.store.getRun(run.id) ?? current;
      }
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        if (current.workspaceId && current.status !== "completed") await this.workspaces.release(current.workspaceId, current.id);
        throw error;
      }
      const completedAt = nowIso();
      await this.store.updateRun(run.id, {
        status: "failed",
        stage: "startup_failed",
        completedAt,
        nextActionAt: null,
        metadata: { ...current.metadata, startupFailed: true },
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
    taskId?: string;
    candidateRunIds?: string[];
    idempotencyKey?: string;
  }) {
    await this.requireProject(input.projectId);
    if (!this.atomicModelPilot || !this.directModelPilot) {
      const runtimes = [...new Set(input.runtimes ?? (["atomic", "codex", "claude"] as RuntimeName[]))];
      if (runtimes.length < 2 || runtimes.length > 4) throw new Error("Comparison requires between 2 and 4 distinct runtimes");
      for (const runtime of runtimes) this.requireAdapter(runtime);
      const comparisonId = id("compare");
      const runs = await Promise.all(runtimes.map(async (runtime, index) => {
        const started = await this.startRun({
          projectId: input.projectId, objective: input.objective, runtime,
          maxCostUsd: input.perRunMaxCostUsd ?? 8,
          workflow: runtime === "atomic" ? "issue-to-pr-pilot" : "bounded-comparison-candidate",
          approvalPolicy: { preparePr: "human" },
        });
        const current = await this.requireRun(started.run.run.id);
        await this.store.updateRun(current.id, { metadata: {
          ...current.metadata, comparisonId, comparisonIndex: index + 1, comparisonRuntimes: runtimes,
        } });
        return (await this.getRun(current.id)).run;
      }));
      return {
        comparisonId, projectId: input.projectId, objective: input.objective,
        selectionPolicy: "Human selects a candidate after evidence; completion never implies acceptance.", runs,
      };
    }
    const taskId = input.taskId ?? ATOMIC_MODEL_PILOT_TASK_ID;
    if (input.projectId !== "atomic-pilot" || taskId !== ATOMIC_MODEL_PILOT_TASK_ID || input.objective !== ATOMIC_FIXTURE_MODEL_REQUEST) {
      throw new Error("Milestone 6 comparison requires the exact disposable M5b task contract");
    }
    const runtimes = [...new Set(input.runtimes ?? (["atomic", "codex"] as RuntimeName[]))];
    if (canonicalJson(runtimes) !== canonicalJson(["atomic", "codex"])) {
      throw new Error("Milestone 6 comparison currently requires exactly Atomic and direct Codex, in that order");
    }
    if (input.candidateRunIds && input.candidateRunIds.length > runtimes.length) throw new Error("Too many comparison candidate run IDs were supplied");
    const key = input.idempotencyKey?.trim();
    if (input.idempotencyKey !== undefined && !key) throw new Error("Comparison idempotency key must not be empty");
    const comparisonId = key
      ? `compare_${requestHash({ projectId: input.projectId, key }).slice(0, 32)}`
      : id("compare");
    const contractHash = requestHash({ projectId: input.projectId, taskId, objective: input.objective });
    let comparison = await this.store.getComparison(comparisonId);
    if (!comparison) {
      const createdAt = this.now().toISOString();
      comparison = await this.store.createComparison({
        id: comparisonId, projectId: input.projectId, taskId, objective: input.objective, contractHash,
        status: "running", selectionPolicy: "Wesley selects only after reviewing evidence; completion never implies acceptance.",
        createdAt, completedAt: null,
      });
    } else if (comparison.contractHash !== contractHash || comparison.projectId !== input.projectId || comparison.taskId !== taskId) {
      throw new IdempotencyConflictError("Comparison idempotency key was reused for another contract");
    }
    const attached = await this.store.listComparisonCandidates(comparisonId);
    const results = [];
    for (const [index, runtime] of runtimes.entries()) {
      const existingCandidate = attached.find((candidate) => candidate.runtime === runtime);
      let current: Run;
      if (existingCandidate) {
        current = await this.requireRun(existingCandidate.runId);
      } else {
        const suppliedRunId = input.candidateRunIds?.[index];
        if (suppliedRunId) {
          current = await this.requireRun(suppliedRunId);
          const expectedWorkflow = runtime === "atomic" ? ATOMIC_MODEL_PILOT_WORKFLOW : DIRECT_CODEX_MODEL_WORKFLOW;
          if (current.projectId !== input.projectId || current.taskId !== taskId || current.rootRuntime !== runtime
              || current.workflow !== expectedWorkflow || current.metadata.requestedObjective !== input.objective) {
            throw new Error("Supplied comparison candidate does not match the literal runtime/task contract");
          }
        } else {
          const started = await this.startRun({
            projectId: input.projectId, taskId, objective: input.objective, runtime,
            maxCostUsd: input.perRunMaxCostUsd ?? 1,
            workflow: runtime === "atomic" ? ATOMIC_MODEL_PILOT_WORKFLOW : DIRECT_CODEX_MODEL_WORKFLOW,
            idempotencyKey: `comparison:${comparisonId}:${runtime}`,
            approvalPolicy: { preparePr: "human" },
          });
          current = await this.requireRun(started.run.run.id);
        }
        const candidateCreatedAt = current.createdAt;
        await this.store.attachComparisonCandidate({
          comparisonId, runId: current.id, runtime, workflow: current.workflow!, ordinal: index + 1,
          status: "running", metrics: null, evidenceDigest: null,
          createdAt: candidateCreatedAt, updatedAt: candidateCreatedAt,
        });
        await this.store.updateRun(current.id, { metadata: {
          ...current.metadata, comparisonId, comparisonIndex: index + 1, comparisonRuntimes: runtimes,
        } });
      }
      results.push(await this.getRun(current.id));
    }
    const refreshed = await this.refreshComparison(comparisonId);
    return { comparisonId, ...refreshed, runs: results.map((result) => result.run) };
  }

  async getComparison(comparisonId: string) { return this.refreshComparison(comparisonId); }

  private async refreshComparison(comparisonId: string) {
    let comparison = await this.store.getComparison(comparisonId);
    if (!comparison) throw new Error("Comparison not found");
    const candidates = await this.store.listComparisonCandidates(comparisonId);
    for (const candidate of candidates) {
      if (candidate.status !== "running") continue;
      const run = await this.requireRun(candidate.runId);
      if (!["awaiting_approval", "completed", "failed", "cancelled"].includes(run.status)) continue;
      const [artifacts, events, requests] = await Promise.all([
        this.store.listArtifacts(run.id), this.store.listEvents(run.id), this.store.listInferenceRequests(run.id),
      ]);
      const evidenceDigest = requestHash(artifacts.map((artifact) => ({
        id: artifact.id, kind: artifact.kind, uri: artifact.uri, checksum: artifact.checksum, mediaType: artifact.mediaType,
      })).sort((left, right) => left.kind.localeCompare(right.kind) || left.uri.localeCompare(right.uri) || left.id.localeCompare(right.id)));
      const latestAt = [...events.map((event) => Date.parse(event.createdAt)), Date.parse(run.completedAt ?? "")]
        .filter(Number.isFinite).reduce((maximum, value) => Math.max(maximum, value), Date.parse(run.createdAt));
      const startedAt = Date.parse(run.startedAt ?? run.createdAt);
      const passed = ["awaiting_approval", "completed"].includes(run.status) && artifacts.length > 0;
      const finalized = await this.store.finalizeComparisonCandidate({
        ...candidate,
        status: passed ? run.status === "completed" ? "accepted" : "evidence_ready" : "failed",
        evidenceDigest,
        metrics: {
          correctness: passed ? "passed" : "failed",
          // For the fixed pilot, one means the initial checks/verifier caught an
          // evidence-backed defect and triggered the sole permitted repair.
          defectsCaught: Number(run.metadata.repairCount ?? 0),
          inputTokens: requests.reduce((sum, item) => sum + item.inputTokens, 0),
          outputTokens: requests.reduce((sum, item) => sum + item.outputTokens, 0),
          costMicros: requests.reduce((sum, item) => sum + item.costMicros, 0),
          elapsedMs: Math.max(0, latestAt - startedAt),
          humanReviewArtifacts: artifacts.length,
          eventCount: events.length,
          recoveryReliability: run.metadata.atomicModelCleanedRecovery === true || run.metadata.directModelCleanedRecovery === true
            ? "recovered" : "not_exercised",
          resumability: "control_plane_only",
          // Reviewed seam-count rubric: Atomic adds native RPC/main-session/
          // workflow/bridge seams; direct Codex omits those orchestration seams.
          integrationComplexity: run.rootRuntime === "atomic" ? 8 : 5,
        },
        updatedAt: this.now().toISOString(),
      });
      Object.assign(candidate, finalized);
    }
    const finalCandidates = await this.store.listComparisonCandidates(comparisonId);
    if (comparison.status === "running" && finalCandidates.length === 2 && finalCandidates.every((candidate) => candidate.status !== "running")) {
      comparison = await this.store.completeComparison(
        comparison.id,
        finalCandidates.every((candidate) => candidate.metrics?.correctness === "passed") ? "complete" : "failed",
        this.now().toISOString(),
      );
    }
    return { comparison, candidates: finalCandidates };
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

  async cancelRun(runId: string, resolvedBy = "authenticated-control-plane-client") {
    const run = await this.requireRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return this.getRun(runId);
    if (this.atomicFixturePilot?.isPilotRun(run)) {
      await this.atomicFixturePilot.cancel(run);
      return this.getRun(runId);
    }
    if (this.atomicModelPilot?.isPilotRun(run)) {
      await this.atomicModelPilot.cancel(run, resolvedBy);
      return this.getRun(runId);
    }
    if (this.directModelPilot?.isPilotRun(run)) {
      await this.directModelPilot.cancel(run, resolvedBy);
      return this.getRun(runId);
    }
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

  async resolveAtomicFixtureApproval(approvalId: string, decision: string, resolvedBy = "wesley") {
    const approval = await this.store.getApproval(approvalId);
    if (!approval || approval.action !== "accept_atomic_fixture_result") {
      throw new Error("Approval is not the evidence-bound Atomic fixture final gate");
    }
    return this.resolveApproval(approvalId, decision, resolvedBy);
  }

  async resolveAtomicModelFixtureApproval(approvalId: string, decision: string, resolvedBy = "authenticated-operator") {
    const approval = await this.store.getApproval(approvalId);
    if (!approval || approval.action !== ATOMIC_MODEL_PILOT_APPROVAL_ACTION) {
      throw new Error("Approval is not the evidence-bound Atomic model fixture final gate");
    }
    return this.resolveApproval(approvalId, decision, resolvedBy);
  }

  async resolveDirectCodexFixtureApproval(approvalId: string, decision: string, resolvedBy = "authenticated-operator") {
    const approval = await this.store.getApproval(approvalId);
    if (!approval || approval.action !== DIRECT_CODEX_APPROVAL_ACTION) {
      throw new Error("Approval is not the evidence-bound direct Codex fixture final gate");
    }
    return this.resolveApproval(approvalId, decision, resolvedBy);
  }

  async readAtomicFixtureArtifact(runId: string, artifactId: string) {
    if (!this.atomicFixturePilot) throw new Error("Atomic fixture pilot is disabled");
    return this.atomicFixturePilot.readApprovalArtifact(runId, artifactId);
  }

  async readAtomicModelFixtureArtifact(runId: string, artifactId: string) {
    if (!this.atomicModelPilot) throw new Error("Atomic model pilot is disabled");
    return this.atomicModelPilot.readApprovalArtifact(runId, artifactId);
  }

  async readDirectCodexFixtureArtifact(runId: string, artifactId: string) {
    if (!this.directModelPilot) throw new Error("Direct Codex model pilot is disabled");
    return this.directModelPilot.readApprovalArtifact(runId, artifactId);
  }

  private async resolveApprovalOnce(approvalId: string, decision: string, resolvedBy: string) {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error("Approval not found");
    const run = await this.requireRun(approval.runId);
    if (approval.action === "accept_atomic_fixture_result") {
      if (!this.atomicFixturePilot || !this.atomicFixturePilot.isPilotRun(run)) {
        throw new Error("Atomic fixture approval cannot be resolved while its pilot is disabled");
      }
      await this.atomicFixturePilot.resolveApproval(
        approval,
        decision as "approve" | "deny" | "request_changes",
        resolvedBy,
      );
      return this.getRun(run.id);
    }
    if (approval.action === ATOMIC_MODEL_PILOT_APPROVAL_ACTION) {
      if (!this.atomicModelPilot || !this.atomicModelPilot.isPilotRun(run)) {
        throw new Error("Atomic model approval cannot be resolved while its pilot is disabled");
      }
      await this.atomicModelPilot.resolveApproval(
        approval,
        decision as "approve" | "deny" | "request_changes",
        resolvedBy,
      );
      return this.getRun(run.id);
    }
    if (approval.action === DIRECT_CODEX_APPROVAL_ACTION) {
      if (!this.directModelPilot || !this.directModelPilot.isPilotRun(run)) {
        throw new Error("Direct Codex approval cannot be resolved while its pilot is disabled");
      }
      await this.directModelPilot.resolveApproval(
        approval,
        decision as "approve" | "deny" | "request_changes",
        resolvedBy,
      );
      return this.getRun(run.id);
    }
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
    return {
      projectId,
      query,
      provider: this.brainReads.metadata,
      mode: this.brainReads.mode,
      results: await this.brainReads.search(project, query),
      usage: this.brainReads.usage,
    };
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

  async previewMemoryPromotion(proposalId: string): Promise<PromotionPreview> {
    const proposal = await this.store.getMemoryProposal(proposalId);
    if (!proposal) throw new Error("Memory proposal not found");
    if (proposal.state !== "proposed") throw new Error("Memory proposal has already been resolved");
    const project = await this.requireProject(proposal.projectId);
    return this.brain.previewPromotion(project, {
      proposalId: proposal.id,
      claim: proposal.claim,
      evidence: proposal.evidence,
      approvedBy: "wesley",
      approvedAt: this.now().toISOString(),
    });
  }

  async resolveMemoryProposal(proposalId: string, decision: string, preview?: PromotionPreview) {
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
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
      throw new Error("Memory promotion requires the exact reviewed preview");
    }
    if (preview.approvedBy !== "wesley" || typeof preview.approvedAt !== "string") {
      throw new Error("Memory promotion preview reviewer or timestamp is invalid");
    }
    const approvedAtMs = Date.parse(preview.approvedAt);
    const nowMs = this.now().getTime();
    if (!Number.isFinite(approvedAtMs) || !Number.isFinite(nowMs)) {
      throw new Error("Memory promotion preview timestamp or control-plane clock is invalid");
    }
    if (approvedAtMs - nowMs > MEMORY_PROMOTION_PREVIEW_MAX_FUTURE_SKEW_MS) {
      throw new Error("Memory promotion preview timestamp exceeds the allowed future clock skew");
    }
    if (nowMs - approvedAtMs > MEMORY_PROMOTION_PREVIEW_MAX_AGE_MS) {
      throw new Error("Memory promotion preview has expired; generate and review a fresh preview");
    }
    const expected = this.brain.previewPromotion(project, {
      proposalId: proposal.id,
      claim: proposal.claim,
      evidence: proposal.evidence,
      approvedBy: "wesley",
      approvedAt: preview.approvedAt,
    });
    if (canonicalJson(preview) !== canonicalJson(expected)) {
      throw new Error("Memory promotion preview does not exactly match the reviewed proposal");
    }
    const target = this.brain.promote(project, expected);
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
    let nativeOrphansFailed = 0;
    let strictWriterLeasesQuarantined = 0;
    let leaseReconciliationConflicts = 0;
    const quarantinedLeasesAwaitingOperator = candidates.quarantinedLeases.length;
    const released = new Set<string>();

    const settleTerminalLease = async (
      workspaceId: string,
      runId: string,
      reason: string,
    ): Promise<"released" | "quarantined" | "absent" | "conflict"> => {
      const lease = await this.store.getWorkspaceLease(workspaceId);
      if (!lease) return "absent";
      if (lease.runId !== runId) return "conflict";
      if (lease.state === "quarantined") return "quarantined";
      const workspace = await this.store.getWorkspace(workspaceId);
      const compatibilityLease = lease.ownerId === runId && workspace?.provider !== "isolated-git-worktree";
      if (compatibilityLease) {
        return await this.workspaces.releaseFence(lease) ? "released" : "conflict";
      }
      const quarantined = await this.store.quarantineWorkspaceLease({
        workspaceId: lease.workspaceId,
        runId: lease.runId,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        quarantinedAt: nowIso(),
        reason,
      });
      return quarantined ? "quarantined" : "conflict";
    };

    const recordSettlement = (workspaceId: string, result: "released" | "quarantined" | "absent" | "conflict") => {
      if (result === "released") {
        released.add(workspaceId);
        terminalLeasesReleased += 1;
      } else if (result === "quarantined") {
        released.add(workspaceId);
        strictWriterLeasesQuarantined += 1;
      } else if (result === "conflict") {
        leaseReconciliationConflicts += 1;
      }
    };

    for (const run of candidates.queuedRuns) {
      if (this.atomicFixturePilot?.isPilotRun(run) || this.atomicModelPilot?.isPilotRun(run) || this.directModelPilot?.isPilotRun(run)) continue;
      const completedAt = nowIso();
      await this.store.updateRun(run.id, {
        status: "failed",
        stage: "startup_reconciliation",
        completedAt,
        nextActionAt: null,
        metadata: { ...run.metadata, reconciliationReason: "runtime_start_not_confirmed" },
      });
      if (run.workspaceId) {
        recordSettlement(run.workspaceId, await settleTerminalLease(
          run.workspaceId,
          run.id,
          "queued_writer_requires_provider_reconciliation",
        ));
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

    const nativeOrphans = (await this.store.listRuns()).filter((run) =>
      ["running", "paused", "awaiting_approval"].includes(run.status)
      && run.metadata.adapter === "native"
      && run.metadata.crossProcessResume !== true,
    ).filter((run) => !this.atomicFixturePilot?.isPilotRun(run) && !this.atomicModelPilot?.isPilotRun(run) && !this.directModelPilot?.isPilotRun(run));
    for (const run of nativeOrphans) {
      const completedAt = nowIso();
      await this.store.updateRun(run.id, {
        status: "failed",
        stage: "native_restart_not_resumable",
        completedAt,
        nextActionAt: null,
        metadata: { ...run.metadata, reconciliationReason: "native_process_lost_cross_process_resume_false" },
      });
      if (run.workspaceId) {
        recordSettlement(run.workspaceId, await settleTerminalLease(
          run.workspaceId,
          run.id,
          "native_writer_requires_provider_reconciliation",
        ));
      }
      await this.store.appendEvent({
        id: id("event"),
        runId: run.id,
        type: "run.failed",
        message: "Startup reconciliation failed a native run that cannot resume across processes",
        payload: { reconciliation: true, reason: "native_process_lost_cross_process_resume_false" },
        createdAt: completedAt,
      });
      nativeOrphansFailed += 1;
    }

    for (const lease of candidates.terminalLeases) {
      if (released.has(lease.workspaceId)) continue;
      recordSettlement(lease.workspaceId, await settleTerminalLease(
        lease.workspaceId,
        lease.runId,
        "terminal_writer_requires_provider_reconciliation",
      ));
    }

    for (const candidateLease of candidates.expiredLeases) {
      if (released.has(candidateLease.workspaceId)) continue;
      const lease = await this.store.getWorkspaceLease(candidateLease.workspaceId);
      if (!lease || lease.state !== "active" || Date.parse(lease.expiresAt) > Date.now()) continue;
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
      const quarantined = await this.store.quarantineWorkspaceLease({
        workspaceId: lease.workspaceId,
        runId: lease.runId,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        quarantinedAt: completedAt,
        reason: "writer_lease_expired_during_startup_reconciliation",
      });
      if (!quarantined) {
        throw new Error(`Expired writer lease ${lease.workspaceId} changed before quarantine`);
      }
      released.add(lease.workspaceId);
    }

    const reconciliationTime = Date.now();
    const activeLeases = await this.store.listLeases();
    for (const { approval, run: candidateRun } of candidates.strandedApprovals) {
      if (approval.action === "accept_atomic_fixture_result" && this.atomicFixturePilot?.isPilotRun(candidateRun)) {
        strandedApprovalsAlreadySettled += 1;
        continue;
      }
      if (approval.action === ATOMIC_MODEL_PILOT_APPROVAL_ACTION && this.atomicModelPilot?.isPilotRun(candidateRun)) {
        strandedApprovalsAlreadySettled += 1;
        continue;
      }
      if (approval.action === DIRECT_CODEX_APPROVAL_ACTION && this.directModelPilot?.isPilotRun(candidateRun)) {
        strandedApprovalsAlreadySettled += 1;
        continue;
      }
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
      nativeOrphansFailed,
      quarantinedLeasesAwaitingOperator,
      pendingOutbox: candidates.pendingOutbox.length,
      strictWriterLeasesQuarantined,
      leaseReconciliationConflicts,
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
    let firstError: unknown = null;
    try {
      await this.atomicFixturePilot?.tick();
    } catch (error) {
      firstError = error;
    }
    try {
      await this.atomicModelPilot?.tick();
      await this.directModelPilot?.tick();
    } catch (error) {
      firstError ??= error;
    }
    if (this.externalFinalActions) {
      try {
        const pending = await this.externalFinalActions.listPlans({ state: "pending_approval", limit: 100 });
        for (const plan of pending) {
          if (Date.parse(plan.expiresAt) <= this.now().getTime()) {
            await this.externalFinalActions.expireApproval({ planId: plan.id });
          }
        }
        await this.externalFinalActions.processOneAuthorizedDelivery();
      } catch (error) {
        firstError ??= error;
      }
    }
    const now = this.now();
    let runs: Run[] = [];
    try {
      runs = await this.store.claimRunnableRuns(
        now.toISOString(),
        new Date(now.getTime() + 30_000).toISOString(),
        this.workerId,
      );
    } catch (error) {
      firstError ??= error;
    }
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

  private requireExternalFinalActions(): ExternalFinalActionCoordinator {
    if (!this.externalFinalActions) throw new Error("External final actions are disabled");
    return this.externalFinalActions;
  }

  private async readConnectorAuthority(project: Project, task: Task | null): Promise<{
    linear: { status: string; [key: string]: unknown };
    git: { status: string; [key: string]: unknown };
  }> {
    const policy = this.connectors?.policyForProject(project.id);
    const linearGateway = this.connectors?.linearForProject(project.id);
    let linear: { status: string; [key: string]: unknown } = {
      status: policy?.linear ? "unavailable" : "prototype",
      taskSource: task?.source ?? "none",
      note: policy?.linear
        ? "An accepted Linear mapping exists, but its live authority gateway is unavailable."
        : "Current task data is a local projection; no accepted production Linear mapping is configured.",
    };
    if (policy?.linear && linearGateway) {
      try {
        const projectSnapshot = await linearGateway.readProject();
        await this.persistAuthorityBinding({
          provider: "linear",
          localKind: "project",
          localId: project.id,
          externalKind: "project",
          externalId: projectSnapshot.externalId,
          revision: projectSnapshot.revision,
          observedAt: projectSnapshot.observedAt,
          payloadHash: projectSnapshot.payloadHash,
          freshUntil: new Date(Date.parse(projectSnapshot.observedAt) + 5 * 60_000).toISOString(),
        });
        let taskRevision: string | null = null;
        let taskExternalId: string | null = null;
        if (task?.sourceId) {
          const taskSnapshot = await linearGateway.readIssue(task.sourceId);
          taskRevision = taskSnapshot.revision;
          taskExternalId = taskSnapshot.externalId;
          await this.persistAuthorityBinding({
            provider: "linear",
            localKind: "task",
            localId: task.id,
            externalKind: "issue",
            externalId: taskSnapshot.externalId,
            revision: taskSnapshot.revision,
            observedAt: taskSnapshot.observedAt,
            payloadHash: taskSnapshot.payloadHash,
            freshUntil: new Date(Date.parse(taskSnapshot.observedAt) + 5 * 60_000).toISOString(),
          });
        }
        linear = {
          status: "revision-bound",
          taskSource: task?.source ?? "none",
          projectExternalId: projectSnapshot.externalId,
          projectRevision: projectSnapshot.revision,
          taskExternalId,
          taskRevision,
          observedAt: projectSnapshot.observedAt,
          freshUntil: new Date(Date.parse(projectSnapshot.observedAt) + 5 * 60_000).toISOString(),
          payloadHash: projectSnapshot.payloadHash,
        };
      } catch (error) {
        linear = {
          status: "unavailable",
          taskSource: task?.source ?? "none",
          errorCode: this.safeConnectorErrorCode(error, "LINEAR_AUTHORITY_UNAVAILABLE"),
          note: "Linear authority could not be verified; no provider payload was retained.",
        };
      }
    }

    const gitAuthority = this.connectors?.gitForProject(project.id);
    let git: { status: string; [key: string]: unknown } = {
      status: policy?.git ? "unavailable" : "unavailable",
      repository: project.repository,
      note: policy?.git
        ? "An accepted Git policy exists, but its revision could not be inspected."
        : "No accepted deterministic Git execution policy is configured.",
    };
    if (policy?.git && gitAuthority) {
      try {
        const snapshot = await gitAuthority.read();
        const payloadHash = requestHash({
          repositoryIdentity: snapshot.repositoryIdentity,
          baseRef: snapshot.baseRef,
          baseCommit: snapshot.baseCommit,
          baseTree: snapshot.baseTree,
          headRef: snapshot.headRef,
          headCommit: snapshot.headCommit,
          headTree: snapshot.headTree,
          patchDigest: snapshot.patchDigest,
          checkPolicyDigest: snapshot.checkPolicyDigest,
          policyDigest: snapshot.policyDigest,
        });
        await this.persistAuthorityBinding({
          provider: "git",
          localKind: "project",
          localId: project.id,
          externalKind: "repository",
          externalId: snapshot.repositoryIdentity,
          revision: snapshot.headCommit,
          observedAt: snapshot.observedAt,
          payloadHash,
          freshUntil: new Date(Date.parse(snapshot.observedAt) + 5 * 60_000).toISOString(),
        });
        git = {
          status: "revision-bound",
          repository: snapshot.repositoryIdentity,
          baseRef: snapshot.baseRef,
          baseCommit: snapshot.baseCommit,
          headRef: snapshot.headRef,
          headCommit: snapshot.headCommit,
          patchDigest: snapshot.patchDigest,
          checkPolicyDigest: snapshot.checkPolicyDigest,
          policyDigest: snapshot.policyDigest,
          observedAt: snapshot.observedAt,
          freshUntil: new Date(Date.parse(snapshot.observedAt) + 5 * 60_000).toISOString(),
          payloadHash,
        };
      } catch (error) {
        git = {
          status: "unavailable",
          repository: project.repository,
          errorCode: this.safeConnectorErrorCode(error, "GIT_AUTHORITY_UNAVAILABLE"),
          note: "Git authority could not be verified; no command output or filesystem path was retained.",
        };
      }
    }
    return { linear, git };
  }

  private async persistAuthorityBinding(binding: AuthorityBinding): Promise<void> {
    const existing = await this.store.getAuthorityBinding(binding.provider, binding.localKind, binding.localId);
    if (!existing) {
      await this.store.createAuthorityBinding(binding);
      return;
    }
    if (canonicalJson(existing) === canonicalJson(binding)) return;
    if (existing.externalKind !== (binding.externalKind ?? null) || existing.externalId !== binding.externalId) {
      throw new Error("External authority identity changed and requires explicit operator reconciliation");
    }
    await this.store.refreshAuthorityBinding({
      ...binding,
      expectedExternalKind: existing.externalKind,
      expectedExternalId: existing.externalId,
      expectedRevision: existing.revision,
      expectedPayloadHash: existing.payloadHash,
    });
  }

  private safeConnectorErrorCode(error: unknown, fallback: string): string {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && /^[A-Z][A-Z0-9_.:-]{0,127}$/u.test(code) ? code : fallback;
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

  private async createRuntimeContextArtifacts(
    project: Project,
    task: Task | null,
    run: Run,
    objective: string,
    workspacePath: string,
    workspace: RunBundleResult["workspace"],
    lease: RunBundleResult["lease"],
  ) {
    if (!workspace || !lease) throw new Error("Run bundle did not persist its workspace and writer lease");
    const root = resolve(workspacePath);
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Native runtime workspace must be a regular non-symlink directory");
    }
    const realRoot = realpathSync(root);
    const directory = resolve(root, ".control-plane");
    if (directory === root || !directory.startsWith(`${root}${sep}`)) {
      throw new Error("Native runtime context directory escaped the owned workspace");
    }
    if (!existsSync(directory)) mkdirSync(directory);
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Native runtime context directory must be a regular non-symlink directory");
    }
    const realDirectory = realpathSync(directory);
    if (!realDirectory.startsWith(`${realRoot}${sep}`)) {
      throw new Error("Native runtime context directory realpath escaped the owned workspace");
    }

    const pack = await this.brainReads.buildContextPack(project, objective, { runId: run.id, ...(task ? { taskId: task.id } : {}) });
    const contextBody = canonicalJson(pack);
    const contextChecksum = contextPackChecksum(pack);
    const contextPath = join(directory, "context-pack.json");
    writeFileSync(contextPath, contextBody, { encoding: "utf8", flag: "wx" });

    const contract = {
      schemaVersion: "1.0.0",
      runId: run.id,
      projectId: project.id,
      taskId: task?.id ?? null,
      taskSourceId: task?.sourceId ?? null,
      request: objective,
      rootRuntime: run.rootRuntime,
      workflow: run.workflow,
      contextPack: { uri: contextPath, checksum: contextChecksum },
      budget: { currency: "USD", maxCostUsd: run.budgetUsd, enforcement: "runtime-specific; wall-clock bound always applies to native connectivity runs" },
      finalAction: "analysis_only",
      workspace: { owner: "control-plane", id: workspace.id, path: workspace.path, provider: workspace.provider },
      writerLease: {
        holderRunId: lease.runId,
        workspaceId: lease.workspaceId,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        mode: lease.mode,
        state: lease.state,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
      },
      approvalBoundary: "No PR, merge, deployment, destructive database change, secret expansion, or canonical-memory promotion.",
      authorities: {
        roadmap: "Linear (not live in this prototype)",
        implementation: "Git/GitHub and executable checks",
        rationale: "Accepted canonical Project Brain Markdown",
      },
      automaticEpisodicCapture: false,
    };
    const contractBody = canonicalJson(contract);
    const contractChecksum = createHash("sha256").update(contractBody).digest("hex");
    const contractPath = join(directory, "run-contract.json");
    writeFileSync(contractPath, contractBody, { encoding: "utf8", flag: "wx" });

    const createdAt = nowIso();
    const artifacts: Artifact[] = [
      { id: id("artifact"), runId: run.id, kind: "project-brain-context-pack", uri: contextPath, checksum: contextChecksum, mediaType: "application/json", createdAt },
      { id: id("artifact"), runId: run.id, kind: "run-contract", uri: contractPath, checksum: contractChecksum, mediaType: "application/json", createdAt },
    ];
    for (const artifact of artifacts) await this.store.createArtifact(artifact);
    const runtimeRun: Run = {
      ...run,
      metadata: {
        ...run.metadata,
        contextPackRef: contextPath,
        contextPackChecksum: contextChecksum,
        runContractRef: contractPath,
        runContractChecksum: contractChecksum,
        finalAction: "analysis_only",
      },
    };
    await this.store.updateRun(run.id, { metadata: runtimeRun.metadata });
    return {
      run: runtimeRun,
      contextPack: { path: contextPath, uri: contextPath, checksum: contextChecksum },
      runContract: { path: contractPath, uri: contractPath, checksum: contractChecksum },
    };
  }
}
