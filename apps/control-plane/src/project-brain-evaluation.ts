import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "./store.ts";
import { LocalProjectBrain, contextPackChecksum, type MemoryResult, type ProjectContextPack } from "./project-brain.ts";
import type { Project } from "./types.ts";
import type {
  ProjectBrainProviderInfo,
  ProjectBrainReadProvider,
  ProjectBrainUsage,
} from "./project-brain-provider.ts";

const FIXTURE_CREATED_AT = "2026-08-13T00:00:00.000Z";
const EVALUATION_OBJECTIVE = "deterministic evidence for the current decision";
const EVALUATION_QUERY = "deterministic evidence";
const ISOLATION_QUERY = "CROSS_PROJECT_MEMORY_SENTINEL";
const DELETION_QUERY = "DELETION_SENTINEL_CURRENT_DECISION";

export interface ProjectBrainEvaluationFixture {
  readonly root: string;
  readonly project: Project;
  readonly otherProject: Project;
  readonly brain: LocalProjectBrain;
  readonly currentDecisionSource: string;
  readonly supersededDecisionSource: string;
  readonly staleDecisionSource: string;
  readonly crossProjectSource: string;
  snapshot(): string;
  deleteCurrentDecision(): void;
  dispose(): void;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function walkFiles(root: string, dir = root): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function snapshotTree(root: string): string {
  const records = walkFiles(root).map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    content: readFileSync(path),
  }));
  return sha(records.map((record) => `${record.path}\0${record.content.toString("base64")}\0`).join(""));
}

function note(
  root: string,
  path: string,
  frontmatter: Record<string, string>,
  heading: string,
  body: string,
): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  const metadata = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n");
  writeFileSync(target, `---\n${metadata}\n---\n# ${heading}\n\n${body}\n`, "utf8");
}

/**
 * Deterministic, disposable Markdown fixture used by the retrieval harness.
 * The fixture intentionally contains project-owned, shared, stale, superseded,
 * and cross-project notes so correctness checks cannot pass on an empty vault.
 */
