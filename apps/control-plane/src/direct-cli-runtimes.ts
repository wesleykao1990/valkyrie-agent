import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { RuntimeCancelledError, type RuntimeAdapter, type RuntimeContext } from "./runtime.ts";
import type { ControlPlaneStore } from "./store.ts";
import { canonicalJson } from "./store.ts";
import type { Approval, Artifact, Run, RunEvent, RuntimeCapabilities, RuntimeName, RuntimePreflight } from "./types.ts";
import type { WorkspaceManager } from "./workspace.ts";
import { JsonlLfDecoder } from "./atomic-rpc-client.ts";
import { id, nowIso } from "./ids.ts";

const BASE_ENVIRONMENT_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "TERM", "COLORTERM", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

interface ActiveProcess {
  child: ChildProcessWithoutNullStreams;
  context: RuntimeContext;
  nativeSessionId?: string;
  finalText?: string;
  terminalSuccess: boolean;
  terminalFailure?: string;
  stdoutBytes: number;
  stderrBytes: number;
  recordIndex: number;
  expectedMarker: string;
  chain: Promise<void>;
  cancelled: boolean;
  finalized: boolean;
  ready: (nativeSessionId: string) => void;
  rejectReady: (error: Error) => void;
  settled: Promise<void>;
  resolveSettled: () => void;
  executionTimer?: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
}

export interface DirectCliRuntimeOptions {
  name: "codex" | "claude";
  command: string;
  commandPrefixArgs?: string[];
  expectedVersion?: RegExp;
  store: ControlPlaneStore;
  workspaces: WorkspaceManager;
  artifactRoot: string;
  allowedEnvNames?: string[];
  startTimeoutMs?: number;
  executionTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxOutputBytes?: number;
}

function childEnvironment(additionalNames: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENVIRONMENT_NAMES, ...additionalNames]);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function connectivityMarker(objective: string): string {
  const match = /^Return exactly ([A-Z][A-Z0-9_]{2,63}) and nothing else\.$/.exec(objective);
  if (!match) {
    throw new Error(
      "Native direct runtimes accept only a fixed connectivity marker objective: "
      + "Return exactly MARKER and nothing else.",
    );
  }
  return match[1];
}

function boundedFile(path: string, maxBytes = 128_000): string {
  if (statSync(path).size > maxBytes) throw new Error(`Runtime context file exceeds ${maxBytes} bytes`);
  const value = readFileSync(path, "utf8");
  return value;
}

export class DirectCliRuntimeAdapter implements RuntimeAdapter {
  readonly name: RuntimeName;
  private readonly options: DirectCliRuntimeOptions;
  private readonly active = new Map<string, ActiveProcess>();

  constructor(options: DirectCliRuntimeOptions) {
    this.options = options;
    this.name = options.name;
    mkdirSync(options.artifactRoot, { recursive: true });
  }

  capabilities(): RuntimeCapabilities {
    return { steer: false, pause: false, resume: false, approve: false, artifacts: true };
  }

  async preflight(): Promise<RuntimePreflight> {
    const prefix = this.options.commandPrefixArgs ?? [];
    const versionResult = spawnSync(this.options.command, [...prefix, "--version"], {
      env: childEnvironment(this.options.allowedEnvNames),
      encoding: "utf8",
      timeout: 10_000,
    });
    if (versionResult.error || versionResult.status !== 0) {
      return {
        runtime: this.name,
        adapter: "native",
        enabled: true,
        available: false,
        executionMode: "read-only",
        command: this.options.command,
        authenticated: false,
        capabilities: this.capabilities(),
        reason: versionResult.error ? errorMessage(versionResult.error) : "Runtime version probe failed",
      };
    }
    const version = `${versionResult.stdout}${versionResult.stderr}`.trim().split("\n")[0] ?? "unknown";
    if (this.options.expectedVersion && !this.options.expectedVersion.test(version)) {
      return {
        runtime: this.name,
        adapter: "native",
        enabled: true,
        available: false,
        executionMode: "read-only",
        command: this.options.command,
        version,
        authenticated: "unknown",
        capabilities: this.capabilities(),
        reason: `Installed version does not match the pinned contract ${this.options.expectedVersion}`,
      };
    }

    let authenticated: boolean;
    let authReason: string;
    if (this.name === "claude") {
      authenticated = Boolean(
        this.options.allowedEnvNames?.includes("ANTHROPIC_API_KEY")
        && process.env.ANTHROPIC_API_KEY,
      );
      authReason = authenticated
        ? "Pinned native CLI and an explicitly allow-listed API key are available for --bare mode"
        : "Claude --bare mode requires ANTHROPIC_API_KEY in CLAUDE_RUNTIME_ENV_ALLOWLIST; OAuth/keychain auth is intentionally ignored";
    } else {
      const auth = spawnSync(this.options.command, [...prefix, "login", "status"], {
        env: childEnvironment(this.options.allowedEnvNames),
        encoding: "utf8",
        timeout: 10_000,
      });
      authenticated = auth.status === 0;
      authReason = authenticated
        ? "Pinned native CLI and authentication are available"
        : "Native CLI is installed but authentication is unavailable";
    }
    return {
      runtime: this.name,
      adapter: "native",
      enabled: true,
      available: authenticated,
      executionMode: "read-only",
      command: this.options.command,
      version,
      authenticated,
      capabilities: this.capabilities(),
      reason: authReason,
    };
  }

