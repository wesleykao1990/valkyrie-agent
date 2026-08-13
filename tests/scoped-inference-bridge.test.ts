import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { ScopedInferenceBridge, type BridgeEngine } from "../apps/control-plane/src/scoped-inference-bridge.ts";

const id = "a".repeat(64);
const image = `fixture.invalid/inference@sha256:${"b".repeat(64)}`;

class FakeBridgeEngine implements BridgeEngine {
  calls: Array<{ operation: string; args: string[] }> = [];
  wrongNetwork = false;
  createArgs: string[] = [];
  failCreateAfterReservation = false;
  egressConnected = false;
  async invoke(operation: string, args: readonly string[]) {
    this.calls.push({ operation, args: [...args] });
    if (operation === "network-inspect") {
      const name = args.at(-1);
      return { stdout: JSON.stringify({ Name: name, Internal: name === "valkyrie-m5b" ? !this.wrongNetwork : false, Ingress: false, Driver: "bridge", Scope: "local" }), stderr: "" };
    }
    if (operation === "network-connect") { this.egressConnected = true; return { stdout: "", stderr: "" }; }
    if (operation === "create") {
      this.createArgs = [...args];
      if (this.failCreateAfterReservation) throw new Error("simulated uncertain create");
      return { stdout: `${id}\n`, stderr: "" };
    }
    if (operation === "inventory") return { stdout: this.createArgs.length > 0 ? `${id}\n` : "", stderr: "" };
    if (operation === "inspect") {
      const labelValues: Record<string, string> = {};
      for (let index = 0; index < this.createArgs.length; index += 1) if (this.createArgs[index] === "--label") {
        const [key, ...rest] = this.createArgs[++index].split("="); labelValues[key] = rest.join("=");
      }
      const expectedName = `valkyrie-inference-${createHash("sha256").update(labelValues["valkyrie.run-id"]).digest("hex").slice(0, 20)}`;
      const mountIndex = this.createArgs.indexOf("--mount");
      const mount = mountIndex < 0 ? undefined : this.createArgs[mountIndex + 1];
      const source = mount ? /src=([^,]+)/.exec(mount)?.[1] : undefined;
      const script = this.createArgs[this.createArgs.indexOf("-e") + 1];
      return { stdout: JSON.stringify([{
        Id: id, Name: `/${expectedName}`, Config: {
          Image: image, User: "501:20", Labels: labelValues,
          Entrypoint: ["/usr/local/bin/node"], Cmd: ["-e", script],
        },
        HostConfig: {
          NetworkMode: "valkyrie-m5b", ReadonlyRootfs: true, Privileged: false, IpcMode: "none",
          RestartPolicy: { Name: "no" }, CapDrop: ["ALL"], Memory: 128 * 1024 * 1024,
          NanoCpus: 250_000_000, PidsLimit: 32,
          SecurityOpt: ["no-new-privileges:true", "seccomp=builtin"],
          Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16777216" },
        },
        NetworkSettings: { Networks: { "valkyrie-m5b": {}, ...(this.egressConnected ? { bridge: {} } : {}) } },
        Mounts: source ? [{ Source: source, Destination: "/gateway", RW: false }] : [],
      }]), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

test("inference bridge exposes only a private Unix gateway on one internal network and cleans exact ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-bridge-"));
  chmodSync(root, 0o700);
  const socket = join(root, "inference.sock");
  const server = createServer();
  server.listen(socket); await once(server, "listening");
  chmodSync(socket, 0o600);
  const engine = new FakeBridgeEngine();
  try {
    const bridge = new ScopedInferenceBridge({ engine, image, networkName: "valkyrie-m5b", socketPath: socket, user: "501:20" });
    const handle = await bridge.start("run_bridge");
    const joined = engine.createArgs.join(" ");
    assert.match(joined, /--network valkyrie-m5b --network-alias valkyrie-inference/);
    assert.match(joined, /dst=\/gateway,readonly/);
    assert.doesNotMatch(joined, /credential|api[_-]?key|Bearer|OPENAI|ANTHROPIC/i);
    await bridge.stop(handle);
    assert.deepEqual(engine.calls.slice(-3).map((call) => [call.operation, call.args.at(-1)]), [["inspect", id], ["stop", id], ["rm", id]]);
    await assert.rejects(bridge.stop({ ...handle, id: "f".repeat(64) }), /ownership|isolation|invalid/i);
    engine.wrongNetwork = true;
    await assert.rejects(bridge.start("run_bad_network"), /internal network/i);
    assert.equal(engine.calls.filter((call) => call.operation === "create").length, 1);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inference bridge dual-homes only its fixed host-gateway proxy while the writer network stays internal", async () => {
  const engine = new FakeBridgeEngine();
  const bridge = new ScopedInferenceBridge({
    engine,
    image,
    networkName: "valkyrie-m5b",
    hostGateway: { hostname: "host.docker.internal", port: 8790, egressNetworkName: "bridge" },
    user: "501:20",
  });
  const handle = await bridge.start("run_bridge_tcp");
  const create = engine.calls.find((call) => call.operation === "create")!;
  assert.equal(create.args.includes("--mount"), false);
  assert.match(create.args.at(-1)!, /host\.docker\.internal/);
  assert.deepEqual(engine.calls.filter((call) => call.operation === "network-inspect").map((call) => call.args.at(-1)), [
    "valkyrie-m5b", "bridge",
  ]);
  assert.ok(engine.calls.some((call) => call.operation === "network-connect"
    && JSON.stringify(call.args) === JSON.stringify(["network", "connect", "bridge", id])));
  assert.equal(handle.gatewayBinding, "tcp:host.docker.internal:8790:bridge");
  await bridge.stop(handle);
});

test("inference bridge removes only an exactly-owned reservation after uncertain create", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-bridge-uncertain-"));
  chmodSync(root, 0o700);
  const socket = join(root, "inference.sock");
  const server = createServer();
  server.listen(socket); await once(server, "listening");
  chmodSync(socket, 0o600);
  const engine = new FakeBridgeEngine();
  engine.failCreateAfterReservation = true;
  try {
    const bridge = new ScopedInferenceBridge({ engine, image, networkName: "valkyrie-m5b", socketPath: socket, user: "501:20" });
    await assert.rejects(bridge.start("run_bridge"), /simulated uncertain create/);
    assert.ok(engine.calls.some((call) => call.operation === "inventory" && call.args.includes("--no-trunc")));
    assert.ok(engine.calls.some((call) => call.operation === "rm" && call.args.at(-1) === id));
    assert.equal(engine.calls.some((call) => call.operation === "stop"), false, "an unstarted exact reservation is removed directly");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inference bridge startup reconciliation removes only the fully inspected orphan", async () => {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-bridge-restart-"));
  chmodSync(root, 0o700);
  const socket = join(root, "inference.sock");
  const server = createServer();
  server.listen(socket); await once(server, "listening");
  chmodSync(socket, 0o600);
  const engine = new FakeBridgeEngine();
  try {
    const bridge = new ScopedInferenceBridge({ engine, image, networkName: "valkyrie-m5b", socketPath: socket, user: "501:20" });
    await bridge.start("run_bridge");
    assert.equal(await bridge.reconcileStartup(), 1);
    const inventory = [...engine.calls].reverse().find((call) => call.operation === "inventory");
    assert.ok(inventory?.args.includes("--no-trunc"));
    assert.ok(inventory?.args.includes("label=valkyrie.kind=inference-bridge"));
    assert.deepEqual(engine.calls.slice(-2).map((call) => [call.operation, call.args.at(-1)]), [["inspect", id], ["rm", id]]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
