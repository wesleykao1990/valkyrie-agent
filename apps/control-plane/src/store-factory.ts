import type { ControlPlaneStore } from "./store.ts";
import { SqliteStore } from "./sqlite-store.ts";
import { PostgresStore, type PostgresStoreOptions } from "./postgres-store.ts";

export type StoreFactoryOptions =
  | { backend: "sqlite"; sqlitePath: string }
  | ({ backend: "postgres" } & PostgresStoreOptions);

export async function createControlPlaneStore(options: StoreFactoryOptions): Promise<ControlPlaneStore> {
  if (options.backend === "sqlite") return new SqliteStore(options.sqlitePath);
  return PostgresStore.connect(options);
}
