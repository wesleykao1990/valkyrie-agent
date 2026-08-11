import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export interface ArtifactManifestEntry {
  relativePath: string;
  kind: string;
  mediaType: string;
}

export interface GovernedArtifactExportOptions {
  workspacePath: string;
  artifactRoot: string;
  runId: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface GovernedArtifactExport {
  sourceRelativePath: string;
  path: string;
  kind: string;
  mediaType: string;
  checksum: string;
  sizeBytes: number;
}

export interface SecretFinding {
  ruleId: string;
  fingerprint: string;
}

export class ArtifactSecretDetectedError extends Error {
  readonly code = "ARTIFACT_SECRET_DETECTED";
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    super(`Artifact export blocked by ${findings.length} secret-detection rule match${findings.length === 1 ? "" : "es"}`);
    this.name = "ArtifactSecretDetectedError";
    this.findings = findings;
  }
}

interface SecretRule {
  id: string;
  pattern: RegExp;
}

interface PreparedArtifact extends ArtifactManifestEntry {
  sourcePath: string;
  body: Buffer;
  checksum: string;
}

const SECRET_RULES: readonly SecretRule[] = [
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  { id: "openai-api-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  {
    id: "credential-assignment",
    pattern: /\b(?:[A-Za-z0-9]+[_-]){0,4}(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{16,}/gi,
  },
];

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensurePositiveBound(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertContained(root: string, candidate: string, description: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${description} escaped its configured root`);
  }
}

function validateRelativePath(value: string): string {
  if (!value || value !== value.trim() || isAbsolute(value) || CONTROL_CHAR.test(value)) {
    throw new Error("Artifact paths must be non-empty safe relative paths");
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Artifact paths must not contain empty, current, or parent segments");
  }
  return segments.join("/");
}

function assertSafeLabel(value: string, field: string): void {
  if (!value || value !== value.trim() || value.length > 128 || CONTROL_CHAR.test(value)) {
    throw new Error(`${field} must be 1-128 safe characters`);
  }
}

function assertNoSymlinkComponents(root: string, relativePath: string): void {
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("Artifact source paths must not contain symbolic links");
  }
}

function readRegularFile(path: string, maxBytes: number): Buffer {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Only regular files can be exported as artifacts");
    if (stat.nlink !== 1) throw new Error("Hard-linked files cannot be exported as artifacts");
    if (stat.size > maxBytes) throw new Error("Artifact file exceeds the configured byte limit");
    const body = readFileSync(descriptor);
    if (body.byteLength !== stat.size || body.byteLength > maxBytes) {
      throw new Error("Artifact file changed or exceeded its byte limit while being read");
    }
    return body;
  } finally {
    closeSync(descriptor);
  }
}

export function scanArtifactSecrets(body: Buffer): SecretFinding[] {
  const text = body.toString("utf8");
  const findings = new Map<string, SecretFinding>();
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const matched = match[0];
      const key = `${rule.id}:${sha(matched)}`;
      findings.set(key, { ruleId: rule.id, fingerprint: sha(matched).slice(0, 16) });
    }
  }
  return [...findings.values()].sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId) || left.fingerprint.localeCompare(right.fingerprint));
}

function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Artifact export directory must be a regular non-symlink directory");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Artifact export directory must not grant group or other permissions");
  }
}

function listRegularFiles(root: string, cursor = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(cursor, { withFileTypes: true })) {
    const path = join(cursor, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Artifact export directory must not contain symbolic links");
    if (entry.isDirectory()) result.push(...listRegularFiles(root, path));
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Artifact export directory must not contain special files");
  }
  return result.sort();
}

/**
 * Copies an explicit artifact manifest only after every candidate has passed
 * containment, file-type, byte-bound, and secret checks. No partial export is
 * intentionally retained when a later write fails.
 */
export function exportGovernedArtifacts(
  manifest: readonly ArtifactManifestEntry[],
  options: GovernedArtifactExportOptions,
): GovernedArtifactExport[] {
  if (!SAFE_RUN_ID.test(options.runId)) throw new Error("Artifact export run ID is invalid");
  const maxFiles = ensurePositiveBound("maxFiles", options.maxFiles ?? 32, 1_000);
  const maxFileBytes = ensurePositiveBound("maxFileBytes", options.maxFileBytes ?? 10 * 1024 * 1024, 1024 * 1024 * 1024);
  const maxTotalBytes = ensurePositiveBound("maxTotalBytes", options.maxTotalBytes ?? 25 * 1024 * 1024, 4 * 1024 * 1024 * 1024);
  if (manifest.length === 0 || manifest.length > maxFiles) {
    throw new Error(`Artifact manifest must contain between 1 and ${maxFiles} entries`);
  }

  const workspace = resolve(options.workspacePath);
  const workspaceStat = lstatSync(workspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Artifact workspace must be a regular non-symlink directory");
  }
  const realWorkspace = realpathSync(workspace);
  const prepared: PreparedArtifact[] = [];
  const seen = new Set<string>();
  const allFindings: SecretFinding[] = [];
  let totalBytes = 0;

  for (const item of manifest) {
    const relativePath = validateRelativePath(item.relativePath);
    assertSafeLabel(item.kind, "Artifact kind");
    assertSafeLabel(item.mediaType, "Artifact media type");
    if (seen.has(relativePath)) throw new Error("Artifact manifest paths must be unique");
    seen.add(relativePath);

    const sourcePath = resolve(workspace, ...relativePath.split("/"));
    assertContained(workspace, sourcePath, "Artifact source path");
    assertNoSymlinkComponents(workspace, relativePath);
    const realSource = realpathSync(sourcePath);
    assertContained(realWorkspace, realSource, "Artifact source realpath");
    const body = readRegularFile(realSource, maxFileBytes);
    totalBytes += body.byteLength;
    if (totalBytes > maxTotalBytes) throw new Error("Artifact manifest exceeds the configured total byte limit");
    allFindings.push(...scanArtifactSecrets(body));
    prepared.push({ ...item, relativePath, sourcePath: realSource, body, checksum: sha(body) });
  }

  if (allFindings.length > 0) {
    const unique = new Map(allFindings.map((finding) => [`${finding.ruleId}:${finding.fingerprint}`, finding]));
    throw new ArtifactSecretDetectedError([...unique.values()]);
  }

  const artifactRoot = resolve(options.artifactRoot);
  ensurePrivateDirectory(artifactRoot);
  const realArtifactRoot = realpathSync(artifactRoot);
  const runDirectory = resolve(realArtifactRoot, options.runId);
  assertContained(realArtifactRoot, runDirectory, "Artifact run directory");
  const runDirectoryExisted = existsSync(runDirectory);
  ensurePrivateDirectory(runDirectory);

  const expectedPaths = prepared.map((item) => item.relativePath).sort();
  const existingPaths = listRegularFiles(runDirectory);
  if (existingPaths.some((path) => !expectedPaths.includes(path))) {
    throw new Error("Existing artifact export contents do not match the reviewed manifest");
  }

  const writtenPaths: string[] = [];
  try {
    const exports: GovernedArtifactExport[] = [];
    for (const item of prepared) {
      const destination = resolve(runDirectory, ...item.relativePath.split("/"));
      assertContained(runDirectory, destination, "Artifact destination path");
      ensurePrivateDirectory(dirname(destination));
      if (existsSync(destination)) {
        const existing = readRegularFile(destination, maxFileBytes);
        const mode = lstatSync(destination).mode & 0o777;
        if (!existing.equals(item.body) || (process.platform !== "win32" && mode !== 0o600)) {
          throw new Error("Existing artifact export does not exactly match the reviewed candidate");
        }
      } else {
        writeFileSync(destination, item.body, { flag: "wx", mode: 0o600 });
        writtenPaths.push(destination);
      }
      exports.push({
        sourceRelativePath: item.relativePath,
        path: destination,
        kind: item.kind,
        mediaType: item.mediaType,
        checksum: item.checksum,
        sizeBytes: item.body.byteLength,
      });
    }
    return exports;
  } catch (error) {
    if (!runDirectoryExisted) rmSync(runDirectory, { recursive: true, force: true });
    else for (const path of writtenPaths) rmSync(path, { force: true });
    throw error;
  }
}
