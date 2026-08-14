import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  closeSync,
  constants,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = join(repositoryRoot, "fixtures", "atomic-pilot-template");
const gitCommand = "/usr/bin/git";

interface FixtureFile {
  relativePath: string;
  content: Buffer;
}

interface GitTreeFile {
  relativePath: string;
  mode: string;
  type: string;
  objectId: string;
}

function templateFiles(): FixtureFile[] {
  const files: FixtureFile[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Atomic pilot template cannot contain symbolic links");
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Atomic pilot template must contain only single-link regular files");
      files.push({ relativePath: relative(templateRoot, path).split(sep).join("/"), content: readFileSync(path) });
    }
  };
  visit(templateRoot);
  return files;
}

function templateHash(files: FixtureFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.relativePath).update("\0").update(file.content).update("\0");
  return hash.digest("hex");
}

function assertSafeParent(target: string): string {
  let cursor = dirname(target);
  const suffix: string[] = [basename(target)];
  while (!existsSync(cursor)) {
    suffix.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Atomic fixture repository has no existing parent directory");
    cursor = parent;
  }
  const stat = lstatSync(cursor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Atomic fixture parent must be a regular non-symlink directory");
  return resolve(realpathSync(cursor), ...suffix);
}

function writeExclusive(path: string, content: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function runGitBuffer(repository: string, args: string[]): Buffer {
  const result = spawnSync(gitCommand, ["-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    encoding: null,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "Valkyrie Atomic Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Valkyrie Atomic Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)]).toString("utf8").trim() || "Git command failed");
  }
  return result.stdout ?? Buffer.alloc(0);
}

function runGit(repository: string, args: string[]): string {
  return runGitBuffer(repository, args).toString("utf8").trim();
}