  async start(context: RuntimeContext) {
    if (this.active.has(context.run.id)) throw new Error(`${this.name} already has an active process for run ${context.run.id}`);
    if (context.run.workflow !== "runtime-connectivity") {
      throw new Error(`${this.name} native adapter is limited to workflow=runtime-connectivity in this milestone`);
    }
    const expectedMarker = connectivityMarker(context.objective);
    await this.assertLease(context);
    if (!context.contextPack || !context.runContract) throw new Error("Native runtime requires context-pack and run-contract artifacts");
    const preflight = await this.preflight();
    if (!preflight.available) throw new Error(preflight.reason ?? `${this.name} native runtime is unavailable`);

    const prompt = this.buildPrompt(context);
    const args = [...(this.options.commandPrefixArgs ?? []), ...this.runtimeArgs(context, prompt)];
    const child = spawn(this.options.command, args, {
      cwd: context.workspacePath,
      env: childEnvironment(this.options.allowedEnvNames),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawnConfirmed = false;
    const spawned = new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    let readyResolve!: (nativeSessionId: string) => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => undefined);
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const active: ActiveProcess = {
      child,
      context,
      terminalSuccess: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      recordIndex: 0,
      expectedMarker,
      chain: Promise.resolve(),
      cancelled: false,
      finalized: false,
      ready: readyResolve,
      rejectReady: readyReject,
      settled,
      resolveSettled,
      executionTimer: undefined,
      forceTimer: undefined,
    };
    active.executionTimer = setTimeout(() => {
      active.terminalFailure = `Native runtime exceeded the ${this.options.executionTimeoutMs ?? 600_000}ms execution bound`;
      this.requestTermination(active);
    }, this.options.executionTimeoutMs ?? 600_000);
    active.executionTimer.unref?.();
    this.active.set(context.run.id, active);

    const decoder = new JsonlLfDecoder({ maxLineBytes: 1024 * 1024 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("error", (error) => {
      active.terminalFailure = `Native stdout failed: ${error.message}`;
      this.requestTermination(active);
    });
    child.stdout.on("data", (chunk: string) => {
      active.stdoutBytes += Buffer.byteLength(chunk);
      if (active.stdoutBytes + active.stderrBytes > (this.options.maxOutputBytes ?? 8 * 1024 * 1024)) {
        active.terminalFailure = "Native runtime exceeded the bounded output allowance";
        this.requestTermination(active);
        return;
      }
      let records: string[];
      try { records = decoder.push(chunk); }
      catch (error) {
        active.terminalFailure = `JSONL framing error: ${errorMessage(error)}`;
        this.requestTermination(active);
        return;
      }
      for (const line of records) {
        active.chain = active.chain
          .then(() => this.handleLine(active, line))
          .catch((error) => {
            active.terminalFailure = `Native event persistence failed: ${errorMessage(error)}`;
            this.requestTermination(active);
          });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      active.stderrBytes += chunk.length;
      if (active.stdoutBytes + active.stderrBytes > (this.options.maxOutputBytes ?? 8 * 1024 * 1024)) {
        active.terminalFailure = "Native runtime exceeded the bounded output allowance";
        this.requestTermination(active);
      }
    });
    child.stderr.on("error", (error) => {
      active.terminalFailure = `Native stderr failed: ${error.message}`;
      this.requestTermination(active);
    });
    child.stdin.on("error", (error) => {
      active.terminalFailure = `Native stdin failed: ${error.message}`;
      this.requestTermination(active);
    });

    const readyTimer = setTimeout(() => {
      if (!active.nativeSessionId) {
        active.terminalFailure = "Native runtime did not emit a session identifier before the start timeout";
        this.requestTermination(active);
        readyReject(new Error(active.terminalFailure));
      }
    }, this.options.startTimeoutMs ?? 20_000);
    active.ready = (nativeSessionId) => {
      clearTimeout(readyTimer);
      readyResolve(nativeSessionId);
    };
    active.rejectReady = (error) => {
      clearTimeout(readyTimer);
      readyReject(error);
    };

    child.once("error", (error) => {
      active.terminalFailure = `Native process error: ${error.message}`;
      if (spawnConfirmed) active.rejectReady(error);
    });
    child.once("close", (code, signal) => {
      const trailing = decoder.pending();
      if (trailing.length > 0) active.terminalFailure = "Native runtime exited with a non-LF-terminated JSON record";
      void active.chain
        .then(() => this.finalize(active, code, signal))
        .finally(() => {
          clearTimeout(active.executionTimer);
          clearTimeout(active.forceTimer);
          active.resolveSettled();
        });
    });

    try {
      await spawned;
      spawnConfirmed = true;
      const startedAt = nowIso();
      const current = await this.options.store.getRun(context.run.id) ?? context.run;
      await this.options.store.updateRun(context.run.id, {
        status: "running",
        stage: "native_read_only",
        stageIndex: 0,
        startedAt,
        nextActionAt: null,
        metadata: {
          ...current.metadata,
          adapter: "native",
          simulated: false,
          executionMode: "read-only",
          runtimeCommand: this.options.command,
          runtimeVersion: preflight.version,
          contextPackRef: context.contextPack.uri,
          runContractRef: context.runContract.uri,
          finalAction: "analysis_only",
          crossProcessResume: false,
          budgetEnforcement: this.name === "claude" ? "native-max-cost-plus-wall-clock" : "wall-clock-only",
        },
      });
      await this.normalizedEvent(context.run.id, "run.started", `${this.name} native read-only process started`, {
        runtime: this.name,
        adapter: "native",
        executionMode: "read-only",
        version: preflight.version,
      });
    } catch (error) {
      clearTimeout(readyTimer);
      active.cancelled = true;
      this.requestTermination(active);
      await active.settled;
      throw error;
    }
    child.stdin.end(prompt, "utf8");

    try {
      const nativeSessionId = await ready;
      return {
        runtime: this.name,
        nativeRunId: nativeSessionId,
        nativeSessionId,
        runtimeVersion: preflight.version,
        metadata: { executionMode: "read-only", crossProcessResume: false },
      };
    } catch (error) {
      this.requestTermination(active);
      await active.settled;
      throw error;
    }
  }

  async advance(_run: Run): Promise<void> {}

  async steer(_run: Run, _message: string): Promise<void> {
    throw new Error(`${this.name} minimum native adapter does not support in-flight steering`);
  }

  async cancel(run: Run): Promise<void> {
    const active = this.active.get(run.id);
    if (active) {
      active.cancelled = true;
      active.rejectReady(new RuntimeCancelledError(`${this.name} native process was cancelled`));
      this.requestTermination(active);
      await active.settled;
    }
    const completedAt = nowIso();
    await this.options.store.updateRun(run.id, { status: "cancelled", stage: "cancelled", completedAt, nextActionAt: null });
    if (run.workspaceId) await this.options.workspaces.release(run.workspaceId, run.id);
    await this.normalizedEvent(run.id, "run.cancelled", `${this.name} native process was cancelled`, { runtime: this.name });
  }

  async resolveApproval(_run: Run, _approval: Approval, _decision: string): Promise<void> {
    throw new Error(`${this.name} minimum native adapter has no mapped native approval capability`);
  }

  async shutdown(): Promise<void> {
    const activeProcesses = [...this.active.values()];
    await Promise.all(activeProcesses.map((active) => this.cancel(active.context.run)));
  }

  private runtimeArgs(context: RuntimeContext, prompt: string): string[] {
    if (this.name === "codex") {
      return [
        "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check",
        "--ephemeral", "--ignore-user-config", "--ignore-rules", "-C", context.workspacePath,
        "-",
      ];
    }
    return [
      "--bare", "--print", "--verbose", "--output-format", "stream-json", "--input-format", "text",
      "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", "{}", "--no-chrome",
      "--permission-mode", "dontAsk", "--disable-slash-commands", "--no-session-persistence",
      "--max-budget-usd", String(context.run.budgetUsd),
    ];
  }

  private buildPrompt(context: RuntimeContext): string {
    const contextPack = boundedFile(context.contextPack!.path);
    const runContract = boundedFile(context.runContract!.path);
    return [
      "You are running a bounded read-only Valkyrie control-plane connectivity test.",
      "Do not modify files, execute destructive actions, create a PR, deploy, or promote memory.",
      "Do not inspect paths outside the supplied context. Return a concise factual result only.",
      "",
      "Exact objective:",
      context.objective,
      "",
      "Run contract:",
      runContract,
      "",
      "Bounded Project Brain context pack:",
      contextPack,
    ].join("\n");
  }

  private async assertLease(context: RuntimeContext): Promise<void> {
    if (!context.workspace || !context.writerLease) throw new Error("Native runtime requires the persisted workspace and writer lease");
    if (context.workspace.id !== context.writerLease.workspaceId || context.run.id !== context.writerLease.runId) {
      throw new Error("Native runtime workspace/lease ownership mismatch");
    }
    const leases = await this.options.store.listLeases();
    const lease = leases.find((item) => item.workspaceId === context.workspace!.id && item.runId === context.run.id);
    if (!lease || lease.mode !== "writer" || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new Error("Native runtime requires an active owned writer lease before spawn");
    }
    for (const artifact of [context.contextPack, context.runContract]) {
      if (!artifact) continue;
      const root = resolve(context.workspacePath);
      const path = resolve(artifact.path);
      if (path === root || !path.startsWith(`${root}${sep}`)) {
        throw new Error("Native runtime context artifacts must be contained by the owned workspace");
      }
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        throw new Error("Native runtime context artifacts must be regular non-symlink files");
      }
      const realRoot = realpathSync(root);
      const realPath = realpathSync(path);
      if (!realPath.startsWith(`${realRoot}${sep}`)) {
        throw new Error("Native runtime context artifact realpath escaped the owned workspace");
      }
      const actualChecksum = digest(readFileSync(realPath));
      if (actualChecksum !== artifact.checksum) throw new Error("Native runtime context artifact checksum mismatch");
    }
  }

  private async handleLine(active: ActiveProcess, line: string): Promise<void> {
    let value: Record<string, any>;
    try { value = JSON.parse(line); }
    catch {
      active.terminalFailure = "Native runtime emitted malformed JSONL";
      this.requestTermination(active);
      return;
    }
    active.recordIndex += 1;
    await this.rawEvent(active, value);

    const sessionId = this.name === "codex"
      ? (value.type === "thread.started" ? value.thread_id : undefined)
      : (value.session_id ?? (value.type === "system" && value.subtype === "init" ? value.session_id : undefined));
    if (typeof sessionId === "string" && sessionId.length > 0 && !active.nativeSessionId) {
      active.nativeSessionId = sessionId;
      active.ready(sessionId);
      await this.normalizedEvent(active.context.run.id, "runtime.session_started", `${this.name} native session started`, {
        runtime: this.name,
        nativeSessionId: sessionId,
      });
    }

    if (this.name === "codex") {
      if (value.type === "item.completed" && value.item?.type === "agent_message") active.finalText = String(value.item.text ?? "");
      if (value.type === "turn.completed") active.terminalSuccess = true;
      if (value.type === "turn.failed" || value.type === "error") active.terminalFailure = String(value.error?.message ?? value.message ?? value.type);
    } else {
      if (value.type === "result") {
        active.finalText = typeof value.result === "string" ? value.result : JSON.stringify(value.result ?? value, null, 2);
        active.terminalSuccess = value.subtype === "success" && value.is_error !== true;
        if (!active.terminalSuccess) active.terminalFailure = String(value.error ?? value.result ?? "Claude Code result reported failure");
        if (typeof value.total_cost_usd === "number") {
          await this.options.store.updateRun(active.context.run.id, { costUsd: value.total_cost_usd });
        }
      }
    }
  }

  private async finalize(active: ActiveProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (active.finalized) return;
    active.finalized = true;
    this.active.delete(active.context.run.id);
    const run = await this.options.store.getRun(active.context.run.id);
    if (!run || active.cancelled || run.status === "cancelled") return;

    if (!active.nativeSessionId) {
      active.rejectReady(
        new Error(active.terminalFailure ?? `Native process exited before session start (code=${code}, signal=${signal})`),
      );
    }
    const completedAt = nowIso();
    const finalText = active.finalText?.trim() ?? "";
    if (code === 0 && active.terminalSuccess && finalText !== active.expectedMarker) {
      active.terminalFailure = "Native runtime result did not exactly match the bound connectivity marker";
    }
    const successful = code === 0 && active.terminalSuccess && !active.terminalFailure;
    try {
      if (finalText) await this.storeResultArtifact(run, finalText);
      const refreshed = await this.options.store.getRun(run.id) ?? run;
      await this.options.store.updateRun(run.id, {
        status: successful ? "completed" : "failed",
        stage: successful ? "completed" : "native_failed",
        completedAt,
        nextActionAt: null,
        metadata: {
          ...refreshed.metadata,
          nativeSessionId: active.nativeSessionId,
          nativeExitCode: code,
          nativeExitSignal: signal,
          nativeStderrBytes: active.stderrBytes,
          nativeStdoutBytes: active.stdoutBytes,
          nativeFailure: active.terminalFailure,
        },
      });
      await this.normalizedEvent(
        run.id,
        successful ? "run.completed" : "run.failed",
        successful ? `${this.name} native read-only run completed` : `${this.name} native read-only run failed`,
        { runtime: this.name, nativeSessionId: active.nativeSessionId, code, signal, reason: active.terminalFailure },
      );
    } finally {
      if (run.workspaceId) await this.options.workspaces.release(run.workspaceId, run.id);
    }
  }

  private async storeResultArtifact(run: Run, body: string): Promise<void> {
    const dir = join(this.options.artifactRoot, run.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.name}-native-result.md`);
    writeFileSync(path, body, "utf8");
    const artifact: Artifact = {
      id: id("artifact"),
      runId: run.id,
      kind: "native-result",
      uri: path,
      checksum: digest(body),
      mediaType: "text/markdown",
      createdAt: nowIso(),
    };
    await this.options.store.createArtifact(artifact);
    await this.normalizedEvent(run.id, "artifact.created", `${this.name} native result stored`, {
      artifactId: artifact.id,
      checksum: artifact.checksum,
      uri: artifact.uri,
    });
  }

  private async rawEvent(active: ActiveProcess, rawNative: Record<string, unknown>): Promise<void> {
    const runId = active.context.run.id;
    const recordIndex = active.recordIndex;
    const nativeId = String(
      rawNative.id
      ?? rawNative.thread_id
      ?? rawNative.session_id
      ?? (rawNative.item as Record<string, unknown> | undefined)?.id
      ?? recordIndex,
    );
    const hash = digest(`${this.name}\0${runId}\0${recordIndex}\0${nativeId}\0${canonicalJson(rawNative)}`);
    await this.options.store.appendEvent({
      id: `event_native_${hash.slice(0, 32)}`,
      runId,
      type: "runtime.native",
      message: `${this.name} native JSONL record retained`,
      payload: { runtime: this.name, nativeId, recordIndex, rawNative },
      createdAt: nowIso(),
    });
  }

  private async normalizedEvent(runId: string, type: string, message: string, payload: Record<string, unknown>): Promise<void> {
    const record: Omit<RunEvent, "seq"> = { id: id("event"), runId, type, message, payload, createdAt: nowIso() };
    await this.options.store.appendEvent(record);
  }

  private requestTermination(active: ActiveProcess): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (active.forceTimer) return;
    active.forceTimer = setTimeout(() => {
      if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGKILL");
    }, this.options.stopTimeoutMs ?? 2_000);
    active.forceTimer.unref?.();
  }
}
