import {
  contextPackChecksum,
  type LocalProjectBrain,
  type MemoryResult,
  type ProjectContextPack,
} from "./project-brain.ts";
import type { Project } from "./types.ts";

/**
 * The read boundary deliberately contains only the three operations needed by
 * the control plane.  There is no promotion, write, capture, or filesystem
 * operation on this interface.
 */
export type ProjectBrainProviderMode =
  | "local-markdown-readonly"
  | "openviking-readonly-candidate";

export interface ProjectBrainProviderInfo {
  providerId: string;
  mode: ProjectBrainProviderMode;
  revision: string;
}

export interface ProjectBrainUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface ProjectBrainReadProvider {
  readonly providerId: string;
  readonly mode: ProjectBrainProviderMode;
  readonly revision: string;
  readonly metadata: ProjectBrainProviderInfo;

  /** Read-only lexical retrieval scoped to the supplied project. */
  search(project: Project, query: string, limit?: number): Promise<MemoryResult[]>;

  /** Read-only retrieval of accepted canonical decision notes. */
  acceptedDecisions(project: Project, limit?: number): Promise<MemoryResult[]>;

  /** Build a bounded, canonical-only context pack. */
  buildContextPack(
    project: Project,
    objective: string,
    options: { runId: string; taskId?: string },
  ): Promise<ProjectContextPack>;

  /** Usage is observational evidence and is never part of the context pack. */
  readonly usage: ProjectBrainUsage;
}

const ZERO_USAGE: ProjectBrainUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  calls: 0,
});

function copyUsage(usage: ProjectBrainUsage): ProjectBrainUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    calls: usage.calls,
  };
}

/**
 * Adapter for the existing local Markdown implementation.  The constructor
 * accepts the already-created read implementation rather than a caller path;
 * callers cannot redirect this provider to an arbitrary directory.
 */
export class LocalProjectBrainProvider implements ProjectBrainReadProvider {
  readonly providerId = "local-markdown";
  readonly mode = "local-markdown-readonly" as const;
  readonly revision: string;
  private readonly brain: Pick<LocalProjectBrain, "search" | "acceptedDecisions" | "buildContextPack">;

  constructor(
    brain: Pick<LocalProjectBrain, "search" | "acceptedDecisions" | "buildContextPack">,
    options: { revision?: string } = {},
  ) {
    this.brain = brain;
    this.revision = options.revision ?? "local-markdown-v1";
  }

  get metadata(): ProjectBrainProviderInfo {
    return { providerId: this.providerId, mode: this.mode, revision: this.revision };
  }

  get usage(): ProjectBrainUsage {
    return ZERO_USAGE;
  }

  async search(project: Project, query: string, limit?: number): Promise<MemoryResult[]> {
    return this.brain.search(project, query, limit);
  }

  async acceptedDecisions(project: Project, limit?: number): Promise<MemoryResult[]> {
    return this.brain.acceptedDecisions(project, limit);
  }

  async buildContextPack(
    project: Project,
    objective: string,
    options: { runId: string; taskId?: string },
  ): Promise<ProjectContextPack> {
    return this.brain.buildContextPack(project, objective, options);
  }
}

/** Alias that makes the active backend explicit at call sites. */
export const LocalMarkdownProjectBrainProvider = LocalProjectBrainProvider;

export interface OpenVikingSearchRequest {
  /** Fixed namespace selected by the provider's allowlist. */
  namespace: string;
  /** The project ID selected by the control plane, not a caller namespace. */
  projectId: string;
  query: string;
  limit: number;
}

export interface OpenVikingUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Accepted only as transport aliases; the provider normalizes to camelCase. */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}

/**
 * A deliberately small transport contract.  An OpenViking SDK/client may be
 * supplied later, but it must first reduce its response to this bounded shape.
 * No URL, filesystem path, credential, or arbitrary namespace is accepted.
 */