export function createProjectBrainEvaluationFixture(): ProjectBrainEvaluationFixture {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-project-brain-eval-"));
  const project: Project = {
    id: "brain-evaluation",
    name: "Project Brain Evaluation",
    objective: "Bounded deterministic retrieval",
    currentMilestone: "M7",
    health: "on_track",
    linearTeam: "BRAIN",
    repository: "fixture/project-brain",
    vaultPath: "Projects/BrainEvaluation",
    memoryNamespace: "projects/brain-evaluation",
    createdAt: FIXTURE_CREATED_AT,
  };
  const otherProject: Project = {
    id: "brain-other",
    name: "Other Project",
    objective: "Isolation fixture",
    currentMilestone: "M7",
    health: "on_track",
    linearTeam: "OTHER",
    repository: "fixture/other",
    vaultPath: "Projects/Other",
    memoryNamespace: "projects/other",
    createdAt: FIXTURE_CREATED_AT,
  };

  const currentDecisionSource = `${project.vaultPath}/Decisions/current.md`;
  const supersededDecisionSource = `${project.vaultPath}/Decisions/old.md`;
  const staleDecisionSource = `${project.vaultPath}/Decisions/stale.md`;
  const crossProjectSource = `${otherProject.vaultPath}/Decisions/other.md`;
  note(root, `${project.vaultPath}/Project.md`, {
    type: "project", status: "accepted", authority: "canonical", project: project.id,
  }, "Project Brain Evaluation", "Use bounded deterministic context for the current project.");
  note(root, supersededDecisionSource, {
    id: "brain-old", type: "decision", status: "accepted", authority: "canonical", project: project.id,
  }, "Old decision", "DELETION_SENTINEL_OLD_DECISION Use the superseded evidence path.");
  note(root, currentDecisionSource, {
    id: "brain-current", type: "decision", status: "accepted", authority: "canonical", project: project.id,
    supersedes: "[brain-old]",
  }, "Current deterministic decision", "DELETION_SENTINEL_CURRENT_DECISION Use deterministic evidence and a read-only provider boundary.");
  note(root, staleDecisionSource, {
    id: "brain-stale", type: "decision", status: "stale", authority: "canonical", project: project.id,
  }, "Stale decision", "STALE_SUPPRESSED_SENTINEL This stale content must not be retrieved.");
  note(root, "Shared/Policy.md", {
    type: "policy", status: "accepted", authority: "canonical", project: "shared",
  }, "Shared policy", "Never silently promote memory; current project and Git state remain authoritative.");
  note(root, crossProjectSource, {
    id: "brain-other-note", type: "decision", status: "accepted", authority: "canonical", project: otherProject.id,
  }, "Other project decision", `${ISOLATION_QUERY} This note belongs to another project and must not leak.`);
  const brain = new LocalProjectBrain(root);
  return {
    root,
    project,
    otherProject,
    brain,
    currentDecisionSource,
    supersededDecisionSource,
    staleDecisionSource,
    crossProjectSource,
    snapshot: () => snapshotTree(root),
    deleteCurrentDecision: () => unlinkSync(join(root, currentDecisionSource)),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface ProjectBrainEvaluationLatency {
  searchMs: number;
  acceptedDecisionsMs: number;
  contextPackMs: number;
  repeatedContextPackMs: number;
  deletionReadMs: number;
  totalMs: number;
}

export interface ProjectBrainEvaluationMeasurements {
  provider: ProjectBrainProviderInfo;
  isolation: {
    crossProjectHits: number;
    leakedSources: string[];
    passed: boolean;
  };
  ranking: {
    expectedSource: string;
    actualTopSource: string | null;
    hitAt: number | null;
    passed: boolean;
  };
  suppression: {
    suppressedSources: string[];
    leakedSources: string[];
    passed: boolean;
  };
  deletion: {
    deletedSource: string;
    presentBefore: boolean;
    presentAfter: boolean;
    passed: boolean;
  };
  determinism: {
    firstChecksum: string;
    repeatedChecksum: string;
    checksumsEqual: boolean;
    bytesEqual: boolean;
    passed: boolean;
  };
  readOnly: {
    beforeDigest: string;
    afterReadDigest: string;
    changed: boolean;
    passed: boolean;
  };
  latency: ProjectBrainEvaluationLatency;
  usage: ProjectBrainUsage;
  passed: boolean;
}

export interface ProjectBrainEvaluationPacks {
  beforeDeletion: ProjectContextPack;
  repeated: ProjectContextPack;
  afterDeletion: ProjectContextPack;
}

export interface ProjectBrainEvaluationPackBytes {
  beforeDeletion: string;
  repeated: string;
  afterDeletion: string;
}

export interface ProjectBrainEvaluationResult {
  measurements: ProjectBrainEvaluationMeasurements;
  /** Pack objects are separate from measurements so byte output is inspectable. */
  packs: ProjectBrainEvaluationPacks;
  /** Canonical UTF-8-ready bytes used for deterministic checksum comparison. */
  packBytes: ProjectBrainEvaluationPackBytes;
}

export interface EvaluateProjectBrainProviderOptions {
  provider: ProjectBrainReadProvider;
  fixture: ProjectBrainEvaluationFixture;
  runId?: string;
  taskId?: string;
  objective?: string;
}

function packBytes(pack: ProjectContextPack): string {
  return canonicalJson(pack);
}

function sourceList(results: readonly MemoryResult[]): string[] {
  return results.map((result) => result.source);
}

function usageOf(provider: ProjectBrainReadProvider): ProjectBrainUsage {
  const usage = provider.usage;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    calls: usage.calls,
  };
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, elapsedMs: Math.max(0, performance.now() - started) };
}

function resetUsageIfSupported(provider: ProjectBrainReadProvider): void {
  const candidate = provider as ProjectBrainReadProvider & { resetUsage?: () => void };
  if (typeof candidate.resetUsage === "function") candidate.resetUsage();
}

/**
 * Run the deterministic retrieval acceptance checks.  Latency is recorded as
 * evidence but deliberately does not participate in the correctness gate.
 */
