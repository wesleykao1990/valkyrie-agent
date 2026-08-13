import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const CONTAINER = /^[a-f0-9]{64}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const UNIX_BRIDGE_SCRIPT = [
  "const n=require('node:net');",
  "const s=n.createServer(c=>{const u=n.createConnection('/gateway/inference.sock');c.pipe(u);u.pipe(c);",
  "const x=()=>{c.destroy();u.destroy()};c.on('error',x);u.on('error',x)});",
  "s.listen(8790,'0.0.0.0');",
].join("");

function tcpBridgeScript(host: string, port: number): string {
  return [
    "const n=require('node:net');",
    `const s=n.createServer(c=>{const u=n.createConnection(${port},${JSON.stringify(host)});c.pipe(u);u.pipe(c);`,
    "const x=()=>{c.destroy();u.destroy()};c.on('error',x);u.on('error',x)});",
    "s.listen(8790,'0.0.0.0');",
  ].join("");
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export interface BridgeEngine {
  invoke(operation: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>;
}

export class DockerCliBridgeEngine implements BridgeEngine {
  private readonly command: string;
  private readonly prefix: readonly string[];
  private readonly socket?: string;
  constructor(command: string, prefix: readonly string[] = [], socket?: string) {
    this.command = command; this.prefix = prefix; this.socket = socket;
    if (!isAbsolute(command)) throw new Error("Inference bridge engine command must be absolute");
  }

  invoke(_operation: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.command, [...this.prefix, ...args], {
        stdio: ["ignore", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C", ...(this.socket ? { DOCKER_HOST: this.socket } : {}) },
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      const bound = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) { child.kill("SIGKILL"); fail(new Error("Inference bridge engine output exceeded its bound")); }
        else target.push(chunk);
      };
      child.stdout.on("data", (chunk) => bound(stdout, chunk)); child.stderr.on("data", (chunk) => bound(stderr, chunk));
      child.once("error", () => fail(new Error("Inference bridge engine failed to start")));
      const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("Inference bridge engine command timed out")); }, timeoutMs);
      timer.unref();
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const out = Buffer.concat(stdout).toString("utf8"); const err = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) reject(new Error("Inference bridge engine command failed"));
        else resolvePromise({ stdout: out, stderr: err });
      });
    });
  }
}

export interface ScopedInferenceBridgeOptions {
  engine: BridgeEngine;
  image: string;
  networkName: string;
  socketPath?: string;
  hostGateway?: { hostname: "host.docker.internal" | "host.lima.internal"; port: number; egressNetworkName: "bridge" };
  user: string;
  timeoutMs?: number;
}

export interface ScopedInferenceBridgeHandle { runId: string; id: string; name: string; gatewayBinding: string; }

