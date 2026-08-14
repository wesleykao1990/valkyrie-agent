import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { canonicalJson } from "./store.ts";

const SAFE_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_FILES = 8_000;
const MAX_SOURCE_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SKILLS = 256;
const IGNORED_SOURCE_NAMES = new Set([".git", ".DS_Store", "node_modules"]);
export const MANAGED_SKILL_MANIFEST_DIALECT = "skill-frontmatter-v1" as const;

export type ManagedSkillRuntime = "codex" | "claude-code" | "atomic" | "hermes";
export type ManagedSkillRuntimeMode = "native" | "delegated" | "request-only";
export type ManagedSkillTrustProfile = "restricted-advisory" | "trusted-development";
export type ManagedSkillCapability =
  | "filesystem-read"
  | "filesystem-write"
  | "shell"
  | "public-network"
  | "browser"
  | "subagents"
  | "human-input"
  | "external-action"
  | "credentials"
  | "host-administration"
  | "self-update";

export interface ManagedSkillRuntimeGrant {
  runtime: ManagedSkillRuntime;
  mode: ManagedSkillRuntimeMode;
}

export interface ManagedSkillCapabilityOverride {
  skill: string;
  capabilities: ManagedSkillCapability[];
  reason: string;
}

export interface ManagedSkillSuitePolicy {
  schemaVersion: "1.1.0";
  suiteId: string;
  displayName: string;
  version: string;
  source: {
    kind: "local-directory";
    path: string;
    expectedSha256: string;
  };
  trustProfile: ManagedSkillTrustProfile;
  projects: string[];
  runtimes: ManagedSkillRuntimeGrant[];
  telemetry: "disabled";
  updates: "manual" | "reviewed-compatible";
  allowCapabilityExpansion: boolean;
  manifestDialect: typeof MANAGED_SKILL_MANIFEST_DIALECT;
  capabilityOverrides: ManagedSkillCapabilityOverride[];
}

export interface ManagedSkillDescriptor {
  name: string;
  relativePath: string;
  version: string | null;
  description: string | null;
  manifestDialect: typeof MANAGED_SKILL_MANIFEST_DIALECT;
  authoritySource: "tools" | "allowed-tools" | "policy-override" | "unresolved";
  authorityIssues: string[];
  declaredTools: string[];
  unclassifiedTools: string[];
  requiredCapabilities: ManagedSkillCapability[];
  digest: string;
  compatible: boolean;
  blockedCapabilities: ManagedSkillCapability[];
}

export interface ManagedSkillSuiteInspection {
  suiteId: string;
  version: string;
  treeSha256: string;
  fileCount: number;
  totalBytes: number;
  skills: ManagedSkillDescriptor[];
  requiredCapabilities: ManagedSkillCapability[];
  warnings: string[];
}

export interface ManagedSkillSuiteRecord extends ManagedSkillSuiteInspection {
  displayName: string;
  trustProfile: ManagedSkillTrustProfile;
  projects: string[];
  runtimes: ManagedSkillRuntimeGrant[];
  telemetry: "disabled";
  updates: "manual" | "reviewed-compatible";
  manifestDialect: typeof MANAGED_SKILL_MANIFEST_DIALECT;
  capabilityOverrides: ManagedSkillCapabilityOverride[];
  installedAt: string;
  objectRef: string;
  state: "active" | "installed" | "quarantined";
  expansion: ManagedSkillCapability[];
}

export interface ManagedSkillCapabilityPack {
  schemaVersion: "1.1.0";
  projectId: string;
  runtime: ManagedSkillRuntime;
  runtimeMode: ManagedSkillRuntimeMode;
  suiteId: string;
  suiteVersion: string;
  suiteSha256: string;
  manifestDialect: typeof MANAGED_SKILL_MANIFEST_DIALECT;
  objectRef: string;
  skills: Array<{
    name: string;
    relativePath: string;
    digest: string;
    requiredCapabilities: ManagedSkillCapability[];
  }>;
  requiredCapabilities: ManagedSkillCapability[];
  telemetry: "disabled";
  finalActionsRemainControlPlaneGated: true;
  manifestSha256: string;
}

export interface ManagedSkillSuiteStatusRecord {
  suiteId: string;
  displayName: string;
  version: string;
  treeSha256: string;
  fileCount: number;
  totalBytes: number;
  trustProfile: ManagedSkillTrustProfile;
  projects: string[];
  runtimes: ManagedSkillRuntimeGrant[];
  telemetry: "disabled";
  updates: "manual" | "reviewed-compatible";
  manifestDialect: typeof MANAGED_SKILL_MANIFEST_DIALECT | null;
  installedAt: string;
  objectRef: string;
  state: "active" | "installed" | "quarantined";
  expansion: ManagedSkillCapability[];
  requiredCapabilities: ManagedSkillCapability[];
  warnings: string[];
  skills: Array<{
    name: string;
    version: string | null;
    digest: string;
    requiredCapabilities: ManagedSkillCapability[];
    compatible: boolean;
    blockedCapabilities: ManagedSkillCapability[];
    hasUnclassifiedTools: boolean;
    hasAuthorityIssues: boolean;
  }>;
}

interface SourceFile {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  executable: boolean;
  digest: string;
}

interface Catalog {
  schemaVersion: "1.0.0";
  active: Record<string, string>;
  records: Record<string, ManagedSkillSuiteRecord>;
}

