import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createGitAuthorityPolicy,
  type GitAuthorityPolicy,
  type GitCheckPolicy,
} from "./git-authority.ts";
import type { LinearAuthorityPolicy } from "./linear-authority.ts";

const MAX_POLICY_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type LinearConnectorMode = "disabled" | "read-only" | "read-write";
export type GithubConnectorMode = "disabled" | "read-only" | "draft-pr";

export interface ConnectorProjectPolicy {
  readonly projectId: string;
  readonly linear?: LinearAuthorityPolicy;
  readonly linearEvidenceIssueId?: string;
  readonly git?: GitAuthorityPolicy;
  readonly github?: {
    readonly owner: string;
    readonly repo: string;
    readonly baseRef: string;
    readonly headRef: string;
  };
}

export interface ConnectorPolicy {
  readonly schemaVersion: "1.0.0";
  readonly digest: string;
  readonly sourcePath: string;
  readonly projects: ReadonlyMap<string, ConnectorProjectPolicy>;
}

interface PolicyLoadInput {
  path: string;
  acceptedSha256: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function boundedText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (!SAFE_ID.test(text)) throw new Error(`${label} must be a safe ID`);
  return text;
}

function providerId(value: unknown, label: string): string {
  const text = boundedText(value, label, 256);
  if (!SAFE_PROVIDER_ID.test(text)) throw new Error(`${label} must be a safe provider ID`);
  return text;
}