export class ScopedInferenceBridge {
  private readonly timeoutMs: number;
  private readonly options: ScopedInferenceBridgeOptions;
  private readonly gatewayBinding: string;
  private readonly script: string;
  constructor(options: ScopedInferenceBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!IMAGE.test(options.image) || !NETWORK.test(options.networkName) || !/^[0-9]{1,10}:[0-9]{1,10}$/.test(options.user)) {
      throw new Error("Inference bridge image/network/user policy is invalid");
    }
    if (Boolean(options.socketPath) === Boolean(options.hostGateway)) {
      throw new Error("Inference bridge requires exactly one Unix-socket or host-gateway transport");
    }
    if (options.socketPath) {
      const socket = resolve(options.socketPath);
      if (!isAbsolute(options.socketPath) || dirname(socket) === socket) throw new Error("Inference bridge socket path must be absolute");
      const parent = realpathSync(dirname(socket));
      const parentStat = lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
          || (process.platform !== "win32" && (parentStat.mode & 0o077) !== 0)) {
        throw new Error("Inference bridge socket parent must be canonical, private, and non-symlinked");
      }
      this.options = { ...options, socketPath: join(parent, basename(socket)) };
      this.gatewayBinding = `unix:${join(parent, basename(socket))}`;
      this.script = UNIX_BRIDGE_SCRIPT;
      return;
    }
    const gateway = options.hostGateway!;
    if (!Number.isSafeInteger(gateway.port) || gateway.port < 1 || gateway.port > 65_535) {
      throw new Error("Inference bridge host-gateway port is invalid");
    }
    this.options = { ...options };
    this.gatewayBinding = `tcp:${gateway.hostname}:${gateway.port}:${gateway.egressNetworkName}`;
    this.script = tcpBridgeScript(gateway.hostname, gateway.port);
  }

  async start(runId: string): Promise<ScopedInferenceBridgeHandle> {
    if (!SAFE.test(runId)) throw new Error("Inference bridge run ID is invalid");
    if (this.options.socketPath) {
      const socket = resolve(this.options.socketPath);
      const stat = lstatSync(socket);
      if (!stat.isSocket() || stat.isSymbolicLink()) {
        throw new Error("Inference bridge requires the exact local Unix gateway socket");
      }
      const entries = readdirSync(dirname(socket));
      if (entries.length !== 1 || entries[0] !== basename(socket)) {
        throw new Error("Inference bridge socket parent must be a dedicated run directory");
      }
    }
    await this.assertNetwork(this.options.networkName, true);
    if (this.options.hostGateway) await this.assertNetwork(this.options.hostGateway.egressNetworkName, false);
    const name = `valkyrie-inference-${sha(runId).slice(0, 20)}`;
    const labels = {
      "valkyrie.managed": "true", "valkyrie.kind": "inference-bridge",
      "valkyrie.run-id": runId, "valkyrie.gateway-sha256": sha(this.gatewayBinding),
    };
    const args = [
      "create", "--name", name, "--hostname", "valkyrie-inference", "--network", this.options.networkName,
      "--network-alias", "valkyrie-inference", "--ipc", "none", "--restart", "no", "--read-only", "--init",
      "--memory", String(128 * 1024 * 1024), "--cpus", "0.25", "--pids-limit", "32",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--security-opt", "seccomp=builtin",
      "--user", this.options.user, "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16777216",
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...(this.options.socketPath ? ["--mount", `type=bind,src=${dirname(this.options.socketPath)},dst=/gateway,readonly`] : []),
      "--workdir", "/tmp", "--entrypoint", "/usr/local/bin/node", this.options.image, "-e", this.script,
    ];
    let id: string;
    try {
      const created = await this.options.engine.invoke("create", args, this.timeoutMs);
      id = created.stdout.trim();
      if (!CONTAINER.test(id)) throw new Error("Inference bridge create did not return a full container ID");
    } catch (error) {
      const cleanupErrors = await this.cleanupUncertain(labels, name);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Inference bridge create failed and cleanup was not fully proven");
      }
      throw error;
    }
    try {
      const inspected = await this.options.engine.invoke("inspect", ["inspect", id], this.timeoutMs);
      this.assertInspect(JSON.parse(inspected.stdout), id, labels, name, false);
      if (this.options.hostGateway) {
        await this.options.engine.invoke(
          "network-connect", ["network", "connect", this.options.hostGateway.egressNetworkName, id], this.timeoutMs,
        );
        const connected = await this.options.engine.invoke("inspect", ["inspect", id], this.timeoutMs);
        this.assertInspect(JSON.parse(connected.stdout), id, labels, name, true);
      }
      await this.options.engine.invoke("start", ["start", id], this.timeoutMs);
      return { runId, id, name, gatewayBinding: this.gatewayBinding };
    } catch (error) {
      await this.removeExact(id).catch(() => undefined);
      throw error;
    }
  }

  async stop(handle: ScopedInferenceBridgeHandle): Promise<void> {
    const expectedName = `valkyrie-inference-${sha(handle.runId).slice(0, 20)}`;
    const labels = {
      "valkyrie.managed": "true", "valkyrie.kind": "inference-bridge",
      "valkyrie.run-id": handle.runId, "valkyrie.gateway-sha256": sha(this.gatewayBinding),
    };
    if (!CONTAINER.test(handle.id) || !SAFE.test(handle.runId) || handle.name !== expectedName
        || handle.gatewayBinding !== this.gatewayBinding) throw new Error("Inference bridge handle is invalid");
    const inspected = await this.options.engine.invoke("inspect", ["inspect", handle.id], this.timeoutMs);
    this.assertInspect(JSON.parse(inspected.stdout), handle.id, labels, expectedName, Boolean(this.options.hostGateway));
    await this.options.engine.invoke("stop", ["stop", "--time", "3", handle.id], this.timeoutMs).catch(async () => {
      await this.options.engine.invoke("kill", ["kill", handle.id], this.timeoutMs);
    });
    await this.removeExact(handle.id);
  }

  /**
   * A model pilot cannot resume its native process across control-plane
   * restarts. Remove only bridges whose exact image, socket, network, and
   * ownership labels still match this configured provider.
   */
  async reconcileStartup(): Promise<number> {
    const inventory = await this.options.engine.invoke("inventory", [
      "ps", "--no-trunc", "--all",
      "--filter", "label=valkyrie.managed=true",
      "--filter", "label=valkyrie.kind=inference-bridge",
      "--filter", `label=valkyrie.gateway-sha256=${sha(this.gatewayBinding)}`,
      "--format", "{{.ID}}",
    ], this.timeoutMs);
    const ids = inventory.stdout.split(/\r?\n/u).filter(Boolean);
    if (ids.length > 1_000 || new Set(ids).size !== ids.length || ids.some((id) => !CONTAINER.test(id))) {
      throw new Error("Inference bridge startup inventory is malformed or exceeds its bound");
    }
    let removed = 0;
    for (const id of ids) {
      const inspected = await this.options.engine.invoke("inspect", ["inspect", id], this.timeoutMs);
      let raw: any;
      try { raw = JSON.parse(inspected.stdout); } catch { throw new Error("Inference bridge restart inspection is invalid"); }
      const item = Array.isArray(raw) ? raw[0] : raw;
      const runId = item?.Config?.Labels?.["valkyrie.run-id"];
      if (typeof runId !== "string" || !SAFE.test(runId)) throw new Error("Inference bridge restart ownership label is invalid");
      const labels = {
        "valkyrie.managed": "true",
        "valkyrie.kind": "inference-bridge",
        "valkyrie.run-id": runId,
        "valkyrie.gateway-sha256": sha(this.gatewayBinding),
      };
      const name = `valkyrie-inference-${sha(runId).slice(0, 20)}`;
      this.assertInspect(raw, id, labels, name, Boolean(this.options.hostGateway));
      await this.removeExact(id);
      removed += 1;
    }
    return removed;
  }

  private async removeExact(id: string): Promise<void> {
    await this.options.engine.invoke("rm", ["rm", "--force", "--volumes", id], this.timeoutMs);
  }

  private async cleanupUncertain(labels: Record<string, string>, name: string): Promise<unknown[]> {
    const errors: unknown[] = [];
    let inventory: string;
    try {
      inventory = (await this.options.engine.invoke("inventory", [
        "ps", "--no-trunc", "--all",
        ...Object.entries(labels).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]),
        "--format", "{{.ID}}",
      ], this.timeoutMs)).stdout;
    } catch (error) { return [error]; }
    for (const id of inventory.split(/\r?\n/u).filter(Boolean)) {
      if (!CONTAINER.test(id)) { errors.push(new Error("Inference bridge inventory returned a malformed container ID")); continue; }
      try {
        const inspected = await this.options.engine.invoke("inspect", ["inspect", id], this.timeoutMs);
        this.assertInspect(JSON.parse(inspected.stdout), id, labels, name, false);
        await this.removeExact(id);
      } catch (error) { errors.push(error); }
    }
    return errors;
  }

  private async assertNetwork(name: string, internal: boolean): Promise<void> {
    const result = await this.options.engine.invoke(
      "network-inspect", ["network", "inspect", "--format", "{{json .}}", name], this.timeoutMs,
    );
    let network: any;
    try { network = JSON.parse(result.stdout); } catch { throw new Error("Inference bridge network inspection is invalid"); }
    if (!network || network.Name !== name || network.Internal !== internal
        || network.Ingress === true || network.Driver !== "bridge" || network.Scope !== "local") {
      throw new Error(`Inference bridge requires the exact local ${internal ? "internal" : "egress"} network`);
    }
  }

  private assertInspect(
    raw: unknown,
    id: string,
    labels: Record<string, string>,
    expectedName?: string,
    requireEgress = false,
  ): void {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || typeof value !== "object") throw new Error("Inference bridge inspect is invalid");
    const item = value as any;
    const networks = item.NetworkSettings?.Networks;
    const mounts = item.Mounts ?? [];
    if (item.Id !== id || (expectedName && item.Name !== `/${expectedName}`)
        || item.Config?.Image !== this.options.image || item.Config?.User !== this.options.user
        || Object.entries(labels).some(([key, expected]) => item.Config?.Labels?.[key] !== expected)
        || item.HostConfig?.NetworkMode !== this.options.networkName || !networks
        || Object.keys(networks).length !== (requireEgress ? 2 : 1) || !(this.options.networkName in networks)
        || (requireEgress && !(this.options.hostGateway!.egressNetworkName in networks))
        || item.HostConfig?.ReadonlyRootfs !== true || item.HostConfig?.Privileged !== false
        || item.HostConfig?.IpcMode !== "none" || item.HostConfig?.RestartPolicy?.Name !== "no"
        || !Array.isArray(item.HostConfig?.CapDrop) || item.HostConfig.CapDrop[0] !== "ALL"
        || item.HostConfig?.Memory !== 128 * 1024 * 1024 || item.HostConfig?.NanoCpus !== 250_000_000
        || item.HostConfig?.PidsLimit !== 32
        || !Array.isArray(item.HostConfig?.SecurityOpt)
        || !item.HostConfig.SecurityOpt.includes("no-new-privileges:true")
        || !item.HostConfig.SecurityOpt.includes("seccomp=builtin")
        || item.HostConfig?.Tmpfs?.["/tmp"] !== "rw,nosuid,nodev,noexec,size=16777216"
        || canonicalArray(item.Config?.Entrypoint) !== canonicalArray(["/usr/local/bin/node"])
        || canonicalArray(item.Config?.Cmd) !== canonicalArray(["-e", this.script])
        || (this.options.socketPath
          ? mounts.length !== 1 || mounts[0].Source !== dirname(this.options.socketPath)
            || mounts[0].Destination !== "/gateway" || mounts[0].RW !== false
          : mounts.length !== 0)) {
      throw new Error("Inference bridge effective ownership or isolation policy changed");
    }
  }
}

function canonicalArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : null);
}
