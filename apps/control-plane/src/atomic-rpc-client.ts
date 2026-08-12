import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

const BASE_RUNTIME_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "TERM", "COLORTERM", "SSL_CERT_FILE", "SSL_CERT_DIR"
];

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TRANSPORT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const MAX_EARLY_RECORDS = 1_024;
const MAX_EARLY_RECORD_BYTES = 4 * 1024 * 1024;

export function selectRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additionalNames: string[] = [],
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const configured = (source.ATOMIC_RUNTIME_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const allowed = new Set([...BASE_RUNTIME_ENV, ...configured, ...additionalNames]);
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...overrides };
}

export type AtomicRpcStreamingBehavior = "steer" | "followUp";

export interface AtomicRpcPromptCommand {
  type: "prompt";
  message: string;
  images?: unknown[];
  streamingBehavior?: AtomicRpcStreamingBehavior;
}

export interface AtomicRpcSteerCommand {
  type: "steer";
  message: string;
  images?: unknown[];
}

export interface AtomicRpcFollowUpCommand {
  type: "follow_up";
  message: string;
  images?: unknown[];
}

export interface AtomicRpcGetStateCommand {
  type: "get_state";
}

export interface AtomicRpcGetEntriesCommand {
  type: "get_entries";
  since?: string;
}

export interface AtomicRpcGetSessionStatsCommand {
  type: "get_session_stats";
}

export interface AtomicRpcGetCommandsCommand {
  type: "get_commands";
}

export interface AtomicRpcGetAvailableModelsCommand {
  type: "get_available_models";
}

export interface AtomicRpcAbortCommand {
  type: "abort";
}

/**
 * Atomic adds commands over time. Known commands receive dedicated helpers,
 * while this structural fallback keeps discovery and pinned-version probes
 * possible without weakening response correlation.
 */
export interface AtomicRpcCustomCommand {
  type: string;
  [key: string]: unknown;
}

export type AtomicRpcCommand =
  | AtomicRpcPromptCommand
  | AtomicRpcSteerCommand
  | AtomicRpcFollowUpCommand
  | AtomicRpcGetStateCommand
  | AtomicRpcGetEntriesCommand
  | AtomicRpcGetSessionStatsCommand
  | AtomicRpcGetCommandsCommand
  | AtomicRpcGetAvailableModelsCommand
  | AtomicRpcAbortCommand
  | AtomicRpcCustomCommand;

export interface AtomicRpcResponse<T = unknown> {
  type: "response";
  id: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
  [key: string]: unknown;
}

export interface AtomicRpcNativeEvent {
  type: string;
  [key: string]: unknown;
}

export interface AtomicRpcExtensionUiResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface AtomicRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AtomicRpcStartOptions {
  provider?: string;
  model?: string;
  cwd: string;
  allowedEnvNames?: string[];
  env?: Record<string, string>;
  sessionDir?: string;
  name?: string;
  extensions?: string[];
  approve?: boolean;
  extraArgs?: string[];
  /** Ignore ATOMIC_RUNTIME_ENV_ALLOWLIST from the parent for a credential-free discovery process. */
  inheritConfiguredEnvAllowlist?: boolean;
  /**
   * Do not inherit even the normal base runtime environment. This is intended
   * for a fixed wrapper process such as a local OCI CLI, where every required
   * non-secret variable is supplied explicitly through `env`.
   */
  inheritBaseRuntimeEnvironment?: boolean;
}

export interface AtomicRpcClientOptions {
  command?: string;
  /** Arguments placed before Atomic's own arguments; useful for pinned wrappers. */
  commandArgs?: string[];
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxLineBytes?: number;
  /** Maximum bytes in one outbound LF-JSONL frame. */
  maxFrameBytes?: number;
  /** Cumulative inbound and outbound transport budget for one process. */
  maxTransportBytes?: number;
  maxPendingRequests?: number;
  /** Reject every later start attempt after the first, including after exit. */
  singleUse?: boolean;
  /** Disable the separate subprocess version probe on a provider-owned client. */
  allowVersionProbe?: boolean;
}

