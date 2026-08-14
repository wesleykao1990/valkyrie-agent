import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export type MigrationDialect = "sqlite" | "postgres";

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
  path: string;
}

const migrationName = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/i;

export function loadMigrationFiles(dialect: MigrationDialect): MigrationFile[] {
  const root = fileURLToPath(new URL("../../../infra/", import.meta.url));
  const directory = join(root, dialect);
  return readdirSync(directory)
    .map((name) => ({ name, match: name.match(migrationName) }))
    .filter((item): item is { name: string; match: RegExpMatchArray } => Boolean(item.match))
    .map(({ name, match }) => {
      const path = join(directory, name);
      const sql = readFileSync(path, "utf8");
      return {
        version: Number(match[1]),
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
        path,
      };
    })
    .sort((a, b) => a.version - b.version);
}

export function assertUniqueMigrationVersions(files: MigrationFile[]): void {
  const seen = new Set<number>();
  for (const file of files) {
    if (!Number.isSafeInteger(file.version) || file.version <= 0) {
      throw new Error(`Invalid migration version in ${file.name}`);
    }
    if (seen.has(file.version)) throw new Error(`Duplicate migration version ${file.version}`);
    seen.add(file.version);
  }
}