export interface OpenVikingSearchResponse {
  hits: readonly OpenVikingHit[];
  usage: OpenVikingUsage;
  /** Optional response revision; provider revision remains the stable metadata field. */
  revision?: string;
}

export interface OpenVikingTransport {
  search(request: OpenVikingSearchRequest): Promise<OpenVikingSearchResponse>;
}

/**
 * Explicit metadata required to revalidate a candidate hit before it can be
 * returned or placed in a canonical context pack.  `content` and `excerpt`
 * are alternatives because a remote index may retain either full bounded text
 * or an excerpt; at least one is required at runtime.
 */
export interface OpenVikingHit {
  id: string;
  projectId: string;
  namespace: string;
  source: string;
  title?: string;
  content?: string;
  excerpt?: string;
  authority: "canonical" | "advisory";
  status: string;
  contentHash: string;
  type?: string;
  supersedes?: readonly string[];
  score?: number;
}

export type ProjectNamespaceAllowlist =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export interface OpenVikingProjectBrainProviderOptions {
  transport: OpenVikingTransport;
  /**
   * Immutable project ID → namespace mapping.  The provider never consults
   * `Project.memoryNamespace`, and callers cannot select a namespace per read.
   */
  namespaces: ProjectNamespaceAllowlist;
  /** Candidate behavior is disabled unless explicitly enabled by configuration. */
  enabled?: boolean;
  revision?: string;
  maxHits?: number;
}

export class ProjectBrainProviderError extends Error {
  readonly code:
    | "disabled"
    | "namespace_not_allowed"
    | "invalid_response"
    | "invalid_hit"
    | "invalid_usage";

  constructor(
    code: ProjectBrainProviderError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProjectBrainProviderError";
    this.code = code;
  }
}

const MAX_QUERY_CHARS = 2_000;
const MAX_SOURCE_CHARS = 512;
const MAX_TITLE_CHARS = 512;
const MAX_EXCERPT_CHARS = 1_600;
const MAX_CONTENT_HASH_CHARS = 256;
const MAX_HIT_ID_CHARS = 256;
const MAX_STATUS_CHARS = 128;
const DEFAULT_MAX_HITS = 50;
const MAX_ALLOWED_HITS = 100;
const MAX_CONTEXT_ENTRIES = 10;
const MAX_CONTEXT_CHARS = 12_000;
const CONTEXT_EXCERPT_CHARS = 1_600;
const SUPPRESSED_STATES = new Set(["superseded", "rejected", "deprecated", "stale"]);

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function safeLimit(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new ProjectBrainProviderError("invalid_response", "Project Brain read limit must be a positive integer");
  }
  return Math.min(candidate, maximum);
}

function words(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length >= 3))];
}

function sourceLooksBounded(source: string): boolean {
  if (!source || source.length > MAX_SOURCE_CHARS || source.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(source)) return false;
  const pieces = source.split(/[\\/]/);
  return !pieces.includes("..") && !pieces.includes("") && !pieces.includes(".");
}

function namespaceLooksBounded(namespace: string): boolean {
  if (!namespace || namespace.length > 512 || namespace.startsWith("/") || namespace.includes("\\")) return false;
  const pieces = namespace.split("/");
  return !pieces.includes("..") && !pieces.includes("") && !pieces.includes(".");
}

function normalizedAllowlist(input: ProjectNamespaceAllowlist): ReadonlyMap<string, string> {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  const result = new Map<string, string>();
  for (const [projectId, namespace] of entries) {
    if (!boundedText(projectId, 256) || !boundedText(namespace, 512) || !namespaceLooksBounded(namespace)) {
      throw new ProjectBrainProviderError("namespace_not_allowed", "OpenViking namespace allowlist is invalid");
    }
    if (result.has(projectId)) throw new ProjectBrainProviderError("namespace_not_allowed", "OpenViking namespace allowlist contains a duplicate project");
    result.set(projectId, namespace);
  }
  return result;
}

