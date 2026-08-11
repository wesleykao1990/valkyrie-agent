import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

const BASE_RUNTIME_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "TERM", "COLORTERM", "SSL_CERT_FILE", "SSL_CERT_DIR"
];

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

/**
 * Strict LF-only JSONL decoder.
 *
 * Atomic's RPC documentation explicitly permits U+2028/U+2029 inside JSON
 * strings and warns against Node's readline helper because it may treat those
 * code points as record separators. This decoder splits on LF only.
 */
export class JsonlLfDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const records: string[] = [];
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const record = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (record.length > 0) records.push(record);
    }
    return records;
  }

  pending(): string {
    return this.buffer;
  }
}

/**
 * Scaffold for Atomic's JSONL RPC mode. It is intentionally not selected by
 * default until a real Atomic workflow package and completion/approval mapping
 * are validated in the A/B pilot.
 */
export class AtomicRpcClient extends EventEmitter {
  private command: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(command = process.env.ATOMIC_COMMAND ?? "atomic") {
    super();
    this.command = command;
  }

  start(options: { provider?: string; model?: string; cwd: string; allowedEnvNames?: string[]; env?: Record<string, string> }): void {
    if (this.child) throw new Error("Atomic RPC process already started");
    const args = ["--mode", "rpc"];
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    this.child = spawn(this.command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: selectRuntimeEnvironment(process.env, options.allowedEnvNames, options.env),
    });

    const decoder = new JsonlLfDecoder();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) this.handleLine(line);
    });
    this.child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Atomic RPC exited code=${code} signal=${signal}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.child = null;
      this.emit("exit", { code, signal, trailingRecord: decoder.pending() });
    });
  }

  async prompt(message: string): Promise<unknown> {
    return this.commandRequest({ type: "prompt", message });
  }

  async steer(message: string): Promise<unknown> {
    return this.commandRequest({ type: "steer", message });
  }

  async getState(): Promise<unknown> {
    return this.commandRequest({ type: "get_state" });
  }

  async abort(): Promise<unknown> {
    return this.commandRequest({ type: "abort" });
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }

  private commandRequest(command: Record<string, unknown>): Promise<unknown> {
    if (!this.child) throw new Error("Atomic RPC process is not started");
    const id = `req-${++this.sequence}`;
    const payload = { id, ...command };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private handleLine(line: string): void {
    let value: any;
    try {
      value = JSON.parse(line);
    } catch {
      this.emit("protocol_error", { line });
      return;
    }
    if (value?.type === "response" && value?.id && this.pending.has(value.id)) {
      const request = this.pending.get(value.id)!;
      this.pending.delete(value.id);
      if (value.success === false) request.reject(new Error(value.error ?? "Atomic RPC command failed"));
      else request.resolve(value);
      return;
    }
    this.emit("event", value);
  }
}
