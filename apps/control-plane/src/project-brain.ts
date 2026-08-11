import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Project } from "./types.ts";
import { nowIso } from "./ids.ts";
import { canonicalJson } from "./store.ts";

const MAX_NOTE_BYTES = 256_000;
const MAX_CONTEXT_ENTRIES = 10;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_EXCERPT_CHARS = 1_600;

export interface MemoryResult {
  source: string;
  authority: "canonical" | "advisory";
  score: number;
  title: string;
  excerpt: string;
  status?: string;
  contentHash?: string;
}

export interface ProjectContextPack {
  schemaVersion: "1.0.0";
  runId: string;
  projectId: string;
  taskId: string | null;
  objective: string;
  authorityRule: string;
  automaticEpisodicCapture: false;
  limits: { maxEntries: number; maxCharacters: number; excerptCharacters: number };
  entries: Array<MemoryResult & { authority: "canonical"; status: "accepted"; contentHash: string }>;
}

export interface PromotionPreview {
  projectId: string;
  proposalId: string;
  target: string;
  path: string;
  content: string;
  contentHash: string;
  previewHash: string;
  approvedBy: string;
  approvedAt: string;
}

interface ParsedNote {
  path: string;
  source: string;
  title: string;
  body: string;
  frontmatter: Record<string, string | string[]>;
  contentHash: string;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseScalar(value: string): string | string[] {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  return trimmed;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string | string[]>; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { frontmatter: {}, body: content };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (/^[a-z0-9_-]+$/.test(key)) frontmatter[key] = parseScalar(line.slice(separator + 1));
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

function scalar(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function list(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && lstatSync(path).size <= MAX_NOTE_BYTES) result.push(path);
  }
  return result;
}

function words(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length >= 3))];
}

function titleFrom(content: string, path: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path, ".md");
}

function excerpt(body: string, max = MAX_EXCERPT_CHARS): string {
  return body.replace(/\s+/g, " ").trim().slice(0, max);
}

export function contextPackChecksum(pack: ProjectContextPack): string {
  return sha(canonicalJson(pack));
}