export interface AtomicVersionProbeOptions {
  /** Arguments placed before `--version`, for example a pinned Node wrapper. */
  commandArgs?: string[];
  cwd?: string;
  allowedEnvNames?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Ignore ATOMIC_RUNTIME_ENV_ALLOWLIST from the parent for credential-free probing. */
  inheritConfiguredEnvAllowlist?: boolean;
}

export interface AtomicVersionProbeResult {
  version: string;
  stdout: string;
  stderr: string;
}

export type AtomicRpcProtocolIssueKind =
  | "invalid_json"
  | "invalid_record"
  | "line_too_large"
  | "trailing_record"
  | "invalid_response"
  | "unmatched_response"
  | "response_command_mismatch";

export interface AtomicRpcProtocolIssue {
  kind: AtomicRpcProtocolIssueKind;
  error: Error;
  line?: string;
  lineBytes?: number;
}

export interface AtomicRpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  trailingRecord: string;
  expected: boolean;
}

export interface AtomicRpcClientEventMap {
  /** Every validated JSON object in exact stdout order, before correlation/dispatch. */
  record: [record: AtomicRpcResponse | AtomicRpcNativeEvent];
  event: [event: AtomicRpcNativeEvent];
  stderr: [text: string];
  protocol_error: [issue: AtomicRpcProtocolIssue];
  spawn_error: [error: Error];
  transport_error: [details: { stream: "stdin" | "stdout" | "stderr"; error: Error }];
  backpressure: [details: { id?: string; bytes: number }];
  spawn: [details: { pid: number | undefined; command: string; args: string[] }];
  exit: [details: AtomicRpcExitInfo];
}

export class AtomicRpcError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AtomicRpcProtocolError extends AtomicRpcError {
  readonly kind: AtomicRpcProtocolIssueKind;
  readonly lineBytes?: number;

  constructor(kind: AtomicRpcProtocolIssueKind, message: string, lineBytes?: number, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.lineBytes = lineBytes;
  }
}

export class AtomicRpcCommandError extends AtomicRpcError {
  readonly response: AtomicRpcResponse;

  constructor(response: AtomicRpcResponse) {
    super(response.error ?? `Atomic RPC command ${response.command} failed`);
    this.response = response;
  }
}

export class AtomicRpcTimeoutError extends AtomicRpcError {
  readonly requestId: string;
  readonly command: string;
  readonly timeoutMs: number;

