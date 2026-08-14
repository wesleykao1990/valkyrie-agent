import type { Server } from "node:http";
import type { RuntimeAdapter } from "./runtime.ts";
import type { ControlPlaneStore } from "./store.ts";

function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function shutdownControlPlane(
  server: Server,
  adapters: Iterable<RuntimeAdapter>,
  store: Pick<ControlPlaneStore, "close">,
  options: { adapterTimeoutMs?: number; serverTimeoutMs?: number } = {},
): Promise<void> {
  const failures: unknown[] = [];
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  });

  // Stop new requests and immediately terminate long-lived SSE/keep-alive
  // connections. Runtime cleanup must never wait behind HTTP connection drain.
  server.closeAllConnections();

  const shutdowns = [...adapters].map(async (adapter) => adapter.shutdown?.());
  try {
    const settled = await bounded(
      Promise.allSettled(shutdowns),
      options.adapterTimeoutMs ?? 10_000,
      "Runtime adapter shutdown",
    );
    failures.push(...settled.filter((result) => result.status === "rejected").map((result) => result.reason));
  } catch (error) {
    failures.push(error);
  }

  // A second sweep covers a connection accepted immediately before close().
  server.closeAllConnections();
  try {
    await bounded(serverClosed, options.serverTimeoutMs ?? 5_000, "HTTP server shutdown");
  } catch (error) {
    failures.push(error);
  }

  try {
    await store.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Control-plane shutdown was incomplete");
}