const EMPTY_CATALOG: Catalog = { schemaVersion: "1.0.0", active: {}, records: {} };

const PROFILE_CAPABILITIES: Record<ManagedSkillTrustProfile, ReadonlySet<ManagedSkillCapability>> = {
  "restricted-advisory": new Set(["filesystem-read", "human-input"]),
  "trusted-development": new Set([
    "filesystem-read",
    "filesystem-write",
    "shell",
    "public-network",
    "browser",
    "subagents",
    "human-input",
  ]),
};

const MANAGED_SKILL_CAPABILITIES = new Set<ManagedSkillCapability>([
  "filesystem-read",
  "filesystem-write",
  "shell",
  "public-network",
  "browser",
  "subagents",
  "human-input",
  "external-action",
  "credentials",
  "host-administration",
  "self-update",
]);

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function assertSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe lowercase ID`);
  return value;
}

function assertBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, accepted: readonly string[], label: string): void {
  const keys = new Set(accepted);
  if (Object.keys(value).some((key) => !keys.has(key)) || accepted.some((key) => !(key in value))) {
    throw new Error(`${label} must contain exactly: ${accepted.join(", ")}`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function validatePolicy(value: unknown): ManagedSkillSuitePolicy {
  const policy = object(value, "Managed skill-suite policy");
  assertExactKeys(policy, [
    "schemaVersion", "suiteId", "displayName", "version", "source", "trustProfile",
    "projects", "runtimes", "telemetry", "updates", "allowCapabilityExpansion",
    "manifestDialect", "capabilityOverrides",
  ], "Managed skill-suite policy");
  if (policy.schemaVersion !== "1.1.0") throw new Error("Managed skill-suite policy schemaVersion is unsupported");
  const suiteId = assertSafeId(policy.suiteId, "suiteId");
  const displayName = assertBoundedString(policy.displayName, "displayName", 160);
  if (typeof policy.version !== "string" || !SAFE_VERSION.test(policy.version)) throw new Error("Managed skill-suite version is invalid");
  const source = object(policy.source, "Managed skill-suite source");
  assertExactKeys(source, ["kind", "path", "expectedSha256"], "Managed skill-suite source");
  if (source.kind !== "local-directory" || typeof source.path !== "string" || !isAbsolute(source.path)) {
    throw new Error("Managed skill-suite source must be an absolute local directory");
  }
  if (typeof source.expectedSha256 !== "string" || !SHA256.test(source.expectedSha256)) {
    throw new Error("Managed skill-suite source expectedSha256 is invalid");
  }
  if (policy.trustProfile !== "restricted-advisory" && policy.trustProfile !== "trusted-development") {
    throw new Error("Managed skill-suite trustProfile is unsupported");
  }
  if (!Array.isArray(policy.projects) || policy.projects.length < 1 || policy.projects.length > 128) {
    throw new Error("Managed skill-suite projects must be a bounded nonempty array");
  }
  const projects = sortedUnique(policy.projects.map((item) => assertSafeId(item, "project ID")));
  if (projects.length !== policy.projects.length) throw new Error("Managed skill-suite projects contain duplicates");
  if (!Array.isArray(policy.runtimes) || policy.runtimes.length < 1 || policy.runtimes.length > 4) {
    throw new Error("Managed skill-suite runtimes must be a bounded nonempty array");
  }
  const seenRuntimes = new Set<string>();
  const runtimes = policy.runtimes.map((item, index) => {
    const grant = object(item, `Managed skill-suite runtime ${index}`);
    assertExactKeys(grant, ["runtime", "mode"], `Managed skill-suite runtime ${index}`);
    if (grant.runtime !== "codex" && grant.runtime !== "claude-code" && grant.runtime !== "atomic" && grant.runtime !== "hermes") {
      throw new Error("Managed skill-suite runtime is unsupported");
    }
    if (grant.mode !== "native" && grant.mode !== "delegated" && grant.mode !== "request-only") {
      throw new Error("Managed skill-suite runtime mode is unsupported");
    }
    if ((grant.runtime === "codex" || grant.runtime === "claude-code") && grant.mode !== "native") {
      throw new Error("Codex and Claude Code managed skill suites require native mode");
    }
    if (grant.runtime === "atomic" && grant.mode !== "delegated") {
      throw new Error("Atomic receives managed third-party skills only through delegated specialists");
    }
    if (grant.runtime === "hermes" && grant.mode !== "request-only") {
      throw new Error("Hermes receives only request-level managed suite access");
    }
    if (seenRuntimes.has(grant.runtime)) throw new Error("Managed skill-suite runtimes contain duplicates");
    seenRuntimes.add(grant.runtime);
    return { runtime: grant.runtime, mode: grant.mode } as ManagedSkillRuntimeGrant;
  });
  if (policy.telemetry !== "disabled") throw new Error("Managed skill-suite telemetry must remain disabled in M8a");
  if (policy.updates !== "manual" && policy.updates !== "reviewed-compatible") {
    throw new Error("Managed skill-suite update policy is unsupported");
  }
  if (typeof policy.allowCapabilityExpansion !== "boolean") throw new Error("allowCapabilityExpansion must be boolean");
  if (policy.manifestDialect !== MANAGED_SKILL_MANIFEST_DIALECT) {
    throw new Error("Managed skill-suite manifestDialect is unsupported");
  }
  if (!Array.isArray(policy.capabilityOverrides) || policy.capabilityOverrides.length > MAX_SKILLS) {
    throw new Error("Managed skill-suite capabilityOverrides must be a bounded array");
  }
  const seenOverrides = new Set<string>();
  const capabilityOverrides = policy.capabilityOverrides.map((item, index) => {
    const override = object(item, `Managed skill-suite capability override ${index}`);
    assertExactKeys(override, ["skill", "capabilities", "reason"], `Managed skill-suite capability override ${index}`);
    const skill = assertSafeId(override.skill, "Capability override skill");
    if (seenOverrides.has(skill)) throw new Error("Managed skill-suite capabilityOverrides contain duplicate skills");
    seenOverrides.add(skill);
    if (!Array.isArray(override.capabilities) || override.capabilities.length < 1
        || override.capabilities.length > MANAGED_SKILL_CAPABILITIES.size) {
      throw new Error("Capability override capabilities must be a bounded nonempty array");
    }
    const capabilities = sortedUnique(override.capabilities.map((capability) => {
      if (typeof capability !== "string" || !MANAGED_SKILL_CAPABILITIES.has(capability as ManagedSkillCapability)) {
        throw new Error("Capability override contains an unsupported capability");
      }
      return capability as ManagedSkillCapability;
    }));
    if (capabilities.length !== override.capabilities.length) {
      throw new Error("Capability override capabilities contain duplicates");
    }
    return {
      skill,
      capabilities,
      reason: assertBoundedString(override.reason, "Capability override reason", 500),
    };
  });
  return {
    schemaVersion: "1.1.0",
    suiteId,
    displayName,
    version: policy.version,
    source: { kind: "local-directory", path: resolve(source.path), expectedSha256: source.expectedSha256 },
    trustProfile: policy.trustProfile,
    projects,
    runtimes,
    telemetry: "disabled",
    updates: policy.updates,
    allowCapabilityExpansion: policy.allowCapabilityExpansion,
    manifestDialect: MANAGED_SKILL_MANIFEST_DIALECT,
    capabilityOverrides,
  };
}

export function loadManagedSkillSuitePolicy(input: { path: string; acceptedSha256: string }): ManagedSkillSuitePolicy {
  if (!isAbsolute(input.path) || !SHA256.test(input.acceptedSha256)) {
    throw new Error("Managed skill-suite policy requires an absolute path and accepted SHA-256");
  }
  const path = resolve(input.path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256_000) {
    throw new Error("Managed skill-suite policy must be a bounded regular non-symlink file");
  }
  const body = readFileSync(path);
  if (sha(body) !== input.acceptedSha256) throw new Error("Managed skill-suite policy digest does not match accepted bytes");
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new Error("Managed skill-suite policy is not valid JSON"); }
  return validatePolicy(parsed);
}

function privateDirectory(path: string): string {
  const requested = resolve(path);
  if (existsSync(requested)) {
    const metadata = lstatSync(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Managed skill-suite root must be a real directory");
  } else {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
  }
  chmodSync(requested, 0o700);
  return realpathSync(requested);
}

function sourceRoot(path: string): string {
  const requested = resolve(path);
  const metadata = lstatSync(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Managed skill-suite source must be a real directory");
  return realpathSync(requested);
}

function safeRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || value.startsWith("/")
      || Buffer.byteLength(value, "utf8") > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)
      || value.split("/").some((segment) => !segment || segment === "." || segment === ".."
        || Buffer.byteLength(segment, "utf8") > 255)) {
    throw new Error("Managed skill-suite source path escaped its root");
  }
  return value;
}

function enumerateSource(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED_SOURCE_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("Managed skill-suite source cannot contain links");
      if (metadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (!metadata.isFile()) throw new Error("Managed skill-suite source can contain only regular files and directories");
      if (metadata.nlink !== 1) throw new Error("Managed skill-suite source cannot contain hard links");
      if (metadata.size > MAX_FILE_BYTES) throw new Error("Managed skill-suite source contains an oversized file");
      totalBytes += metadata.size;
      if (totalBytes > MAX_SOURCE_BYTES || files.length + 1 > MAX_SOURCE_FILES) {
        throw new Error("Managed skill-suite source exceeds its file or byte bound");
      }
      const body = readFileSync(path);
      files.push({
        relativePath: safeRelative(root, path),
        absolutePath: path,
        bytes: metadata.size,
        executable: (metadata.mode & 0o111) !== 0,
        digest: sha(body),
      });
    }
  };
  visit(root);
  return files;
}

function treeDigest(files: readonly SourceFile[]): string {
  return sha(canonicalJson(files.map((file) => ({
    path: file.relativePath,
    bytes: file.bytes,
    executable: file.executable,
    sha256: file.digest,
  }))));
}

interface ParsedSkillManifest {
  name: string | null;
  version: string | null;
  description: string | null;
  authoritySource: "tools" | "allowed-tools" | "unresolved";
  tools: string[];
  issues: string[];
}

interface DetectedRisk {
  capabilities: ManagedSkillCapability[];
  issues: string[];
}

function normalizeAuthorityKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function authorityLikeKey(key: string): boolean {
  const normalized = normalizeAuthorityKey(key);
  return [
    "tool", "permission", "capability", "authority", "authorization",
    "network", "browser", "credential", "secret", "externalaction",
    "selfupdate", "hostadministration", "mcpserver",
  ].some((marker) => normalized.includes(marker));
}

function nestedAuthorityPaths(value: unknown, path = "", topLevel = true): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => nestedAuthorityPaths(entry, `${path}[${index}]`, false));
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const documentedTopLevel = topLevel && (key === "tools" || key === "allowed-tools");
    if (authorityLikeKey(key) && !documentedTopLevel) paths.push(childPath);
    paths.push(...nestedAuthorityPaths(child, childPath, false));
  }
  return paths;
}

function parseToolValue(value: unknown): string[] | null {
  const raw = typeof value === "string"
    ? value.split(/[\s,]+/u)
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : null;
  if (!raw) return null;
  const tools = sortedUnique(raw.map((item) => item.trim()).filter(Boolean));
  if (tools.length < 1 || tools.length > 128
      || tools.some((tool) => Buffer.byteLength(tool, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(tool))) {
    return null;
  }
  return tools;
}

function parseSkillManifest(content: string): ParsedSkillManifest {
  const unresolved: ParsedSkillManifest = {
    name: null,
    version: null,
    description: null,
    authoritySource: "unresolved",
    tools: [],
    issues: [],
  };
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  if (!match) return { ...unresolved, issues: ["missing-or-unclosed-yaml-frontmatter"] };
  const document = parseDocument(match[1], {
    schema: "core",
    version: "1.2",
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    merge: false,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    return { ...unresolved, issues: ["malformed-or-ambiguous-yaml-frontmatter"] };
  }
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { ...unresolved, issues: ["malformed-or-ambiguous-yaml-frontmatter"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...unresolved, issues: ["frontmatter-must-be-a-yaml-mapping"] };
  }
  const meta = parsed as Record<string, unknown>;
  const issues = nestedAuthorityPaths(meta).map((path) => `unsupported-authority-declaration:${path}`);
  const hasTools = Object.prototype.hasOwnProperty.call(meta, "tools");
  const hasAllowedTools = Object.prototype.hasOwnProperty.call(meta, "allowed-tools");
  let authoritySource: ParsedSkillManifest["authoritySource"] = "unresolved";
  let tools: string[] = [];
  if (hasTools && hasAllowedTools) {
    issues.push("conflicting-authority-declarations:tools+allowed-tools");
  } else if (hasTools || hasAllowedTools) {
    authoritySource = hasTools ? "tools" : "allowed-tools";
    const parsedTools = parseToolValue(meta[authoritySource]);
    if (parsedTools) tools = parsedTools;
    else issues.push(`invalid-or-empty-authority-declaration:${authoritySource}`);
  } else {
    issues.push("missing-authority-declaration");
  }
  const name = typeof meta.name === "string" ? meta.name : null;
  const version = typeof meta.version === "string" ? meta.version : null;
  const description = typeof meta.description === "string" ? meta.description : null;
  if (meta.name !== undefined && name === null) issues.push("invalid-manifest-name");
  if (meta.version !== undefined && version === null) issues.push("invalid-manifest-version");
  if (meta.description !== undefined && description === null) issues.push("invalid-manifest-description");
  return { name, version, description, authoritySource, tools, issues: sortedUnique(issues) };
}

function capabilitiesForTools(tools: readonly string[]): {
  capabilities: ManagedSkillCapability[];
  unclassifiedTools: string[];
} {
  const mapping: Record<string, ManagedSkillCapability | "no-runtime-authority"> = {
    read: "filesystem-read",
    grep: "filesystem-read",
    glob: "filesystem-read",
    write: "filesystem-write",
    edit: "filesystem-write",
    bash: "shell",
    shell: "shell",
    terminal: "shell",
    codeexecution: "shell",
    web: "public-network",
    websearch: "public-network",
    webfetch: "public-network",
    fetch: "public-network",
    fetchcontent: "public-network",
    browser: "browser",
    browseruse: "browser",
    computeruse: "browser",
    agent: "subagents",
    subagent: "subagents",
    delegation: "subagents",
    skill: "subagents",
    askuserquestion: "human-input",
    clarify: "human-input",
    github: "external-action",
    linear: "external-action",
    deploy: "external-action",
    sendmessage: "external-action",
    credential: "credentials",
    secrets: "credentials",
    hostadmin: "host-administration",
    selfupdate: "self-update",
    todoread: "no-runtime-authority",
    todowrite: "no-runtime-authority",
  };
  const capabilities: ManagedSkillCapability[] = [];
  const unclassifiedTools: string[] = [];
  for (const tool of tools) {
    const scoped = /^([A-Za-z][A-Za-z0-9_-]*)(?:\([^()\r\n]{1,240}\))?$/u.exec(tool);
    const key = scoped?.[1].toLowerCase().replace(/[^a-z0-9]/gu, "");
    const capability = key ? mapping[key] : undefined;
    if (!capability) unclassifiedTools.push(tool);
    else if (capability !== "no-runtime-authority") capabilities.push(capability);
  }
  return {
    capabilities: sortedUnique(capabilities),
    unclassifiedTools: sortedUnique(unclassifiedTools),
  };
}

function additiveTextRisk(name: string, content: string): ManagedSkillCapability[] {
  const text = `${name}\n${content.slice(0, 256_000)}`.toLowerCase();
  const capabilities: ManagedSkillCapability[] = [];
  if (/(?:^|[-_])(ship|deploy|land)(?:$|[-_])|\b(?:create|send|publish|merge|deploy)\b.{0,40}\b(?:pull request|email|message|comment|release|deployment)\b/us.test(text)) {
    capabilities.push("external-action");
  }
  if (/cookie|credential|oauth|api[_ -]?key|login|auth token|secret file/u.test(text)) capabilities.push("credentials");
  if (/^setup-|^sync-|install|admin|\bsudo\b|\b(?:brew|apt-get|npm) install\b|global install/u.test(text)) {
    capabilities.push("host-administration");
  }
  if (/upgrade|update-self|self-update|update itself/u.test(text)) capabilities.push("self-update");
  if (/```(?:bash|sh|shell)\b|\bexecute (?:the )?(?:shell )?command\b/u.test(text)) capabilities.push("shell");
  if (/\b(?:web search|web browser|public network|https?:\/\/|fetch url)\b/u.test(text)) capabilities.push("public-network");
  if (/\b(?:browser automation|browser control|playwright|puppeteer)\b/u.test(text)) capabilities.push("browser");
  return sortedUnique(capabilities);
}