export class LocalProjectBrain {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  search(project: Project, query: string, limit = 6): MemoryResult[] {
    const queryWords = words(query);
    return this.retrievableNotes(project).map((note) => {
      const authority = scalar(note.frontmatter.authority) === "canonical" ? "canonical" as const : "advisory" as const;
      const lower = `${note.title}\n${note.body}`.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (note.title.toLowerCase().includes(word)) score += 4;
        score += Math.min(5, lower.split(word).length - 1);
      }
      if (authority === "canonical" && scalar(note.frontmatter.status) === "accepted") score += 2;
      return {
        source: note.source,
        authority,
        status: scalar(note.frontmatter.status) || undefined,
        score,
        title: note.title,
        excerpt: excerpt(note.body, 340),
        contentHash: note.contentHash,
      };
    }).filter((result) => result.score > 0 || query.trim() === "")
      .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
      .slice(0, limit);
  }

  acceptedDecisions(project: Project, limit = 5): MemoryResult[] {
    return this.search(project, "", 100)
      .filter((result) => result.authority === "canonical" && result.status === "accepted" && result.source.split(/[\\/]/).includes("Decisions"))
      .slice(0, limit);
  }

  buildContextPack(
    project: Project,
    objective: string,
    options: { runId: string; taskId?: string },
  ): ProjectContextPack {
    const accepted = this.acceptedCanonicalNotes(project);
    const queryWords = words(objective);
    const ranked = accepted.map((note) => {
      const lower = `${note.title}\n${note.body}`.toLowerCase();
      let lexical = 0;
      for (const word of queryWords) lexical += (note.title.toLowerCase().includes(word) ? 4 : 0) + Math.min(5, lower.split(word).length - 1);
      const type = scalar(note.frontmatter.type);
      const structural = type === "decision" ? 100 : type === "project" ? 80 : type === "policy" ? 60 : 20;
      return { note, rank: structural + lexical };
    }).sort((a, b) => b.rank - a.rank || a.note.source.localeCompare(b.note.source));

    let characters = 0;
    const entries: ProjectContextPack["entries"] = [];
    for (const { note, rank } of ranked) {
      if (entries.length >= MAX_CONTEXT_ENTRIES || characters >= MAX_CONTEXT_CHARS) break;
      const remaining = Math.min(MAX_EXCERPT_CHARS, MAX_CONTEXT_CHARS - characters);
      const body = excerpt(note.body, remaining);
      if (!body) continue;
      characters += body.length;
      entries.push({
        source: note.source,
        authority: "canonical",
        status: "accepted",
        score: rank,
        title: note.title,
        excerpt: body,
        contentHash: note.contentHash,
      });
    }
    return {
      schemaVersion: "1.0.0",
      runId: options.runId,
      projectId: project.id,
      taskId: options.taskId ?? null,
      objective,
      authorityRule: "Accepted canonical Markdown only; current Linear and Git state outrank this rationale snapshot.",
      automaticEpisodicCapture: false,
      limits: { maxEntries: MAX_CONTEXT_ENTRIES, maxCharacters: MAX_CONTEXT_CHARS, excerptCharacters: MAX_EXCERPT_CHARS },
      entries,
    };
  }

  previewPromotion(
    project: Project,
    input: { proposalId: string; claim: string; evidence: string[]; approvedBy?: string; approvedAt?: string },
  ): PromotionPreview {
    const proposalId = input.proposalId.trim();
    const safe = proposalId.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!safe || safe !== proposalId) throw new Error("Memory proposal ID is not safe for a canonical note filename");
    const approvedBy = (input.approvedBy ?? "wesley").trim();
    const approvedAt = input.approvedAt ?? nowIso();
    if (!approvedBy || !Number.isFinite(Date.parse(approvedAt))) throw new Error("Promotion reviewer and timestamp are required");
    const target = join(project.vaultPath, "Decisions", `${safe}.md`).split(sep).join("/");
    const path = this.containedPath(target);
    const content = `---\nid: ${safe}\ntype: decision\nstatus: accepted\nauthority: canonical\nproject: ${project.id}\napproved_by: ${approvedBy}\napproved_at: ${approvedAt}\n---\n# Decision\n\n${input.claim.trim()}\n\n## Evidence\n\n${input.evidence.map((item) => `- ${item}`).join("\n") || "- Reviewed from the linked proposal."}\n`;
    const contentHash = sha(content);
    const previewHash = sha(canonicalJson({ projectId: project.id, proposalId, target, contentHash, approvedBy, approvedAt }));
    return { projectId: project.id, proposalId, target, path, content, contentHash, previewHash, approvedBy, approvedAt };
  }

  promote(project: Project, preview: PromotionPreview): string {
    if (preview.projectId !== project.id) throw new Error("Promotion preview belongs to another project");
    const path = this.containedPath(preview.target);
    if (resolve(preview.path) !== path || sha(preview.content) !== preview.contentHash) throw new Error("Promotion preview content or path changed after review");
    const expectedPreviewHash = sha(canonicalJson({
      projectId: preview.projectId,
      proposalId: preview.proposalId,
      target: preview.target,
      contentHash: preview.contentHash,
      approvedBy: preview.approvedBy,
      approvedAt: preview.approvedAt,
    }));
    if (expectedPreviewHash !== preview.previewHash) throw new Error("Promotion preview hash is invalid");
    mkdirSync(resolve(path, ".."), { recursive: true });
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") === preview.content) return preview.target;
      throw new Error("Canonical promotion target already exists with different content");
    }
    writeFileSync(path, preview.content, { encoding: "utf8", flag: "wx" });
    return preview.target;
  }

  private notes(project: Project): ParsedNote[] {
    const dirs = [this.containedPath(project.vaultPath), this.containedPath("Shared")];
    return dirs.flatMap((dir) => walkMarkdown(dir)).map((path) => {
      const raw = readFileSync(path, "utf8");
      const parsed = parseFrontmatter(raw);
      return {
        path,
        source: relative(this.root, path).split(sep).join("/"),
        title: titleFrom(parsed.body, path),
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        contentHash: sha(raw),
      };
    });
  }

  private acceptedCanonicalNotes(project: Project): ParsedNote[] {
    const notes = this.notes(project).filter((note) =>
      scalar(note.frontmatter.authority) === "canonical"
      && scalar(note.frontmatter.status) === "accepted"
      && [project.id, "shared"].includes(scalar(note.frontmatter.project)),
    );
    const superseded = new Set(notes.flatMap((note) => list(note.frontmatter.supersedes)));
    return notes.filter((note) => !superseded.has(scalar(note.frontmatter.id)));
  }

  private retrievableNotes(project: Project): ParsedNote[] {
    const notes = this.notes(project).filter((note) =>
      [project.id, "shared"].includes(scalar(note.frontmatter.project)),
    );
    const superseded = new Set(notes
      .filter((note) => scalar(note.frontmatter.authority) === "canonical" && scalar(note.frontmatter.status) === "accepted")
      .flatMap((note) => list(note.frontmatter.supersedes)));
    const suppressedStates = new Set(["superseded", "rejected", "deprecated", "stale"]);
    return notes.filter((note) =>
      !suppressedStates.has(scalar(note.frontmatter.status))
      && !superseded.has(scalar(note.frontmatter.id)),
    );
  }

  private containedPath(relativePath: string): string {
    if (!relativePath || resolve(relativePath) === relativePath) throw new Error("Project Brain paths must be non-empty and relative");
    const path = resolve(this.root, relativePath);
    if (path === this.root || !path.startsWith(`${this.root}${sep}`)) throw new Error("Project Brain path escaped the configured root");
    let existingAncestor = existsSync(path) ? path : dirname(path);
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error("Project Brain path has no existing contained ancestor");
      existingAncestor = parent;
    }
    const realRoot = realpathSync(this.root);
    const realAncestor = realpathSync(existingAncestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${sep}`)) {
      throw new Error("Project Brain realpath escaped the configured root");
    }
    return path;
  }
}