function expectedRepositoryFiles(files: FixtureFile[], expectedTemplateHash: string): FixtureFile[] {
  return [
    ...files,
    {
      relativePath: ".valkyrie-fixture.json",
      content: Buffer.from(`${JSON.stringify({ schemaVersion: 1, templateHash: expectedTemplateHash })}\n`, "utf8"),
    },
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseGitTree(repository: string, commit: string): GitTreeFile[] {
  const output = runGitBuffer(repository, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (output.byteLength === 0) return [];
  const entries: GitTreeFile[] = [];
  for (const rawEntry of output.subarray(0, output.byteLength - (output.at(-1) === 0 ? 1 : 0)).toString("utf8").split("\0")) {
    const separator = rawEntry.indexOf("\t");
    const header = separator >= 0 ? rawEntry.slice(0, separator) : "";
    const relativePath = separator >= 0 ? rawEntry.slice(separator + 1) : "";
    const match = header.match(/^([0-7]{6}) ([a-z]+) ([a-f0-9]{40,64})$/);
    if (!match || !relativePath || relativePath.includes("\0")) {
      throw new Error("Existing Atomic fixture repository has an invalid committed tree entry");
    }
    entries.push({ mode: match[1]!, type: match[2]!, objectId: match[3]!, relativePath });
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertCommittedTree(repository: string, commit: string, expectedFiles: FixtureFile[]): void {
  const actual = parseGitTree(repository, commit);
  if (actual.length !== expectedFiles.length) {
    throw new Error("Existing Atomic fixture repository committed tree does not match the reviewed fixture manifest");
  }
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const expected = expectedFiles[index]!;
    const entry = actual[index]!;
    if (entry.relativePath !== expected.relativePath || entry.mode !== "100644" || entry.type !== "blob") {
      throw new Error("Existing Atomic fixture repository committed tree does not match the reviewed fixture manifest");
    }
    const committedContent = runGitBuffer(repository, ["cat-file", "blob", entry.objectId]);
    if (!committedContent.equals(expected.content)) {
      throw new Error(`Existing Atomic fixture repository committed content changed: ${expected.relativePath}`);
    }
  }
}

function assertWorkingTree(repository: string, expectedFiles: FixtureFile[]): void {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.relativePath, file.content]));
  const expectedDirectories = new Set<string>();
  for (const file of expectedFiles) {
    let directory = dirname(file.relativePath);
    while (directory !== ".") {
      expectedDirectories.add(directory.split(sep).join("/"));
      directory = dirname(directory);
    }
  }
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === repository && name === ".git") continue;
      const path = join(directory, name);
      const relativePath = relative(repository, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Existing Atomic fixture repository contains a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          throw new Error(`Existing Atomic fixture repository contains an unexpected directory: ${relativePath}`);
        }
        visit(path);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Existing Atomic fixture repository contains a non-regular or linked file: ${relativePath}`);
      }
      const expectedContent = expectedByPath.get(relativePath);
      if (!expectedContent) {
        throw new Error(`Existing Atomic fixture repository contains an unexpected file: ${relativePath}`);
      }
      if (!readFileSync(path).equals(expectedContent)) {
        throw new Error(`Existing Atomic fixture repository working content changed: ${relativePath}`);
      }
      seen.add(relativePath);
    }
  };
  visit(repository);
  if (seen.size !== expectedFiles.length) {
    throw new Error("Existing Atomic fixture repository working tree does not match the reviewed fixture manifest");
  }
}

function verifyExistingRepository(repository: string, expectedFiles: FixtureFile[]): string {
  const gitPath = join(repository, ".git");
  if (!existsSync(gitPath)) throw new Error("Existing Atomic fixture repository has no private Git metadata directory");
  const gitStat = lstatSync(gitPath);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error("Existing Atomic fixture repository Git metadata must be a non-symlink directory");
  }
  const commit = runGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Existing Atomic fixture repository HEAD is invalid");
  assertCommittedTree(repository, commit, expectedFiles);
  if (runGit(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Existing Atomic fixture repository is not clean");
  }
  assertWorkingTree(repository, expectedFiles);
  if (runGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"]) !== commit) {
    throw new Error("Existing Atomic fixture repository HEAD changed during verification");
  }
  assertWorkingTree(repository, expectedFiles);
  return commit;
}

export function setupAtomicFixtureRepository(targetInput: string): { path: string; commit: string; templateHash: string; replayed: boolean } {
  if (!isAbsolute(targetInput)) throw new Error("Atomic fixture repository path must be absolute");
  const requested = resolve(targetInput);
  const target = assertSafeParent(requested);
  if (target !== requested) throw new Error("Atomic fixture repository path changed during canonicalization");
  const files = templateFiles();
  const expectedTemplateHash = templateHash(files);
  const expectedFiles = expectedRepositoryFiles(files, expectedTemplateHash);
  const markerPath = join(target, ".valkyrie-fixture.json");

  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(target) !== target) {
      throw new Error("Existing Atomic fixture repository must be a canonical non-symlink directory");
    }
    const commit = verifyExistingRepository(target, expectedFiles);
    return { path: target, commit, templateHash: expectedTemplateHash, replayed: true };
  }

  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  for (const file of files) {
    const destination = join(target, ...file.relativePath.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeExclusive(destination, file.content);
  }
  writeExclusive(markerPath, `${JSON.stringify({ schemaVersion: 1, templateHash: expectedTemplateHash })}\n`);
  runGit(target, ["init", "--initial-branch=main"]);
  runGit(target, ["add", "--all"]);
  runGit(target, ["commit", "-m", "Create disposable Atomic Milestone 5 fixture"]);
  return { path: target, commit: verifyExistingRepository(target, expectedFiles), templateHash: expectedTemplateHash, replayed: false };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? process.env.ATOMIC_FIXTURE_PILOT_REPOSITORY;
  if (!target) throw new Error("Pass an absolute repository path or set ATOMIC_FIXTURE_PILOT_REPOSITORY");
  const result = setupAtomicFixtureRepository(target);
  console.log(`Atomic fixture repository ${result.replayed ? "verified" : "created"}: ${result.path}`);
  console.log(`Fixture commit: ${result.commit}`);
  console.log(`Template SHA-256: ${result.templateHash}`);
}