export async function evaluateProjectBrainProvider(
  options: EvaluateProjectBrainProviderOptions,
): Promise<ProjectBrainEvaluationResult> {
  const { provider, fixture } = options;
  const runId = options.runId ?? "brain-evaluation-run";
  const taskId = options.taskId ?? "brain-evaluation-task";
  const objective = options.objective ?? EVALUATION_OBJECTIVE;
  resetUsageIfSupported(provider);
  const started = performance.now();
  const beforeDigest = fixture.snapshot();

  const search = await timed(() => provider.search(fixture.project, EVALUATION_QUERY, 10));
  const decisions = await timed(() => provider.acceptedDecisions(fixture.project, 10));
  const firstPack = await timed(() => provider.buildContextPack(fixture.project, objective, { runId, taskId }));
  const repeatedPack = await timed(() => provider.buildContextPack(fixture.project, objective, { runId, taskId }));
  const afterReadDigest = fixture.snapshot();

  const isolation = await provider.search(fixture.project, ISOLATION_QUERY, 10);
  const suppression = await provider.search(fixture.project, "STALE_SUPPRESSED_SENTINEL superseded evidence", 10);
  const suppressedSources = [fixture.supersededDecisionSource, fixture.staleDecisionSource];
  const isolationLeakedSources = sourceList(isolation).filter((source) => source === fixture.crossProjectSource);
  const suppressionLeakedSources = sourceList(suppression).filter((source) => suppressedSources.includes(source));
  const expectedSource = fixture.currentDecisionSource;
  const hitAtIndex = search.value.findIndex((result) => result.source === expectedSource);
  const decisionsHitAtIndex = decisions.value.findIndex((result) => result.source === expectedSource);
  const rankingHitAt = hitAtIndex >= 0 ? hitAtIndex + 1 : decisionsHitAtIndex >= 0 ? decisionsHitAtIndex + 1 : null;

  const presentBefore = sourceList(search.value).includes(expectedSource)
    || firstPack.value.entries.some((entry) => entry.source === expectedSource);
  fixture.deleteCurrentDecision();
  const deletionRead = await timed(() => provider.buildContextPack(fixture.project, objective, { runId, taskId }));
  const afterDeletionSearch = await provider.search(fixture.project, DELETION_QUERY, 10);
  const presentAfter = sourceList(afterDeletionSearch).includes(expectedSource)
    || deletionRead.value.entries.some((entry) => entry.source === expectedSource);

  const firstBytes = packBytes(firstPack.value);
  const repeatedBytes = packBytes(repeatedPack.value);
  const afterDeletionBytes = packBytes(deletionRead.value);
  const firstChecksum = contextPackChecksum(firstPack.value);
  const repeatedChecksum = contextPackChecksum(repeatedPack.value);
  const readOnlyChanged = beforeDigest !== afterReadDigest;
  const latency: ProjectBrainEvaluationLatency = {
    searchMs: search.elapsedMs,
    acceptedDecisionsMs: decisions.elapsedMs,
    contextPackMs: firstPack.elapsedMs,
    repeatedContextPackMs: repeatedPack.elapsedMs,
    deletionReadMs: deletionRead.elapsedMs,
    totalMs: Math.max(0, performance.now() - started),
  };
  const measurements: ProjectBrainEvaluationMeasurements = {
    provider: provider.metadata,
    isolation: {
      crossProjectHits: isolationLeakedSources.length,
      leakedSources: isolationLeakedSources,
      passed: isolationLeakedSources.length === 0,
    },
    ranking: {
      expectedSource,
      actualTopSource: search.value[0]?.source ?? null,
      hitAt: rankingHitAt,
      passed: rankingHitAt === 1,
    },
    suppression: {
      suppressedSources,
      leakedSources: suppressionLeakedSources,
      passed: suppressionLeakedSources.length === 0,
    },
    deletion: {
      deletedSource: expectedSource,
      presentBefore,
      presentAfter,
      passed: presentBefore && !presentAfter,
    },
    determinism: {
      firstChecksum,
      repeatedChecksum,
      checksumsEqual: firstChecksum === repeatedChecksum,
      bytesEqual: firstBytes === repeatedBytes,
      passed: firstChecksum === repeatedChecksum && firstBytes === repeatedBytes,
    },
    readOnly: {
      beforeDigest,
      afterReadDigest,
      changed: readOnlyChanged,
      passed: !readOnlyChanged,
    },
    latency,
    usage: usageOf(provider),
    passed: false,
  };
  measurements.passed = [
    measurements.isolation.passed,
    measurements.ranking.passed,
    measurements.suppression.passed,
    measurements.deletion.passed,
    measurements.determinism.passed,
    measurements.readOnly.passed,
  ].every(Boolean);
  return {
    measurements,
    packs: { beforeDeletion: firstPack.value, repeated: repeatedPack.value, afterDeletion: deletionRead.value },
    packBytes: { beforeDeletion: firstBytes, repeated: repeatedBytes, afterDeletion: afterDeletionBytes },
  };
}

/** Stable names used by tests and handoff scripts. */
export const runProjectBrainEvaluation = evaluateProjectBrainProvider;
export const createProjectBrainEvaluationFixtureForTests = createProjectBrainEvaluationFixture;