function repositoryPart(value: unknown, label: string): string {
  const text = boundedText(value, label, 100);
  if (!SAFE_REPOSITORY_PART.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function parseLinear(value: unknown): LinearAuthorityPolicy {
  const item = record(value, "Linear connector policy");
  exactKeys(item, ["teamId", "projectId", "evidenceIssueId"], "Linear connector policy");
  return Object.freeze({
    teamId: providerId(item.teamId, "Linear team ID"),
    projectId: providerId(item.projectId, "Linear project ID"),
  });
}

function parseCheck(value: unknown): GitCheckPolicy {
  const item = record(value, "Git check policy");
  exactKeys(item, ["id", "executable", "argv", "maxOutputBytes"], "Git check policy");
  const executable = boundedText(item.executable, "Git check executable", 1_024);
  if (!isAbsolute(executable)) throw new Error("Git check executable must be absolute");
  let argv: string[] | undefined;
  if (item.argv !== undefined) {
    if (!Array.isArray(item.argv) || item.argv.length > 32) throw new Error("Git check argv must contain at most 32 values");
    argv = item.argv.map((argument, index) => boundedText(argument, `Git check argv[${index}]`, 512));
  }
  return Object.freeze({
    id: safeId(item.id, "Git check ID"),
    executable: resolve(executable),
    ...(argv ? { argv: Object.freeze(argv) } : {}),
    ...(item.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: positiveInteger(item.maxOutputBytes, "Git check maxOutputBytes", 8 * 1024 * 1024) }),
  });
}

function parseProject(value: unknown, policyDirectory: string): ConnectorProjectPolicy {
  const item = record(value, "Connector project policy");
  exactKeys(item, ["projectId", "linear", "git", "github"], "Connector project policy");
  const projectId = safeId(item.projectId, "Connector project ID");
  const linearItem = item.linear === undefined ? undefined : record(item.linear, "Linear connector policy");
  const linear = linearItem === undefined ? undefined : parseLinear(linearItem);
  const linearEvidenceIssueId = linearItem?.evidenceIssueId === undefined
    ? undefined
    : providerId(linearItem.evidenceIssueId, "Linear evidence issue ID");
  const githubItem = item.github === undefined ? undefined : record(item.github, "GitHub connector policy");
  if (githubItem) exactKeys(githubItem, ["owner", "repo", "baseRef", "headRef"], "GitHub connector policy");
  const github = githubItem ? Object.freeze({
    owner: repositoryPart(githubItem.owner, "GitHub owner"),
    repo: repositoryPart(githubItem.repo, "GitHub repository"),
    baseRef: boundedText(githubItem.baseRef, "GitHub base ref", 255),
    headRef: boundedText(githubItem.headRef, "GitHub head ref", 255),
  }) : undefined;

  let git: GitAuthorityPolicy | undefined;
  if (item.git !== undefined) {
    const gitItem = record(item.git, "Git authority policy");
    exactKeys(gitItem, ["repositoryPath", "baseRef", "headRef", "checks", "policyVersion"], "Git authority policy");
    const repositoryPathText = boundedText(gitItem.repositoryPath, "Git repository path", 4_096);
    if (!isAbsolute(repositoryPathText)) throw new Error("Git repository path must be absolute");
    if (!Array.isArray(gitItem.checks) || gitItem.checks.length < 1 || gitItem.checks.length > 32) {
      throw new Error("Git authority policy requires 1 to 32 checks");
    }
    if (!github) throw new Error("Git authority policy requires a matching GitHub repository policy");
    git = createGitAuthorityPolicy({
      projectId,
      repositoryPath: resolve(policyDirectory, repositoryPathText),
      repositoryOwner: github.owner,
      repositoryName: github.repo,
      baseRef: boundedText(gitItem.baseRef, "Git base ref", 255),
      headRef: boundedText(gitItem.headRef, "Git head ref", 255),
      checkPolicy: gitItem.checks.map(parseCheck),
      ...(gitItem.policyVersion === undefined
        ? {}
        : { policyVersion: safeId(gitItem.policyVersion, "Git policy version") }),
    });
    if (git.baseRef !== github.baseRef || git.headRef !== github.headRef) {
      throw new Error("Git and GitHub base/head refs must match exactly");
    }
  }

  if (!linear && !git && !github) throw new Error("Connector project policy has no authority source");
  return Object.freeze({
    projectId,
    ...(linear ? { linear } : {}),
    ...(linearEvidenceIssueId ? { linearEvidenceIssueId } : {}),
    ...(git ? { git } : {}),
    ...(github ? { github } : {}),
  });
}

function readPolicyFile(path: string): { path: string; bytes: Buffer } {
  if (!isAbsolute(path)) throw new Error("M7 connector policy path must be absolute");
  const requested = resolve(path);
  const status = lstatSync(requested);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("M7 connector policy must be a regular non-symlink file");
  if (status.size < 2 || status.size > MAX_POLICY_BYTES) throw new Error("M7 connector policy size is invalid");
  const parent = realpathSync(dirname(requested));
  const real = realpathSync(requested);
  if (!real.startsWith(`${parent}/`)) throw new Error("M7 connector policy escaped its parent directory");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== status.size || opened.size > MAX_POLICY_BYTES) {
      throw new Error("M7 connector policy changed while opening");
    }
    return { path: real, bytes: readFileSync(descriptor) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadConnectorPolicy(input: PolicyLoadInput): ConnectorPolicy {
  if (!SHA256.test(input.acceptedSha256)) throw new Error("M7 connector accepted policy digest must be lowercase SHA-256");
  const file = readPolicyFile(input.path);
  const digest = createHash("sha256").update(file.bytes).digest("hex");
  if (digest !== input.acceptedSha256) throw new Error("M7 connector policy digest does not match the accepted digest");
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); }
  catch { throw new Error("M7 connector policy must contain valid UTF-8 JSON"); }
  const root = record(parsed, "M7 connector policy");
  exactKeys(root, ["schemaVersion", "projects"], "M7 connector policy");
  if (root.schemaVersion !== "1.0.0") throw new Error("M7 connector policy schemaVersion must be 1.0.0");
  if (!Array.isArray(root.projects) || root.projects.length < 1 || root.projects.length > 64) {
    throw new Error("M7 connector policy must contain 1 to 64 projects");
  }
  const projects = new Map<string, ConnectorProjectPolicy>();
  for (const item of root.projects) {
    const project = parseProject(item, dirname(file.path));
    if (projects.has(project.projectId)) throw new Error("M7 connector policy contains a duplicate project ID");
    projects.set(project.projectId, project);
  }
  return Object.freeze({
    schemaVersion: "1.0.0" as const,
    digest,
    sourcePath: file.path,
    projects,
  });
}