function sourceFileRisk(files: readonly SourceFile[]): DetectedRisk {
  const capabilities: ManagedSkillCapability[] = [];
  const issues: string[] = [];
  for (const file of files) {
    const path = file.relativePath.toLowerCase();
    const name = basename(path);
    const body = readFileSync(file.absolutePath, "utf8").slice(0, 256_000);
    if (file.executable) capabilities.push("shell");
    if (/^(?:setup|install|bootstrap|update)(?:\.[a-z0-9_-]+)?$/u.test(name)
        && /\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb|ps1)$/u.test(name)) {
      capabilities.push("shell", "host-administration");
    }
    if (/^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pyproject\.toml|poetry\.lock|gemfile|cargo\.toml|go\.mod)$/u.test(name)) {
      capabilities.push("public-network", "host-administration");
    }
    if (name === "package.json") {
      try {
        const value = JSON.parse(body) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        const scripts = (value as Record<string, unknown>).scripts;
        if (scripts !== undefined) {
          if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)
              || Object.values(scripts as Record<string, unknown>).some((script) => typeof script !== "string")) {
            issues.push(`malformed-package-scripts:${file.relativePath}`);
          } else {
            capabilities.push("shell");
            if (Object.keys(scripts as Record<string, unknown>).some((script) => /^(?:preinstall|install|postinstall|prepare|prepublish|prepublishonly)$/u.test(script))) {
              capabilities.push("host-administration");
            }
          }
        }
      } catch {
        issues.push(`malformed-package-manifest:${file.relativePath}`);
      }
    }
    if (/(?:^|\/)(?:\.mcp|mcp|mcp-servers?)\.json$/u.test(path) || /["']mcpServers["']\s*:/u.test(body)) {
      const command = /["']command["']\s*:/u.test(body);
      const network = /["'](?:url|endpoint)["']\s*:/u.test(body);
      const credentials = /["'](?:env|headers?|token|credential)["']\s*:/u.test(body);
      if (command) capabilities.push("shell");
      if (network) capabilities.push("public-network");
      if (credentials) capabilities.push("credentials");
      if (!command && !network) issues.push(`ambiguous-mcp-definition:${file.relativePath}`);
    }
  }
  return { capabilities: sortedUnique(capabilities), issues: sortedUnique(issues) };
}

function inspectFiles(policy: ManagedSkillSuitePolicy, root: string, files: SourceFile[]): ManagedSkillSuiteInspection {
  const skills: ManagedSkillDescriptor[] = [];
  const fileRisk = sourceFileRisk(files);
  for (const file of files.filter((item) => basename(item.relativePath).toLowerCase() === "skill.md")) {
    if (skills.length >= MAX_SKILLS) throw new Error("Managed skill-suite source contains too many skills");
    const content = readFileSync(file.absolutePath, "utf8");
    const manifest = parseSkillManifest(content);
    const directoryFallback = basename(dirname(file.relativePath)).toLowerCase().replace(/[^a-z0-9-]+/gu, "-");
    const fallback = SAFE_ID.test(directoryFallback) ? directoryFallback : `skill-${sha(file.relativePath).slice(0, 12)}`;
    const candidateName = manifest.name?.toLowerCase();
    const name = candidateName && SAFE_ID.test(candidateName) ? candidateName : fallback;
    if (skills.some((item) => item.name === name)) throw new Error(`Managed skill-suite contains duplicate skill ${name}`);
    const override = policy.capabilityOverrides.find((item) => item.skill === name);
    const classified = capabilitiesForTools(manifest.tools);
    const detectedCapabilities = sortedUnique([
      ...additiveTextRisk(name, content),
      ...fileRisk.capabilities,
    ]);
    const overrideCapabilities = override?.capabilities ?? [];
    const requiredCapabilities = sortedUnique([
      ...classified.capabilities,
      ...overrideCapabilities,
      ...detectedCapabilities,
    ]);
    const authorityIssues = manifest.issues.filter((issue) => !(issue === "missing-authority-declaration" && override));
    if (candidateName && !SAFE_ID.test(candidateName)) authorityIssues.push("invalid-manifest-name");
    authorityIssues.push(...fileRisk.issues);
    authorityIssues.push(...detectedCapabilities
      .filter((capability) => !classified.capabilities.includes(capability) && !overrideCapabilities.includes(capability))
      .map((capability) => `undeclared-detected-capability:${capability}`));
    if (classified.unclassifiedTools.length > 0) authorityIssues.push("unclassified-declared-tool");
    const allowed = PROFILE_CAPABILITIES[policy.trustProfile];
    const blockedCapabilities = requiredCapabilities.filter((capability) => !allowed.has(capability));
    skills.push({
      name,
      relativePath: file.relativePath,
      version: manifest.version && SAFE_VERSION.test(manifest.version) ? manifest.version : null,
      description: manifest.description ? manifest.description.slice(0, 1_000) : null,
      manifestDialect: MANAGED_SKILL_MANIFEST_DIALECT,
      authoritySource: manifest.authoritySource === "unresolved" && override ? "policy-override" : manifest.authoritySource,
      authorityIssues: sortedUnique(authorityIssues),
      declaredTools: manifest.tools,
      unclassifiedTools: classified.unclassifiedTools,
      requiredCapabilities,
      digest: file.digest,
      compatible: blockedCapabilities.length === 0 && classified.unclassifiedTools.length === 0 && authorityIssues.length === 0,
      blockedCapabilities,
    });
  }
  if (skills.length < 1) throw new Error("Managed skill-suite source contains no SKILL.md files");
  const discovered = new Set(skills.map((skill) => skill.name));
  if (policy.capabilityOverrides.some((override) => !discovered.has(override.skill))) {
    throw new Error("Managed skill-suite capability override references an undiscovered skill");
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const requiredCapabilities = sortedUnique(skills.flatMap((item) => item.requiredCapabilities));
  const warnings: string[] = [];
  if (files.some((file) => /telemetry/iu.test(readFileSync(file.absolutePath, "utf8").slice(0, 256_000)))) {
    warnings.push("Source mentions telemetry; managed execution keeps telemetry disabled");
  }
  if (skills.some((skill) => !skill.compatible)) {
    warnings.push("Some skills have unresolved authority or require operator-gated capabilities and are not eligible for an ordinary runtime pack");
  }
  return {
    suiteId: policy.suiteId,
    version: policy.version,
    treeSha256: treeDigest(files),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    skills,
    requiredCapabilities,
    warnings,
  };
}

export function inspectManagedSkillSuite(policy: ManagedSkillSuitePolicy): ManagedSkillSuiteInspection {
  const validated = validatePolicy(policy);
  const root = sourceRoot(validated.source.path);
  const files = enumerateSource(root);
  return inspectFiles(validated, root, files);
}

function catalogKey(suiteId: string, digest: string): string {
  return `${suiteId}:${digest}`;
}

function parseCatalog(path: string): Catalog {
  if (!existsSync(path)) return structuredClone(EMPTY_CATALOG);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) {
    throw new Error("Managed skill-suite catalog is invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Managed skill-suite catalog is invalid JSON"); }
  const value = object(parsed, "Managed skill-suite catalog");
  if (value.schemaVersion !== "1.0.0" || !value.active || !value.records
      || typeof value.active !== "object" || Array.isArray(value.active)
      || typeof value.records !== "object" || Array.isArray(value.records)) {
    throw new Error("Managed skill-suite catalog schema is invalid");
  }
  return value as unknown as Catalog;
}

function writeCatalog(root: string, catalog: Catalog): void {
  const path = join(root, "catalog.json");
  const temporary = join(root, `.catalog-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${canonicalJson(catalog)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function containedObjectPath(root: string, record: ManagedSkillSuiteRecord): string {
  if (!/^objects\/[a-z][a-z0-9-]{0,62}\/[a-f0-9]{64}$/u.test(record.objectRef)) {
    throw new Error("Managed skill-suite object reference is invalid");
  }
  const path = resolve(root, record.objectRef);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Managed skill-suite object reference escaped its root");
  return path;
}

export class ManagedSkillSuiteManager {
  readonly root: string;
  private readonly now: () => Date;

  constructor(options: { root: string; now?: () => Date }) {
    this.root = privateDirectory(options.root);
    this.now = options.now ?? (() => new Date());
    mkdirSync(join(this.root, "objects"), { recursive: true, mode: 0o700 });
  }

  inspect(policy: ManagedSkillSuitePolicy): ManagedSkillSuiteInspection {
    return inspectManagedSkillSuite(policy);
  }

  install(policyInput: ManagedSkillSuitePolicy): ManagedSkillSuiteRecord {
    const policy = validatePolicy(policyInput);
    return this.withLock(() => {
      const source = sourceRoot(policy.source.path);
      const files = enumerateSource(source);
      const inspection = inspectFiles(policy, source, files);
      if (inspection.treeSha256 !== policy.source.expectedSha256) {
        throw new Error("Managed skill-suite source digest does not match accepted bytes");
      }
      const catalog = parseCatalog(join(this.root, "catalog.json"));
      const key = catalogKey(policy.suiteId, inspection.treeSha256);
      const existing = catalog.records[key];
      if (existing) {
        this.verifyRecord(existing);
        if (canonicalJson({
          displayName: existing.displayName,
          version: existing.version,
          trustProfile: existing.trustProfile,
          projects: existing.projects,
          runtimes: existing.runtimes,
          telemetry: existing.telemetry,
          updates: existing.updates,
          manifestDialect: existing.manifestDialect,
          capabilityOverrides: existing.capabilityOverrides,
        }) !== canonicalJson({
          displayName: policy.displayName,
          version: policy.version,
          trustProfile: policy.trustProfile,
          projects: policy.projects,
          runtimes: policy.runtimes,
          telemetry: policy.telemetry,
          updates: policy.updates,
          manifestDialect: policy.manifestDialect,
          capabilityOverrides: policy.capabilityOverrides,
        })) throw new Error("Managed skill-suite exact source was already installed under different policy");
        return existing;
      }

      const previousDigest = catalog.active[policy.suiteId];
      const previous = previousDigest ? catalog.records[catalogKey(policy.suiteId, previousDigest)] : undefined;
      const previousCapabilities = new Set(previous?.requiredCapabilities ?? []);
      const expansion = previous
        ? inspection.requiredCapabilities.filter((capability) => !previousCapabilities.has(capability))
        : [];
      const quarantine = previous !== undefined && expansion.length > 0 && !policy.allowCapabilityExpansion;
      const manualHold = previous !== undefined && policy.updates === "manual";
      const objectRef = `objects/${policy.suiteId}/${inspection.treeSha256}`;
      const destination = resolve(this.root, objectRef);
      const staging = `${destination}.staging-${randomUUID()}`;
      if (existsSync(destination)) throw new Error("Managed skill-suite object exists without a catalog record");
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      try {
        for (const file of files) {
          const target = join(staging, ...file.relativePath.split("/"));
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(file.absolutePath, target, constants.COPYFILE_EXCL);
          chmodSync(target, file.executable ? 0o700 : 0o600);
        }
        const copied = enumerateSource(staging);
        if (treeDigest(copied) !== inspection.treeSha256) throw new Error("Managed skill-suite copy verification failed");
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        renameSync(staging, destination);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      const record: ManagedSkillSuiteRecord = {
        ...inspection,
        displayName: policy.displayName,
        trustProfile: policy.trustProfile,
        projects: policy.projects,
        runtimes: policy.runtimes,
        telemetry: "disabled",
        updates: policy.updates,
        manifestDialect: policy.manifestDialect,
        capabilityOverrides: policy.capabilityOverrides,
        installedAt: this.now().toISOString(),
        objectRef,
        state: quarantine ? "quarantined" : manualHold ? "installed" : "active",
        expansion,
      };
      catalog.records[key] = record;
      if (!quarantine && !manualHold) {
        if (previous) previous.state = "installed";
        catalog.active[policy.suiteId] = inspection.treeSha256;
      }
      writeCatalog(this.root, catalog);
      return record;
    });
  }

  activate(suiteIdInput: string, digest: string, allowCapabilityExpansion = false): ManagedSkillSuiteRecord {
    const suiteId = assertSafeId(suiteIdInput, "suiteId");
    if (!SHA256.test(digest)) throw new Error("Managed skill-suite activation digest is invalid");
    return this.withLock(() => {
      const catalog = parseCatalog(join(this.root, "catalog.json"));
      const record = catalog.records[catalogKey(suiteId, digest)];
      if (!record) throw new Error("Managed skill-suite generation is not installed");
      this.verifyRecord(record);
      const previousDigest = catalog.active[suiteId];
      const previous = previousDigest ? catalog.records[catalogKey(suiteId, previousDigest)] : undefined;
      const previousCapabilities = new Set(previous?.requiredCapabilities ?? []);
      const expansion = record.requiredCapabilities.filter((capability) => !previousCapabilities.has(capability));
      if (previous && expansion.length > 0 && !allowCapabilityExpansion) {
        throw new Error("Managed skill-suite activation expands capabilities and requires explicit acceptance");
      }
      if (previous) previous.state = "installed";
      record.state = "active";
      record.expansion = expansion;
      catalog.active[suiteId] = digest;
      writeCatalog(this.root, catalog);
      return record;
    });
  }

  rollback(suiteId: string, digest: string): ManagedSkillSuiteRecord {
    return this.activate(suiteId, digest, false);
  }

  status(): { enabled: boolean; rootRef: "private-managed-skill-suites"; suites: ManagedSkillSuiteStatusRecord[] } {
    const catalog = parseCatalog(join(this.root, "catalog.json"));
    const records = Object.values(catalog.records).map((record) => {
      let state: ManagedSkillSuiteStatusRecord["state"];
      let warnings = record.warnings;
      try {
        this.verifyRecord(record);
        state = catalog.active[record.suiteId] === record.treeSha256 ? "active" : record.state;
      } catch {
        state = "quarantined";
        warnings = sortedUnique([...record.warnings, "Installed bytes failed integrity verification"]);
      }
      return {
        suiteId: record.suiteId,
        displayName: record.displayName,
        version: record.version,
        treeSha256: record.treeSha256,
        fileCount: record.fileCount,
        totalBytes: record.totalBytes,
        trustProfile: record.trustProfile,
        projects: record.projects,
        runtimes: record.runtimes,
        telemetry: record.telemetry,
        updates: record.updates,
        manifestDialect: record.manifestDialect === MANAGED_SKILL_MANIFEST_DIALECT
          ? MANAGED_SKILL_MANIFEST_DIALECT
          : null,
        installedAt: record.installedAt,
        objectRef: record.objectRef,
        state,
        expansion: record.expansion,
        requiredCapabilities: record.requiredCapabilities,
        warnings,
        skills: record.skills.map((skill) => ({
          name: skill.name,
          version: skill.version,
          digest: skill.digest,
          requiredCapabilities: skill.requiredCapabilities,
          compatible: state !== "quarantined" && skill.compatible,
          blockedCapabilities: skill.blockedCapabilities,
          hasUnclassifiedTools: skill.unclassifiedTools.length > 0,
          hasAuthorityIssues: !Array.isArray(skill.authorityIssues) || skill.authorityIssues.length > 0,
        })),
      };
    }).sort((a, b) => a.suiteId.localeCompare(b.suiteId) || a.version.localeCompare(b.version));
    return { enabled: records.some((record) => record.state === "active"), rootRef: "private-managed-skill-suites", suites: records };
  }

  capabilityPack(input: {
    suiteId: string;
    projectId: string;
    runtime: ManagedSkillRuntime;
    skills?: string[];
  }): ManagedSkillCapabilityPack {
    const suiteId = assertSafeId(input.suiteId, "suiteId");
    const projectId = assertSafeId(input.projectId, "projectId");
    const catalog = parseCatalog(join(this.root, "catalog.json"));
    const digest = catalog.active[suiteId];
    if (!digest) throw new Error("Managed skill-suite is not active");
    const record = catalog.records[catalogKey(suiteId, digest)];
    if (!record || record.state !== "active") throw new Error("Managed skill-suite active record is unavailable");
    this.verifyRecord(record);
    if (!record.projects.includes(projectId)) throw new Error("Managed skill-suite is not allowed for this project");
    const runtime = record.runtimes.find((item) => item.runtime === input.runtime);
    if (!runtime) throw new Error("Managed skill-suite is not allowed for this runtime");
    const requested = input.skills === undefined ? record.skills.filter((skill) => skill.compatible).map((skill) => skill.name) : sortedUnique(input.skills);
    if (requested.length < 1 || requested.length > MAX_SKILLS) throw new Error("Managed skill-suite capability pack requires a bounded skill selection");
    const skills = requested.map((name) => {
      assertSafeId(name, "Managed skill name");
      const skill = record.skills.find((item) => item.name === name);
      if (!skill) throw new Error(`Managed skill ${name} is not installed`);
      if (!skill.compatible) throw new Error(`Managed skill ${name} requires operator-gated capabilities`);
      return {
        name: skill.name,
        relativePath: skill.relativePath,
        digest: skill.digest,
        requiredCapabilities: skill.requiredCapabilities,
      };
    });
    const unsigned = {
      schemaVersion: "1.1.0" as const,
      projectId,
      runtime: input.runtime,
      runtimeMode: runtime.mode,
      suiteId,
      suiteVersion: record.version,
      suiteSha256: record.treeSha256,
      manifestDialect: record.manifestDialect,
      objectRef: record.objectRef,
      skills,
      requiredCapabilities: sortedUnique(skills.flatMap((skill) => skill.requiredCapabilities)),
      telemetry: "disabled" as const,
      finalActionsRemainControlPlaneGated: true as const,
    };
    return { ...unsigned, manifestSha256: sha(canonicalJson(unsigned)) };
  }

  verifyCapabilityPack(pack: ManagedSkillCapabilityPack): ManagedSkillCapabilityPack {
    const { manifestSha256, ...unsigned } = pack;
    if (!SHA256.test(manifestSha256) || sha(canonicalJson(unsigned)) !== manifestSha256) {
      throw new Error("Managed skill-suite capability pack digest is invalid");
    }
    const expected = this.capabilityPack({
      suiteId: pack.suiteId,
      projectId: pack.projectId,
      runtime: pack.runtime,
      skills: pack.skills.map((skill) => skill.name),
    });
    if (canonicalJson(expected) !== canonicalJson(pack)) throw new Error("Managed skill-suite capability pack no longer matches active policy");
    return expected;
  }

  private verifyRecord(record: ManagedSkillSuiteRecord): void {
    const path = containedObjectPath(this.root, record);
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Managed skill-suite object is unavailable");
    const files = enumerateSource(realpathSync(path));
    const actual = inspectFiles({
      schemaVersion: "1.1.0",
      suiteId: record.suiteId,
      displayName: record.displayName,
      version: record.version,
      source: { kind: "local-directory", path, expectedSha256: record.treeSha256 },
      trustProfile: record.trustProfile,
      projects: record.projects,
      runtimes: record.runtimes,
      telemetry: "disabled",
      updates: record.updates,
      allowCapabilityExpansion: false,
      manifestDialect: record.manifestDialect,
      capabilityOverrides: record.capabilityOverrides,
    }, path, files);
    const expected = {
      suiteId: record.suiteId,
      version: record.version,
      treeSha256: record.treeSha256,
      fileCount: record.fileCount,
      totalBytes: record.totalBytes,
      skills: record.skills,
      requiredCapabilities: record.requiredCapabilities,
      warnings: record.warnings,
    };
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error("Managed skill-suite object integrity changed");
    }
  }

  private withLock<T>(operation: () => T): T {
    const path = join(this.root, ".catalog.lock");
    let descriptor: number;
    try { descriptor = openSync(path, "wx", 0o600); } catch { throw new Error("Managed skill-suite catalog is busy"); }
    try { return operation(); }
    finally {
      closeSync(descriptor);
      try { unlinkSync(path); } catch { /* A missing lock after close is harmless; later writes still fail closed. */ }
    }
  }
}