  constructor(requestId: string, command: string, timeoutMs: number) {
    super(`Atomic RPC command ${command} (${requestId}) timed out after ${timeoutMs}ms`);
    this.requestId = requestId;
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export class AtomicRpcProcessError extends AtomicRpcError {}
export class AtomicRpcStoppedError extends AtomicRpcError {}
export class AtomicRpcStopUncertainError extends AtomicRpcProcessError {}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function errorFrom(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : fallback);
}

function previewLine(line: string, max = 4_096): string {
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/**
 * Strict UTF-8, LF-only JSONL decoder.
 *
 * Atomic explicitly permits U+2028/U+2029 inside JSON strings and warns
 * against Node's readline helper. Optional CR before LF is stripped. A byte
 * bound is deliberate process-boundary protection: records above it are
 * rejected instead of being truncated or partially parsed.
 */
export class JsonlLfDecoder {
  private buffer = "";
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private readonly maxLineBytes: number;
  private ended = false;

  constructor(options: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
  }

  push(chunk: string | Uint8Array): string[] {
    if (this.ended) throw new AtomicRpcProtocolError("invalid_record", "Cannot push data after JSONL decoder finish");
    let text: string;
    try {
      text = typeof chunk === "string" ? chunk : this.utf8.decode(chunk, { stream: true });
    } catch (cause) {
      throw new AtomicRpcProtocolError("invalid_record", "Atomic RPC emitted invalid UTF-8", undefined, { cause });
    }
    this.buffer += text;
    const records: string[] = [];
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const record = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.assertWithinLimit(record);
      if (record.length > 0) records.push(record);
    }
    this.assertWithinLimit(this.buffer);
    return records;
  }

  finish(): string {
    if (!this.ended) {
      this.ended = true;
      try {
        this.buffer += this.utf8.decode();
      } catch (cause) {
        throw new AtomicRpcProtocolError("invalid_record", "Atomic RPC ended with invalid UTF-8", undefined, { cause });
      }
      this.assertWithinLimit(this.buffer);
    }
    return this.buffer;
  }

  pending(): string {
    return this.buffer;
  }

  private assertWithinLimit(record: string): void {
    const bytes = Buffer.byteLength(record, "utf8");
    if (bytes > this.maxLineBytes) {
      throw new AtomicRpcProtocolError(
        "line_too_large",
        `Atomic RPC JSONL record exceeded ${this.maxLineBytes} bytes (received at least ${bytes})`,
        bytes,
      );
    }
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: AtomicRpcResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

/**
 * Typed transport for Atomic's LF-delimited JSONL RPC mode.
 *
 * This class only owns the subprocess protocol. Runtime lifecycle mapping,
 * approvals, workspace policy, and event persistence remain control-plane
 * adapter responsibilities.
 */
export class AtomicRpcClient extends EventEmitter<AtomicRpcClientEventMap> {
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxFrameBytes: number;
  private readonly maxTransportBytes: number;
  private readonly maxPendingRequests: number;
  private readonly singleUse: boolean;
  private readonly allowVersionProbe: boolean;
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: JsonlLfDecoder | null = null;
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private writeChain: Promise<void> = Promise.resolve();
  private terminalError: Error | undefined;
  private stopping = false;
  private closePromise: Promise<AtomicRpcExitInfo> | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveClose: ((value: AtomicRpcExitInfo) => void) | null = null;
  private gracefulStopTimer: NodeJS.Timeout | undefined;
  private forceStopTimer: NodeJS.Timeout | undefined;
  private transportBytes = 0;
  private startedOnce = false;
  private earlyRecords: Array<AtomicRpcResponse | AtomicRpcNativeEvent> = [];
  private earlyRecordBytes = 0;
  private earlyRecordsDrained = false;

  constructor(commandOrOptions: string | AtomicRpcClientOptions = process.env.ATOMIC_COMMAND ?? "atomic") {
    super();
    const options = typeof commandOrOptions === "string"
      ? { command: commandOrOptions }
      : commandOrOptions;
    this.command = options.command ?? process.env.ATOMIC_COMMAND ?? "atomic";
    this.commandArgs = [...(options.commandArgs ?? [])];
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.stopTimeoutMs = positiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs");
    this.maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
    this.maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
    this.maxTransportBytes = positiveInteger(
      options.maxTransportBytes,
      DEFAULT_MAX_TRANSPORT_BYTES,
      "maxTransportBytes",
    );
    if (this.maxLineBytes > this.maxTransportBytes || this.maxFrameBytes > this.maxTransportBytes) {
      throw new TypeError("maxTransportBytes must be at least maxLineBytes and maxFrameBytes");
    }
    this.maxPendingRequests = positiveInteger(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      "maxPendingRequests",
    );
    this.singleUse = options.singleUse ?? false;
    this.allowVersionProbe = options.allowVersionProbe ?? true;
  }

  start(options: AtomicRpcStartOptions): void {
    if (this.child) throw new Error("Atomic RPC process already started");
    if (this.singleUse && this.startedOnce) throw new Error("Atomic RPC client is single-use and cannot be restarted");
    this.startedOnce = true;
    const args = [...this.commandArgs, "--mode", "rpc"];
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.name) args.push("--name", options.name);
    for (const extension of options.extensions ?? []) args.push("-e", extension);
    if (options.approve === true) args.push("--approve");
    else if (options.approve === false) args.push("--no-approve");
    args.push(...(options.extraArgs ?? []));

    const sourceEnvironment = options.inheritBaseRuntimeEnvironment === false
      ? { ATOMIC_RUNTIME_ENV_ALLOWLIST: "" }
      : options.inheritConfiguredEnvAllowlist === false
        ? { ...process.env, ATOMIC_RUNTIME_ENV_ALLOWLIST: "" }
        : process.env;
    const child = spawn(this.command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: selectRuntimeEnvironment(
        sourceEnvironment,
        options.allowedEnvNames,
        options.env,
      ),
    });

    this.child = child;
    this.decoder = new JsonlLfDecoder({ maxLineBytes: this.maxLineBytes });
    this.terminalError = undefined;
    this.stopping = false;
    this.transportBytes = 0;
    this.writeChain = Promise.resolve();
    this.earlyRecords = [];
    this.earlyRecordBytes = 0;
    this.earlyRecordsDrained = false;
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    this.stopPromise = null;

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(child, chunk));
    child.stdout.on("error", (value) => this.handleTransportError(child, "stdout", value));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.reserveTransportBytes(child, "stderr", chunk.byteLength)) {
        this.emit("stderr", chunk.toString("utf8"));
      }
    });
    child.stderr.on("error", (value) => this.handleTransportError(child, "stderr", value));
    child.stdin.on("error", (value) => this.handleTransportError(child, "stdin", value));
    child.once("spawn", () => this.emit("spawn", { pid: child.pid, command: this.command, args: [...args] }));
    child.once("error", (value) => this.handleSpawnError(child, value));
    child.once("close", (code, signal) => this.finalizeProcess(child, code, signal));
  }

  async prompt(message: string, options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse> {
    return this.request({ type: "prompt", message }, options);
  }

  async steer(message: string, options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse> {
    return this.request({ type: "steer", message }, options);
  }

  async followUp(message: string, options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse> {
    return this.request({ type: "follow_up", message }, options);
  }

  async getState<T = unknown>(options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse<T>> {
    return this.request<T>({ type: "get_state" }, options);
  }

  async getEntries<T = unknown>(since?: string, options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse<T>> {
    return this.request<T>({ type: "get_entries", ...(since === undefined ? {} : { since }) }, options);
  }

  async getSessionStats<T = unknown>(options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse<T>> {
    return this.request<T>({ type: "get_session_stats" }, options);
  }

  async getCommands<T = unknown>(options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse<T>> {
    return this.request<T>({ type: "get_commands" }, options);
  }

  async getAvailableModels<T = unknown>(options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse<T>> {
    return this.request<T>({ type: "get_available_models" }, options);
  }

  async abort(options?: AtomicRpcRequestOptions): Promise<AtomicRpcResponse> {
    return this.request({ type: "abort" }, options);
  }

  async request<T = unknown>(command: AtomicRpcCommand, options: AtomicRpcRequestOptions = {}): Promise<AtomicRpcResponse<T>> {
    const child = this.child;
    if (!child) throw new AtomicRpcProcessError("Atomic RPC process is not started");
    if (this.stopping) throw new AtomicRpcStoppedError("Atomic RPC process is stopping");
    if (typeof command.type !== "string" || command.type.length === 0 || command.type === "response") {
      throw new TypeError("Atomic RPC command requires a non-response type");
    }
    if (Object.hasOwn(command, "id")) throw new TypeError("Atomic RPC request IDs are owned by AtomicRpcClient");
    if (this.pending.size >= this.maxPendingRequests) {
      throw new AtomicRpcError(`Atomic RPC pending request limit ${this.maxPendingRequests} reached`);
    }

    const timeoutMs = positiveInteger(options.timeoutMs, this.requestTimeoutMs, "timeoutMs");
    const id = `req-${++this.sequence}`;
    const payload = { id, ...command };

    const promise = new Promise<AtomicRpcResponse<T>>((resolve, reject) => {
      const pending: PendingRequest = {
        command: command.type,
        resolve: (value) => resolve(value as AtomicRpcResponse<T>),
        reject,
        signal: options.signal,
      };
      pending.timer = setTimeout(() => {
        this.rejectPending(id, new AtomicRpcTimeoutError(id, command.type, timeoutMs));
      }, timeoutMs);
      pending.timer.unref?.();
      if (options.signal) {
        pending.abortListener = () => {
          this.rejectPending(id, errorFrom(options.signal?.reason, `Atomic RPC command ${command.type} aborted`));
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
    });

    if (options.signal?.aborted) {
      this.rejectPending(id, errorFrom(options.signal.reason, `Atomic RPC command ${command.type} aborted`));
      return promise;
    }

    void this.enqueueFrame(child, payload, id).catch((value) => {
      this.rejectPending(id, errorFrom(value, `Failed to write Atomic RPC command ${command.type}`));
    });
    return promise;
  }

  /** Send the response half of Atomic's extension UI sub-protocol. */
  async respondToExtensionUi(response: AtomicRpcExtensionUiResponse): Promise<void> {
    const child = this.child;
    if (!child) throw new AtomicRpcProcessError("Atomic RPC process is not started");
    if (this.stopping) throw new AtomicRpcStoppedError("Atomic RPC process is stopping");
    if (!response.id) throw new TypeError("Atomic extension UI response requires an id");
    await this.enqueueFrame(child, response);
  }

  /** Probe the separately versioned CLI boundary; Atomic RPC has no version command. */
  async probeVersion(options: AtomicVersionProbeOptions = {}): Promise<AtomicVersionProbeResult> {
    if (!this.allowVersionProbe) throw new AtomicRpcError("Atomic version probe is disabled for this client");
    return probeAtomicVersion(this.command, {
      ...options,
      commandArgs: this.commandArgs,
    });
  }

  /**
   * Close stdin first, then escalate from SIGTERM to SIGKILL if the subprocess
   * does not leave within the configured bound. Repeated calls join the same
   * close promise.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.stopPromise) return this.stopPromise;
    const closePromise = this.closePromise;
    if (!this.stopping) {
      this.stopping = true;
      this.rejectAll(new AtomicRpcStoppedError("Atomic RPC process stopped by control plane"));
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      const termDelay = Math.min(250, Math.max(1, Math.floor(this.stopTimeoutMs / 2)));
      this.gracefulStopTimer = setTimeout(() => {
        if (this.child === child) child.kill("SIGTERM");
      }, termDelay);
      this.gracefulStopTimer.unref?.();
      this.forceStopTimer = setTimeout(() => {
        if (this.child === child) child.kill("SIGKILL");
      }, this.stopTimeoutMs);
      this.forceStopTimer.unref?.();
    }
    if (!closePromise) throw new AtomicRpcStopUncertainError("Atomic RPC close state is unavailable");
    const finalWaitMs = this.stopTimeoutMs + Math.min(1_000, Math.max(25, Math.floor(this.stopTimeoutMs / 2)));
    this.stopPromise = new Promise<void>((resolveStop, rejectStop) => {
      const finalTimer = setTimeout(() => {
        if (this.child === child) {
          child.kill("SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
        rejectStop(new AtomicRpcStopUncertainError(
          `Atomic RPC host transport did not close within ${finalWaitMs}ms after bounded termination`,
        ));
      }, finalWaitMs);
      finalTimer.unref?.();
      closePromise.then(() => {
        clearTimeout(finalTimer);
        resolveStop();
      });
    });
    return this.stopPromise;
  }

  /**
   * Attaches the authoritative raw-record consumer and synchronously replays
   * the bounded startup journal. This closes the start-before-listener race for
   * provider-owned subprocesses without retaining a full-session transcript.
   */
  subscribeRecords(listener: (record: AtomicRpcResponse | AtomicRpcNativeEvent) => void): () => void {
    this.on("record", listener);
    if (!this.earlyRecordsDrained) {
      this.earlyRecordsDrained = true;
      const pending = this.earlyRecords;
      this.earlyRecords = [];
      this.earlyRecordBytes = 0;
      for (const record of pending) listener(record);
    }
    return () => this.off("record", listener);
  }

  private enqueueFrame(child: ChildProcessWithoutNullStreams, value: object, id?: string): Promise<void> {
    const frame = `${JSON.stringify(value)}\n`;
    const frameBytes = Buffer.byteLength(frame);
    if (frameBytes > this.maxFrameBytes) {
      return Promise.reject(new AtomicRpcProtocolError(
        "line_too_large",
        `Atomic RPC outbound frame exceeded ${this.maxFrameBytes} bytes`,
        frameBytes,
      ));
    }
    if (!this.reserveTransportBytes(child, "stdin", frameBytes)) {
      return Promise.reject(this.terminalError ?? new AtomicRpcProcessError("Atomic RPC transport budget exceeded"));
    }
    const write = () => {
      if (id !== undefined && !this.pending.has(id)) {
        throw new AtomicRpcError(`Atomic RPC request ${id} settled before its queued frame was written`);
      }
      return this.writeFrame(child, frame, id);
    };
    const queued = this.writeChain.then(write, write);
    this.writeChain = queued.catch(() => undefined);
    return queued;
  }

  private writeFrame(child: ChildProcessWithoutNullStreams, frame: string, id?: string): Promise<void> {
    if (this.child !== child || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(this.terminalError ?? new AtomicRpcProcessError("Atomic RPC stdin is not writable"));
    }
    return new Promise<void>((resolve, reject) => {
      let callbackComplete = false;
      let drainComplete = true;
      let settled = false;
      const cleanup = () => {
        child.stdin.off("error", onError);
        child.stdin.off("close", onClose);
        child.stdin.off("drain", onDrain);
      };
      const finish = () => {
        if (settled || !callbackComplete || !drainComplete) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (value: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(errorFrom(value, "Atomic RPC stdin write failed"));
      };
      const onError = (value: Error) => fail(value);
      const onClose = () => fail(this.terminalError ?? new AtomicRpcProcessError("Atomic RPC stdin closed during write"));
      const onDrain = () => {
        drainComplete = true;
        finish();
      };
      child.stdin.once("error", onError);
      child.stdin.once("close", onClose);
      try {
        const accepted = child.stdin.write(frame, "utf8", (value?: Error | null) => {
          if (value) {
            fail(value);
            return;
          }
          callbackComplete = true;
          finish();
        });
        if (!accepted) {
          drainComplete = false;
          child.stdin.once("drain", onDrain);
          this.emit("backpressure", { ...(id === undefined ? {} : { id }), bytes: Buffer.byteLength(frame) });
        }
      } catch (value) {
        fail(value);
      }
    });
  }

  private consumeStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child || !this.decoder) return;
    if (!this.reserveTransportBytes(child, "stdout", chunk.byteLength)) return;
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (value) {
      const error = value instanceof AtomicRpcProtocolError
        ? value
        : new AtomicRpcProtocolError("invalid_record", "Atomic RPC JSONL decoder failed", undefined, {
          cause: value,
        });
      this.failProtocol(child, {
        kind: error.kind,
        error,
        lineBytes: error.lineBytes,
      });
      return;
    }
    for (const line of lines) this.handleLine(child, line);
  }

  private reserveTransportBytes(
    child: ChildProcessWithoutNullStreams,
    stream: "stdin" | "stdout" | "stderr",
    bytes: number,
  ): boolean {
    if (this.child !== child) return false;
    if (this.terminalError) return false;
    if (bytes <= this.maxTransportBytes - this.transportBytes) {
      this.transportBytes += bytes;
      return true;
    }
    const error = new AtomicRpcProcessError(
      `Atomic RPC cumulative transport exceeded ${this.maxTransportBytes} bytes`,
    );
    this.terminalError ??= error;
    this.rejectAll(error);
    this.emit("transport_error", { stream, error });
    if (!child.killed) child.kill("SIGTERM");
    this.forceStopTimer ??= setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, this.stopTimeoutMs);
    this.forceStopTimer.unref?.();
    return false;
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      const error = new AtomicRpcProtocolError("invalid_json", "Atomic RPC emitted invalid JSON", Buffer.byteLength(line), {
        cause,
      });
      this.failProtocol(child, {
        kind: "invalid_json",
        error,
        line: previewLine(line),
        lineBytes: Buffer.byteLength(line),
      });
      return;
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      const error = new AtomicRpcProtocolError("invalid_record", "Atomic RPC record must be a JSON object");
      this.failProtocol(child, { kind: "invalid_record", error, line: previewLine(line) });
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string" || record.type.length === 0) {
      const error = new AtomicRpcProtocolError("invalid_record", "Atomic RPC record requires a string type");
      this.failProtocol(child, { kind: "invalid_record", error, line: previewLine(line) });
      return;
    }

    const typedRecord = record as AtomicRpcResponse | AtomicRpcNativeEvent;
    if (!this.earlyRecordsDrained && this.listenerCount("record") === 0) {
      const recordBytes = Buffer.byteLength(line);
      if (this.earlyRecords.length >= MAX_EARLY_RECORDS
          || this.earlyRecordBytes + recordBytes > MAX_EARLY_RECORD_BYTES) {
        const error = new AtomicRpcProtocolError(
          "line_too_large",
          "Atomic RPC startup record journal exceeded its bound before persistence attached",
          this.earlyRecordBytes + recordBytes,
        );
        this.failProtocol(child, { kind: "line_too_large", error, lineBytes: recordBytes });
        return;
      }
      this.earlyRecords.push(typedRecord);
      this.earlyRecordBytes += recordBytes;
    }
    this.emit("record", typedRecord);

    if (record.type === "response") {
      this.handleResponse(record, line);
      return;
    }
    this.emit("event", record as AtomicRpcNativeEvent);
  }

  private handleResponse(record: Record<string, unknown>, line: string): void {
    const id = record.id;
    if (typeof id !== "string" || typeof record.command !== "string" || typeof record.success !== "boolean") {
      const error = new AtomicRpcProtocolError("invalid_response", "Atomic RPC response is missing id, command, or success");
      if (typeof id === "string") this.rejectPending(id, error);
      this.emit("protocol_error", { kind: "invalid_response", error, line: previewLine(line) });
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      const error = new AtomicRpcProtocolError("unmatched_response", `Atomic RPC response ${id} has no pending request`);
      this.emit("protocol_error", { kind: "unmatched_response", error, line: previewLine(line) });
      return;
    }
    if (record.command !== pending.command) {
      const error = new AtomicRpcProtocolError(
        "response_command_mismatch",
        `Atomic RPC response ${id} named ${record.command}; expected ${pending.command}`,
      );
      this.rejectPending(id, error);
      this.emit("protocol_error", { kind: "response_command_mismatch", error, line: previewLine(line) });
      return;
    }

    const response = record as unknown as AtomicRpcResponse;
    if (!response.success) {
      this.rejectPending(id, new AtomicRpcCommandError(response));
      return;
    }
    this.resolvePending(id, response);
  }

  private handleSpawnError(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (this.child !== child) return;
    const cause = errorFrom(value, "Atomic RPC spawn failed");
    const error = new AtomicRpcProcessError(`Failed to spawn Atomic RPC command ${this.command}: ${cause.message}`, { cause });
    this.terminalError ??= error;
    this.rejectAll(error);
    this.emit("spawn_error", error);
  }

  private handleTransportError(
    child: ChildProcessWithoutNullStreams,
    stream: "stdin" | "stdout" | "stderr",
    value: unknown,
  ): void {
    if (this.child !== child) return;
    const cause = errorFrom(value, `Atomic RPC ${stream} failed`);
    const error = new AtomicRpcProcessError(`Atomic RPC ${stream} failed: ${cause.message}`, { cause });
    this.terminalError ??= error;
    this.rejectAll(error);
    this.emit("transport_error", { stream, error });
    if (!child.killed) child.kill("SIGTERM");
    this.forceStopTimer ??= setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, this.stopTimeoutMs);
    this.forceStopTimer.unref?.();
  }

  private failProtocol(child: ChildProcessWithoutNullStreams, issue: AtomicRpcProtocolIssue): void {
    if (this.child !== child) return;
    this.terminalError ??= issue.error;
    this.rejectAll(issue.error);
    this.emit("protocol_error", issue);
    if (!child.killed) child.kill("SIGTERM");
    this.forceStopTimer ??= setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, this.stopTimeoutMs);
    this.forceStopTimer.unref?.();
  }

  private finalizeProcess(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    let trailingRecord = "";
    try {
      trailingRecord = this.decoder?.finish() ?? "";
    } catch (value) {
      const error = value instanceof AtomicRpcProtocolError
        ? value
        : new AtomicRpcProtocolError("invalid_record", "Atomic RPC decoder failed at process close", undefined, {
          cause: value,
        });
      this.terminalError ??= error;
      this.rejectAll(error);
      this.emit("protocol_error", { kind: error.kind, error, lineBytes: error.lineBytes });
    }
    if (trailingRecord.length > 0) {
      const bytes = Buffer.byteLength(trailingRecord);
      const error = new AtomicRpcProtocolError(
        "trailing_record",
        `Atomic RPC exited with a non-LF-terminated record (${bytes} bytes)`,
        bytes,
      );
      this.terminalError ??= error;
      this.rejectAll(error);
      this.emit("protocol_error", {
        kind: "trailing_record",
        error,
        line: previewLine(trailingRecord),
        lineBytes: bytes,
      });
    }
    if (this.pending.size > 0) {
      this.rejectAll(
        this.terminalError
          ?? new AtomicRpcProcessError(`Atomic RPC exited code=${code} signal=${signal}`),
      );
    }

    const exit: AtomicRpcExitInfo = {
      code,
      signal,
      trailingRecord,
      expected: this.stopping,
    };
    this.clearStopTimers();
    this.child = null;
    this.decoder = null;
    this.stopping = false;
    const resolve = this.resolveClose;
    this.resolveClose = null;
    this.closePromise = null;
    resolve?.(exit);
    this.emit("exit", exit);
  }

  private resolvePending(id: string, value: AtomicRpcResponse): void {
    const pending = this.takePending(id);
    pending?.resolve(value);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.takePending(id);
    pending?.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }

  private takePending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private clearStopTimers(): void {
    if (this.gracefulStopTimer) clearTimeout(this.gracefulStopTimer);
    if (this.forceStopTimer) clearTimeout(this.forceStopTimer);
    this.gracefulStopTimer = undefined;
    this.forceStopTimer = undefined;
  }
}

/** Run `atomic --version` without a shell and with the same environment policy. */
export function probeAtomicVersion(
  command = process.env.ATOMIC_COMMAND ?? "atomic",
  options: AtomicVersionProbeOptions = {},
): Promise<AtomicVersionProbeResult> {
  const timeoutMs = positiveInteger(options.timeoutMs, 5_000, "timeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 64 * 1024, "maxOutputBytes");
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...(options.commandArgs ?? []), "--version"], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: selectRuntimeEnvironment(
        options.inheritConfiguredEnvAllowlist === false
          ? { ...process.env, ATOMIC_RUNTIME_ENV_ALLOWLIST: "" }
          : process.env,
        options.allowedEnvNames,
        options.env,
      ),
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let outputError: Error | undefined;
    const timer = setTimeout(() => {
      outputError = new AtomicRpcTimeoutError("version-probe", "--version", timeoutMs);
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const append = (channel: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputError = new AtomicRpcProcessError(`Atomic version output exceeded ${maxOutputBytes} bytes`);
        child.kill("SIGKILL");
        return;
      }
      if (channel === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cause = errorFrom(value, "Atomic version probe spawn failed");
      reject(new AtomicRpcProcessError(`Failed to spawn Atomic version probe ${command}: ${cause.message}`, { cause }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputError) {
        reject(outputError);
        return;
      }
      if (code !== 0) {
        reject(new AtomicRpcProcessError(
          `Atomic version probe exited code=${code} signal=${signal}: ${stderr.trim() || "no stderr"}`,
        ));
        return;
      }
      const version = stdout.trim().split(/\r?\n/, 1)[0] ?? "";
      if (!version) {
        reject(new AtomicRpcProcessError("Atomic version probe returned empty stdout"));
        return;
      }
      resolve({ version, stdout, stderr });
    });
  });
}