function copyHitText(hit: OpenVikingHit): { title: string; excerpt: string } | null {
  const title = boundedText(hit.title ?? "", MAX_TITLE_CHARS) ?? boundedText(hit.id, MAX_TITLE_CHARS);
  const raw = hit.excerpt ?? hit.content;
  const excerpt = boundedText(raw, MAX_EXCERPT_CHARS);
  if (!title || !excerpt) return null;
  return { title, excerpt };
}

interface ValidatedHit extends OpenVikingHit {
  title: string;
  excerpt: string;
  supersedes: readonly string[];
}

function validateHit(
  hit: OpenVikingHit,
  projectId: string,
  namespaces: ReadonlyMap<string, string>,
): ValidatedHit | null {
  if (!hit || typeof hit !== "object") return null;
  const id = boundedText(hit.id, MAX_HIT_ID_CHARS);
  const owner = boundedText(hit.projectId, 256);
  const namespace = boundedText(hit.namespace, 512);
  const source = boundedText(hit.source, MAX_SOURCE_CHARS);
  const status = boundedText(hit.status, MAX_STATUS_CHARS)?.toLowerCase();
  const contentHash = boundedText(hit.contentHash, MAX_CONTENT_HASH_CHARS);
  if (!id || !owner || !namespace || !source || !status || !contentHash || !sourceLooksBounded(source)) return null;
  if (owner !== projectId && owner !== "shared") return null;
  const expectedNamespace = namespaces.get(owner);
  if (!expectedNamespace || expectedNamespace !== namespace) return null;
  if (hit.authority !== "canonical" && hit.authority !== "advisory") return null;
  if (hit.score !== undefined && (!Number.isFinite(hit.score) || hit.score < 0 || hit.score > 1_000_000)) return null;
  const text = copyHitText(hit);
  if (!text) return null;
  const supersedes = hit.supersedes ?? [];
  if (!Array.isArray(supersedes) || supersedes.length > 100) return null;
  const normalizedSupersedes = supersedes.map((item) => boundedText(item, MAX_HIT_ID_CHARS));
  if (normalizedSupersedes.some((item) => !item)) return null;
  return {
    ...hit,
    id,
    projectId: owner,
    namespace,
    source,
    status,
    contentHash,
    title: text.title,
    excerpt: text.excerpt,
    supersedes: normalizedSupersedes as string[],
  };
}

function scoreHit(hit: ValidatedHit, query: string): number {
  const queryWords = words(query);
  const lower = `${hit.title}\n${hit.excerpt}`.toLowerCase();
  let score = typeof hit.score === "number" ? hit.score : 0;
  for (const word of queryWords) {
    if (hit.title.toLowerCase().includes(word)) score += 4;
    score += Math.min(5, lower.split(word).length - 1);
  }
  if (hit.authority === "canonical" && hit.status === "accepted") score += 2;
  return score;
}

function isDecision(hit: ValidatedHit): boolean {
  return hit.type === "decision" || hit.source.split(/[\\/]/).includes("Decisions");
}

function memoryResult(hit: ValidatedHit, score: number): MemoryResult {
  return {
    source: hit.source,
    authority: hit.authority,
    score,
    title: hit.title,
    excerpt: hit.excerpt.slice(0, 340),
    status: hit.status || undefined,
    contentHash: hit.contentHash,
  };
}

function contextEntry(hit: ValidatedHit, score: number, remaining: number): ProjectContextPack["entries"][number] | null {
  const body = hit.excerpt.replace(/\s+/g, " ").trim().slice(0, Math.min(CONTEXT_EXCERPT_CHARS, remaining));
  if (!body) return null;
  return {
    source: hit.source,
    authority: "canonical",
    status: "accepted",
    score,
    title: hit.title,
    excerpt: body,
    contentHash: hit.contentHash,
  };
}

