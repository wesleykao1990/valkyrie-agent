import test from "node:test";
import assert from "node:assert/strict";
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
  async invoke(operation: string, args: readonly string[]) {
    this.calls.push({ operation, args: [...args] });
    if (operation === "network-inspect") return { stdout: JSON.stringify({ Name: "valkyrie-m5b", Internal: !this.wrongNetwork, Ingress: false, Driver: "bridge", Scope: "local" }), stderr: "" };
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
      const mount = this.createArgs[this.createArgs.indexOf("--mount") + 1];
      const source = /src=([^,]+)/.exec(mount)?.[1];
      return { stdout: JSON.stringify([{
        Id: id, Name: "/valkyrie-inference-f903ee77b33627de1327", Config: {
          Image: image, User: "501:20", Labels: labelValues,
          Entrypoint: ["/usr/local/bin/node"], Cmd: ["-e", "const n=require('node:net');const s=n.createServer(c=>{const u=n.createConnection('/gateway/inference.sock');c.pipe(u);u.pipe(c);const x=()=>{c.destroy();u.destroy()};c.on('error',x);u.on('error',x)});s.listen(8790,'0.0.0.0');"],
        },
        HostConfig: {
          NetworkMode: "valkyrie-m5b", ReadonlyRootfs: true, Privileged: false, IpcMode: "none",
          RestartPolicy: { Name: "no" }, CapDrop: ["ALL"], Memory: 128 * 1024 * 1024,
          NanoCpus: 250_000_000, PidsLimit: 32,
          SecurityOpt: ["no-new-privileges:true", "seccomp=builtin"],
          Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16777216" },
        },
        NetworkSettings: { Networks: { "valkyrie-m5b": {} } },
        Mounts: [{ Source: source, Destination: "/gateway", RW: false }],
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
