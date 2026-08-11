import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Project } from "./types.ts";
import { nowIso } from "./ids.ts";

export interface MemoryResult {
  source: string;
  authority: "canonical" | "advisory";
  score: number;
  title: string;
  excerpt: string;
  updatedAt?: string;
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(path);
  }
  return result;
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3);
}

function titleFrom(content: string, path: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? basename(path, ".md");
}

export class LocalProjectBrain {
  private root: string;
  constructor(root: string) { this.root = root; }

  search(project: Project, query: string, limit = 6): MemoryResult[] {
    const candidates = [join(this.root, project.vaultPath), join(this.root, "Shared")]
      .flatMap((p) => walkMarkdown(p));
    const queryWords = words(query);
    return candidates.map((path) => {
      const content = readFileSync(path, "utf8");
      const lower = content.toLowerCase();
      const title = titleFrom(content, path);
      let score = 0;
      for (const word of queryWords) {
        if (title.toLowerCase().includes(word)) score += 4;
        score += Math.min(5, lower.split(word).length - 1);
      }
      const body = content.replace(/^---[\s\S]*?---\s*/m, "").replace(/\s+/g, " ").trim();
      const excerpt = body.slice(0, 340);
      return {
        source: relative(this.root, path),
        authority: content.includes("authority: canonical") ? "canonical" as const : "advisory" as const,
        score,
        title,
        excerpt
      };
    }).filter((r) => r.score > 0 || query.trim() === "")
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  acceptedDecisions(project: Project, limit = 5): MemoryResult[] {
    return this.search(project, "decision accepted architecture constraint", 20)
      .filter((r) => r.authority === "canonical" && r.source.includes("Decisions"))
      .slice(0, limit);
  }

  promote(project: Project, proposalId: string, claim: string, evidence: string[]): string {
    const dir = join(this.root, project.vaultPath, "Decisions");
    mkdirSync(dir, { recursive: true });
    const safe = proposalId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = join(dir, `${safe}.md`);
    const content = `---\nid: ${safe}\ntype: decision\nstatus: accepted\nauthority: canonical\nproject: ${project.id}\napproved_by: wesley\napproved_at: ${nowIso()}\n---\n# Decision\n\n${claim}\n\n## Evidence\n\n${evidence.map((e) => `- ${e}`).join("\n") || "- Reviewed from the linked run."}\n`;
    writeFileSync(path, content, "utf8");
    return relative(this.root, path);
  }
}