function validateUsage(usage: OpenVikingUsage): ProjectBrainUsage {
  const inputTokens = usage?.inputTokens ?? usage?.prompt_tokens;
  const outputTokens = usage?.outputTokens ?? usage?.completion_tokens;
  const costUsd = usage?.costUsd ?? usage?.cost_usd;
  if (!usage || typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0
    || typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0
    || typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new ProjectBrainProviderError("invalid_usage", "OpenViking response omitted bounded non-negative usage");
  }
  const normalizedInputTokens = inputTokens as number;
  const normalizedOutputTokens = outputTokens as number;
  const normalizedCostUsd = costUsd as number;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? normalizedInputTokens + normalizedOutputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0 || totalTokens !== normalizedInputTokens + normalizedOutputTokens) {
    throw new ProjectBrainProviderError("invalid_usage", "OpenViking response token total is inconsistent");
  }
  return {
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens,
    costUsd: normalizedCostUsd,
    calls: 1,
  };
}

function addUsage(left: ProjectBrainUsage, right: ProjectBrainUsage): ProjectBrainUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    calls: left.calls + right.calls,
  };
}

/**
 * Read-only, default-off OpenViking candidate.  Every transport response is
 * revalidated against the fixed namespace map before it leaves this class.
 */
export class OpenVikingProjectBrainProvider implements ProjectBrainReadProvider {
  readonly providerId = "openviking";
  readonly mode = "openviking-readonly-candidate" as const;
  readonly revision: string;
  readonly enabled: boolean;
  private readonly transport: OpenVikingTransport;
  private readonly namespaces: ReadonlyMap<string, string>;
  private readonly maxHits: number;
  private usageState: ProjectBrainUsage = copyUsage(ZERO_USAGE);

  constructor(options: OpenVikingProjectBrainProviderOptions) {
    if (!options || !options.transport || typeof options.transport.search !== "function") {
      throw new ProjectBrainProviderError("invalid_response", "OpenViking requires an injected bounded transport");
    }
    this.transport = options.transport;
    this.namespaces = normalizedAllowlist(options.namespaces);
    this.maxHits = safeLimit(options.maxHits, DEFAULT_MAX_HITS, MAX_ALLOWED_HITS);
    this.enabled = options.enabled === true;
    this.revision = options.revision ?? "openviking-readonly-v1";
  }

  get metadata(): ProjectBrainProviderInfo {
    return { providerId: this.providerId, mode: this.mode, revision: this.revision };
  }

  get usage(): ProjectBrainUsage {
    return copyUsage(this.usageState);
  }

  /** Test/evaluation helper; it resets only observational counters. */
  resetUsage(): void {
    this.usageState = copyUsage(ZERO_USAGE);
  }

  async search(project: Project, query: string, limit?: number): Promise<MemoryResult[]> {
    const hits = await this.fetch(project, query, limit);
    const ranked = this.rankAndSuppress(hits, query);
    return ranked.slice(0, safeLimit(limit, 6, this.maxHits)).map(({ hit, score }) => memoryResult(hit, score));
  }

  async acceptedDecisions(project: Project, limit?: number): Promise<MemoryResult[]> {
    const requested = safeLimit(limit, 5, this.maxHits);
    const ranked = this.rankAndSuppress(await this.fetch(project, "", this.maxHits), "")
      .filter(({ hit }) => hit.authority === "canonical" && hit.status === "accepted" && isDecision(hit));
    return ranked.slice(0, requested).map(({ hit, score }) => memoryResult(hit, score));
  }

