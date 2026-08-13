import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ManagedSkillSuiteManager,
  inspectManagedSkillSuite,
  loadManagedSkillSuitePolicy,
} from "../apps/control-plane/src/managed-skill-suites.ts";
import { canonicalJson } from "../apps/control-plane/src/store.ts";

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run skills:manage -- inspect --policy /absolute/policy.json",
    "  npm run skills:manage -- install --policy /absolute/policy.json --policy-sha256 <sha256> --root /absolute/private/root",
    "  npm run skills:manage -- status --root /absolute/private/root",
    "  npm run skills:manage -- activate --suite <id> --digest <sha256> --root /absolute/private/root [--accept-capability-expansion]",
    "  npm run skills:manage -- rollback --suite <id> --digest <sha256> --root /absolute/private/root",
  ].join("\n"));
}

function argumentsMap(values: string[]): { action: string; flags: Map<string, string | true> } {
  const [action, ...rest] = values;
  if (!action || !["inspect", "install", "status", "activate", "rollback"].includes(action)) usage();
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--") || flags.has(name)) usage();
    if (name === "--accept-capability-expansion") {
      flags.set(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) usage();
    flags.set(name, value);
    index += 1;
  }
  return { action, flags };
}

function required(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || !value) usage();
  return value;
}

function exactFlags(flags: Map<string, string | true>, allowed: string[]): void {
  if ([...flags.keys()].some((key) => !allowed.includes(key))) usage();
}

function absolute(flags: Map<string, string | true>, name: string): string {
  const value = required(flags, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function policyForInspection(path: string) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256_000) {
    throw new Error("Inspection policy must be a bounded regular non-symlink file");
  }
  const bytes = readFileSync(path);
  return loadManagedSkillSuitePolicy({
    path,
    acceptedSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function print(value: unknown): void {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

const { action, flags } = argumentsMap(process.argv.slice(2));
if (action === "inspect") {
  exactFlags(flags, ["--policy"]);
  const policy = policyForInspection(absolute(flags, "--policy"));
  print(inspectManagedSkillSuite(policy));
} else if (action === "install") {
  exactFlags(flags, ["--policy", "--policy-sha256", "--root"]);
  const policy = loadManagedSkillSuitePolicy({
    path: absolute(flags, "--policy"),
    acceptedSha256: required(flags, "--policy-sha256"),
  });
  print(new ManagedSkillSuiteManager({ root: absolute(flags, "--root") }).install(policy));
} else if (action === "status") {
  exactFlags(flags, ["--root"]);
  print(new ManagedSkillSuiteManager({ root: absolute(flags, "--root") }).status());
} else if (action === "activate") {
  exactFlags(flags, ["--suite", "--digest", "--root", "--accept-capability-expansion"]);
  print(new ManagedSkillSuiteManager({ root: absolute(flags, "--root") }).activate(
    required(flags, "--suite"),
    required(flags, "--digest"),
    flags.get("--accept-capability-expansion") === true,
  ));
} else if (action === "rollback") {
  exactFlags(flags, ["--suite", "--digest", "--root"]);
  print(new ManagedSkillSuiteManager({ root: absolute(flags, "--root") }).rollback(
    required(flags, "--suite"),
    required(flags, "--digest"),
  ));
} else {
  usage();
}
