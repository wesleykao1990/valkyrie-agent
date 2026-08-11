import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { shutdownControlPlane } from "../apps/control-plane/src/shutdown.ts";
import type { RuntimeAdapter } from "../apps/control-plane/src/runtime.ts";

test("shutdown reaps adapters without waiting for an open SSE connection", async () => {
  let adapterStopped = false;
  let storeClosed = false;
  const adapter = {
    shutdown: async () => { adapterStopped = true; },
  } as RuntimeAdapter;
  const store = {
    close: async () => { storeClosed = true; },
  };
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("event: connected\ndata: {}\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/events`);
  assert.equal(response.status, 200);
  assert.equal(server.listening, true);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  await shutdownControlPlane(server, [adapter], store, { adapterTimeoutMs: 500, serverTimeoutMs: 500 });

  assert.equal(adapterStopped, true);
  assert.equal(storeClosed, true);
  assert.equal(server.listening, false);
  let connectionClosed = false;
  try {
    connectionClosed = (await reader.read()).done;
  } catch {
    connectionClosed = true;
  }
  assert.equal(connectionClosed, true);
});