  async buildContextPack(
    project: Project,
    objective: string,
    options: { runId: string; taskId?: string },
  ): Promise<ProjectContextPack> {
    const ranked = this.rankAndSuppress(await this.fetch(project, objective, this.maxHits), objective)
      .filter(({ hit }) => hit.authority === "canonical" && hit.status === "accepted")
      .map(({ hit }) => {
        const lexical = scoreHit(hit, objective);
        const structural = hit.type === "decision" || isDecision(hit)
          ? 100
          : hit.type === "project"
            ? 80
            : hit.type === "policy"
              ? 60
              : 20;
        return { hit, score: structural + lexical };
      })
      .sort((a, b) => b.score - a.score || a.hit.source.localeCompare(b.hit.source));

    let characters = 0;
    const entries: ProjectContextPack["entries"] = [];
    for (const { hit, score } of ranked) {
      if (entries.length >= MAX_CONTEXT_ENTRIES || characters >= MAX_CONTEXT_CHARS) break;
      const remaining = MAX_CONTEXT_CHARS - characters;
      const entry = contextEntry(hit, score, remaining);
      if (!entry) continue;
      characters += entry.excerpt.length;
      entries.push(entry);
    }
    return {
      schemaVersion: "1.0.0",
      runId: options.runId,
      projectId: project.id,
      taskId: options.taskId ?? null,
      objective,
      authorityRule: "Accepted canonical Markdown only; current Linear and Git state outrank this rationale snapshot.",
      automaticEpisodicCapture: false,
      limits: { maxEntries: MAX_CONTEXT_ENTRIES, maxCharacters: MAX_CONTEXT_CHARS, excerptCharacters: CONTEXT_EXCERPT_CHARS },
      entries,
    };
  }

  private ensureEnabled(): void {
    if (!this.enabled) {
      throw new ProjectBrainProviderError("disabled", "OpenViking Project Brain candidate is disabled by default");
    }
  }

  private namespaceFor(project: Project): string {
    const namespace = this.namespaces.get(project.id);
    if (!namespace) {
      throw new ProjectBrainProviderError("namespace_not_allowed", `Project ${project.id} has no OpenViking namespace allowlist entry`);
    }
    return namespace;
  }

  private async fetch(project: Project, query: string, limit: number | undefined): Promise<ValidatedHit[]> {
    this.ensureEnabled();
    const requested = safeLimit(limit, this.maxHits, this.maxHits);
    const namespace = this.namespaceFor(project);
    const boundedQuery = typeof query === "string" ? query.trim().slice(0, MAX_QUERY_CHARS) : "";
    const response = await this.transport.search({ namespace, projectId: project.id, query: boundedQuery, limit: requested });
    if (!response || typeof response !== "object" || !Array.isArray(response.hits) || response.hits.length > this.maxHits
      || (response.revision !== undefined && (typeof response.revision !== "string" || !boundedText(response.revision, 256)))) {
      throw new ProjectBrainProviderError("invalid_response", "OpenViking response exceeded the bounded Project Brain contract");
    }
    const usage = validateUsage(response.usage);
    this.usageState = addUsage(this.usageState, usage);
    const validated: ValidatedHit[] = [];
    const invalidIds = new Set<string>();
    const seen = new Set<string>();
    for (const candidate of response.hits) {
      const item = validateHit(candidate, project.id, this.namespaces);
      if (!item) continue;
      if (seen.has(item.id)) {
        invalidIds.add(item.id);
        continue;
      }
      seen.add(item.id);
      validated.push(item);
    }
    return validated.filter((item) => !invalidIds.has(item.id));
  }

  private rankAndSuppress(hits: readonly ValidatedHit[], query: string): Array<{ hit: ValidatedHit; score: number }> {
    const superseded = new Set<string>();
    for (const hit of hits) {
      if (hit.authority === "canonical" && hit.status === "accepted") {
        for (const id of hit.supersedes) superseded.add(id);
      }
    }
    return hits
      .filter((hit) => !SUPPRESSED_STATES.has(hit.status) && !superseded.has(hit.id))
      .map((hit) => ({ hit, score: scoreHit(hit, query) }))
      .sort((a, b) => b.score - a.score || a.hit.source.localeCompare(b.hit.source) || a.hit.id.localeCompare(b.hit.id));
  }
}

/** Alias used by call sites that emphasize candidate/read-only status. */
export const OpenVikingReadOnlyProjectBrainProvider = OpenVikingProjectBrainProvider;

export { contextPackChecksum };
