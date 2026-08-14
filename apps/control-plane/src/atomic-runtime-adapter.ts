import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AtomicRpcClient,
  type AtomicRpcNativeEvent,
  type AtomicRpcResponse,
} from "./atomic-rpc-client.ts";
import { id, nowIso } from "./ids.ts";
import { RuntimeCancelledError, type RuntimeAdapter, type RuntimeContext } from "./runtime.ts";
import { canonicalJson, type ControlPlaneStore } from "./store.ts";
import type { Approval, Artifact, Run, RunEvent, RuntimeCapabilities, RuntimePreflight } from "./types.ts";
import type { WorkspaceManager } from "./workspace.ts";

export interface AtomicConnectivityRuntimeOptions {
  command: string;
  commandPrefixArgs?: string[];
  expectedVersion: string;
  packageDir: string;
  dataDir: string;
  artifactRoot: string;
  store: ControlPlaneStore;
  workspaces: WorkspaceManager;
  requestTimeoutMs?: number;
  maxNativeRecords?: number;
  maxNativeBytes?: number;
}

interface ActiveAtomic {
  client: AtomicRpcClient;
  context: RuntimeContext;
  version: string;
  nativeSessionId?: string;
  recordIndex: number;
  eventChain: Promise<void>;
  workflowListEvent?: AtomicRpcNativeEvent;
  eventFailure?: Error;
  cancelled: boolean;
  observedRecords: number;
  observedBytes: number;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contains(value: unknown, expected: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(expected.toLowerCase());
}

type JsonSchemaRule = Record<string, any>;

function resolveSchemaRef(schema: JsonSchemaRule, ref: string): JsonSchemaRule | undefined {
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").reduce<any>((value, token) =>
    value?.[token.replace(/~1/g, "/").replace(/~0/g, "~")], schema);
}

function validateSchemaValue(value: unknown, rule: JsonSchemaRule, schema: JsonSchemaRule, path = "$"): string[] {
  if (rule.$ref) {
    const resolved = resolveSchemaRef(schema, String(rule.$ref));
    return resolved ? validateSchemaValue(value, resolved, schema, path) : [`${path}: unresolved schema ref`];
  }
  const errors: string[] = [];
  if (Object.hasOwn(rule, "const") && !Object.is(value, rule.const)) errors.push(`${path}: constant mismatch`);
  if (Array.isArray(rule.enum) && !rule.enum.some((candidate: unknown) => Object.is(candidate, value))) errors.push(`${path}: value is not in enum`);
  if (rule.type) {
    const matches = rule.type === "array" ? Array.isArray(value)
      : rule.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
        : rule.type === "integer" ? Number.isInteger(value)
          : rule.type === "number" ? typeof value === "number" && Number.isFinite(value)
            : typeof value === rule.type;
    if (!matches) return [...errors, `${path}: expected ${rule.type}`];
  }
  if (typeof value === "string") {
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${path}: shorter than minLength`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${path}: longer than maxLength`);
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, "u").test(value)) errors.push(`${path}: pattern mismatch`);
  }
  if (typeof value === "number" && rule.minimum !== undefined && value < rule.minimum) errors.push(`${path}: below minimum`);
  if (typeof value === "number" && rule.maximum !== undefined && value > rule.maximum) errors.push(`${path}: above maximum`);
  if (Array.isArray(value) && rule.items) value.forEach((item, index) => errors.push(...validateSchemaValue(item, rule.items, schema, `${path}[${index}]`)));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of rule.required ?? []) if (!Object.hasOwn(record, name)) errors.push(`${path}: missing ${name}`);
    for (const [name, child] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(record, name)) errors.push(...validateSchemaValue(record[name], child as JsonSchemaRule, schema, `${path}.${name}`));
    }
    if (rule.additionalProperties === false) {
      for (const name of Object.keys(record)) if (!Object.hasOwn(rule.properties ?? {}, name)) errors.push(`${path}: unexpected ${name}`);
    }
  }
  return errors;
}

export function validateAtomicLaunchManifest(manifest: unknown, packageDir: string): string[] {
  const schemaPath = join(packageDir, "skills", "atomic-workflow-architect", "assets", "launch-manifest.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchemaRule;
  if (schema.$id !== "urn:wesley:atomic:launch-manifest:1.1.0") return ["$: unexpected launch-manifest schema ID"];
  return validateSchemaValue(manifest, schema, schema);
}

export function validateAtomicModelLaunchManifest(manifest: unknown, packageDir: string): string[] {
  const schemaPath = join(packageDir, "skills", "atomic-workflow-architect", "assets", "model-launch-manifest.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchemaRule;
  if (schema.$id !== "urn:wesley:atomic:model-launch-manifest:1.1.0") {
    return ["$: unexpected model launch-manifest schema ID"];
  }
  return validateSchemaValue(manifest, schema, schema);
}

export class AtomicConnectivityRuntimeAdapter implements RuntimeAdapter {
  readonly name = "atomic" as const;
  private readonly options: AtomicConnectivityRuntimeOptions;
  private readonly active = new Map<string, ActiveAtomic>();

  constructor(options: AtomicConnectivityRuntimeOptions) {
    this.options = options;
    mkdirSync(options.artifactRoot, { recursive: true });
  }

  capabilities(): RuntimeCapabilities {
    return { steer: false, pause: false, resume: false, approve: false, artifacts: true };
  }

  async preflight(): Promise<RuntimePreflight> {
    const packageJson = join(this.options.packageDir, "package.json");
    if (!existsSync(packageJson)) {
      return this.unavailable(`Atomic package is missing at ${this.options.packageDir}`);
    }
    try {
      const packageVersion = String(JSON.parse(readFileSync(packageJson, "utf8")).version ?? "unknown");
      const client = this.client();
      const probe = await client.probeVersion({
        cwd: this.options.packageDir,
        allowedEnvNames: [],
        env: { ATOMIC_OFFLINE: "1" },
        inheritConfiguredEnvAllowlist: false,
      });
      if (probe.version !== this.options.expectedVersion) {
        return this.unavailable(
          `Atomic ${probe.version} does not match pinned ${this.options.expectedVersion}`,
          probe.version,
          packageVersion,
        );
      }
      return {
        runtime: "atomic",
        adapter: "native",
        enabled: true,
        available: true,
        executionMode: "read-only",
        command: this.options.command,
        version: probe.version,
        authenticated: "unknown",
        capabilities: this.capabilities(),
        reason: `Credential-free offline RPC/package discovery only; Atomic package ${packageVersion}; model execution requires an external container/VM`,
      };
    } catch (error) {
      return this.unavailable(errorMessage(error));
    }
  }

  async start(context: RuntimeContext) {
    if (this.active.has(context.run.id)) throw new Error(`Atomic already has a process for run ${context.run.id}`);
    if (context.run.workflow !== "runtime-connectivity") {
      throw new Error("Atomic native adapter is limited to workflow=runtime-connectivity in this milestone");
    }
    await this.assertContract(context);
    const preflight = await this.preflight();
    if (!preflight.available || !preflight.version) throw new Error(preflight.reason ?? "Atomic preflight failed");

    const runtimeRoot = join(this.options.dataDir, "atomic", context.run.id);
    const sessionDir = join(runtimeRoot, "sessions");
    const workflowArtifacts = join(runtimeRoot, "workflow-artifacts");
    const agentDir = join(runtimeRoot, "agent");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(workflowArtifacts, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    const active: ActiveAtomic = {
      client: this.client(),
      context,
      version: preflight.version,
      recordIndex: 0,
      eventChain: Promise.resolve(),
      cancelled: false,
      observedRecords: 0,
      observedBytes: 0,
    };
    this.active.set(context.run.id, active);
    active.client.on("record", (record) => {
      active.observedRecords += 1;
      active.observedBytes += Buffer.byteLength(canonicalJson(record));
      if (
        active.observedRecords > (this.options.maxNativeRecords ?? 512)
        || active.observedBytes > (this.options.maxNativeBytes ?? 8 * 1024 * 1024)
      ) {
        active.eventFailure ??= new Error("Atomic native output exceeded the connectivity-run record/byte bound");
        void active.client.stop();
        return;
      }
      active.eventChain = active.eventChain.then(() => this.persistRaw(active, record));
      active.eventChain = active.eventChain.catch((error) => {
        active.eventFailure ??= error instanceof Error ? error : new Error(String(error));
      });
    });
    active.client.on("event", (event) => {
      if (contains(event, "workflows:chat-surface") && contains(event, "request-preflight")) {
        active.workflowListEvent = event;
      }
    });
    active.client.on("protocol_error", (issue) => {
      active.eventChain = active.eventChain.then(() => this.normalized(
        context.run.id,
        "runtime.protocol_error",
        "Atomic RPC rejected a native protocol record",
        { kind: issue.kind },
      ));
      active.eventChain = active.eventChain.catch((error) => {
        active.eventFailure ??= error instanceof Error ? error : new Error(String(error));
      });
    });

    const stored = await this.options.store.getRun(context.run.id) ?? context.run;
    try {
      await this.writeLaunchManifest(context);
      const spawned = new Promise<void>((resolveSpawn, rejectSpawn) => {
        active.client.once("spawn", () => resolveSpawn());
        active.client.once("spawn_error", (error) => rejectSpawn(error));
      });
      active.client.start({
        cwd: context.workspacePath,
        sessionDir,
        name: context.run.id,
        extensions: [resolve(this.options.packageDir)],
        approve: false,
        allowedEnvNames: [],
        inheritConfiguredEnvAllowlist: false,
        env: {
          ATOMIC_OFFLINE: "1",
          ATOMIC_CODING_AGENT_DIR: agentDir,
          ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
          ATOMIC_WORKFLOW_ARTIFACT_DIR: workflowArtifacts,
        },
      });
      await spawned;

      const startedAt = nowIso();
      const withManifest = await this.options.store.getRun(context.run.id) ?? stored;
      await this.options.store.updateRun(context.run.id, {
        status: "running",
        stage: "atomic_connectivity_discovery",
        startedAt,
        nextActionAt: null,
        metadata: {
          ...withManifest.metadata,
          adapter: "native",
          executionMode: "connectivity-only",
          runtimeVersion: preflight.version,
          atomicPackageDir: this.options.packageDir,
          crossProcessResume: false,
          nativeHilApprovalMapped: false,
          modelExecutionAttempted: false,
        },
      });
      await this.normalized(context.run.id, "run.started", "Atomic offline RPC discovery started", {
        runtime: "atomic",
        executionMode: "connectivity-only",
        version: preflight.version,
      });

      const state = await active.client.getState<Record<string, unknown>>();
      if (active.cancelled) throw new RuntimeCancelledError("Atomic connectivity discovery was cancelled");
      await this.captureResponse(active, state);
      const sessionId = typeof state.data?.sessionId === "string" ? state.data.sessionId : undefined;
      if (!sessionId) throw new Error("Atomic get_state did not return a native sessionId");
      active.nativeSessionId = sessionId;
      await this.normalized(context.run.id, "runtime.session_started", "Atomic native main session discovered", {
        runtime: "atomic",
        nativeSessionId: sessionId,
      });

      const commands = await active.client.getCommands<Record<string, unknown>>();
      await this.captureResponse(active, commands);
      if (!contains(commands.data, "atomic-routing") || !contains(commands.data, "atomic-workflow-architect")) {
        throw new Error("Atomic package commands/skill were not discovered at the pinned extension path");
      }

      const workflowList = await active.client.prompt("/workflow list");
      await this.captureResponse(active, workflowList);
      for (let attempt = 0; attempt < 20 && !active.workflowListEvent; attempt += 1) await delay(10);
      await active.eventChain;
      if (active.eventFailure) throw new Error("Atomic native-event persistence failed", { cause: active.eventFailure });
      if (!active.workflowListEvent) throw new Error("Atomic /workflow list did not expose the package request-preflight workflow");

      const entries = await active.client.getEntries<Record<string, unknown>>();
      await this.captureResponse(active, entries);
      const stats = await active.client.getSessionStats<Record<string, unknown>>();
      await this.captureResponse(active, stats);
      const cursor = typeof entries.data?.leafId === "string" ? entries.data.leafId : undefined;
      const cost = typeof stats.data?.cost === "number" ? stats.data.cost : 0;
      await this.writeDiscoveryArtifact(active, { state: state.data, commands: commands.data, workflowList: active.workflowListEvent, entries: entries.data, stats: stats.data });

      const completedAt = nowIso();
      if (active.cancelled) throw new RuntimeCancelledError("Atomic connectivity discovery was cancelled");
      const current = await this.options.store.getRun(context.run.id) ?? stored;
      await this.options.store.updateRun(context.run.id, {
        status: "completed",
        stage: "completed",
        nativeRunId: sessionId,
        costUsd: cost,
        completedAt,
        metadata: {
          ...current.metadata,
          nativeSessionId: sessionId,
          nativeEntryCursor: cursor,
          atomicWorkflowDiscovery: "request-preflight",
          modelExecutionAttempted: false,
          crossProcessResume: false,
        },
      });
      if (context.run.workspaceId) await this.options.workspaces.release(context.run.workspaceId, context.run.id);
      await this.normalized(context.run.id, "run.completed", "Atomic offline RPC/package discovery completed", {
        runtime: "atomic",
        nativeSessionId: sessionId,
        nativeEntryCursor: cursor,
        modelExecutionAttempted: false,
      });
      return {
        runtime: "atomic" as const,
        nativeRunId: sessionId,
        nativeSessionId: sessionId,
        runtimeVersion: preflight.version,
        metadata: { nativeEntryCursor: cursor, executionMode: "connectivity-only", crossProcessResume: false },
      };
    } finally {
      try {
        await active.eventChain;
      } finally {
        try {
          await active.client.stop();
        } finally {
          this.active.delete(context.run.id);
        }
      }
    }
  }

  async advance(_run: Run): Promise<void> {}

  async steer(_run: Run, _message: string): Promise<void> {
    throw new Error("Atomic connectivity-only adapter has no active model session to steer");
  }

  async cancel(run: Run): Promise<void> {
    const active = this.active.get(run.id);
    if (active) {
      active.cancelled = true;
      await active.client.stop();
    }
    const completedAt = nowIso();
    await this.options.store.updateRun(run.id, { status: "cancelled", stage: "cancelled", completedAt, nextActionAt: null });
    if (run.workspaceId) await this.options.workspaces.release(run.workspaceId, run.id);
    await this.normalized(run.id, "run.cancelled", "Atomic connectivity process was stopped", { runtime: "atomic" });
  }

  async resolveApproval(_run: Run, _approval: Approval, _decision: string): Promise<void> {
    throw new Error("Atomic 0.9.12 workflow HIL answering is not mapped over the verified public RPC boundary");
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.values()].map((active) => this.cancel(active.context.run)));
  }

  private client(): AtomicRpcClient {
    return new AtomicRpcClient({
      command: this.options.command,
      commandArgs: this.options.commandPrefixArgs,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
      stopTimeoutMs: 2_000,
      maxLineBytes: 4 * 1024 * 1024,
      maxPendingRequests: 32,
    });
  }

  private unavailable(reason: string, version?: string, packageVersion?: string): RuntimePreflight {
    return {
      runtime: "atomic",
      adapter: "native",
      enabled: true,
      available: false,
      executionMode: "read-only",
      command: this.options.command,
      version,
      authenticated: "unknown",
      capabilities: this.capabilities(),
      reason: `${reason}${packageVersion ? `; package ${packageVersion}` : ""}`,
    };
  }

  private async assertContract(context: RuntimeContext): Promise<void> {
    if (!context.workspace || !context.writerLease || !context.contextPack || !context.runContract) {
      throw new Error("Atomic requires workspace, writer lease, context pack, and run contract references");
    }
    if (context.workspace.id !== context.writerLease.workspaceId || context.run.id !== context.writerLease.runId) {
      throw new Error("Atomic workspace/lease ownership mismatch");
    }
    const lease = (await this.options.store.listLeases()).find((item) =>
      item.workspaceId === context.workspace!.id && item.runId === context.run.id && item.mode === "writer",
    );
    if (!lease || lease.ownerId !== context.writerLease.ownerId
        || lease.fencingToken !== context.writerLease.fencingToken
        || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new Error("Atomic requires the current unexpired exact writer lease owner and fence");
    }
    const root = resolve(context.workspacePath);
    const realRoot = realpathSync(root);
    for (const artifact of [context.contextPack, context.runContract]) {
      const path = resolve(artifact.path);
      if (path === root || !path.startsWith(`${root}${sep}`)) {
        throw new Error("Atomic context artifacts must be contained by the owned workspace");
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Atomic context artifacts must be regular non-symlink files");
      if (statSync(path).size > 128_000) throw new Error("Atomic context artifact exceeds 128000 bytes");
      const realPath = realpathSync(path);
      if (!realPath.startsWith(`${realRoot}${sep}`)) throw new Error("Atomic context artifact realpath escaped the owned workspace");
      if (sha(readFileSync(realPath)) !== artifact.checksum) throw new Error("Atomic context artifact checksum mismatch");
    }
  }

  private async captureResponse(active: ActiveAtomic, _response: AtomicRpcResponse): Promise<void> {
    await active.eventChain;
    if (active.eventFailure) throw new Error("Atomic native-record persistence failed", { cause: active.eventFailure });
  }

  private async persistRaw(active: ActiveAtomic, rawNative: AtomicRpcNativeEvent): Promise<void> {
    const nativeId = String(
      rawNative.id
      ?? (rawNative.entry as Record<string, unknown> | undefined)?.id
      ?? `record-${active.recordIndex + 1}`,
    );
    active.recordIndex += 1;
    const fingerprint = sha(`${active.context.run.id}\0${active.recordIndex}\0${nativeId}\0${canonicalJson(rawNative)}`);
    await this.options.store.appendEvent({
      id: `event_native_${fingerprint.slice(0, 32)}`,
      runId: active.context.run.id,
      type: "runtime.native",
      message: "Atomic native JSONL record retained",
      payload: {
        runtime: "atomic",
        nativeId,
        nativeSessionId: active.nativeSessionId,
        recordIndex: active.recordIndex,
        rawNative,
      },
      createdAt: nowIso(),
    });
  }

  private async writeDiscoveryArtifact(active: ActiveAtomic, discovery: Record<string, unknown>): Promise<void> {
    const dir = join(this.options.artifactRoot, active.context.run.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "atomic-connectivity-discovery.json");
    const body = `${JSON.stringify({
      atomicVersion: active.version,
      packageDir: this.options.packageDir,
      nativeSessionId: active.nativeSessionId,
      modelExecutionAttempted: false,
      crossProcessResume: false,
      discovery,
    }, null, 2)}\n`;
    writeFileSync(path, body, "utf8");
    const artifact: Artifact = {
      id: id("artifact"), runId: active.context.run.id, kind: "atomic-connectivity",
      uri: path, checksum: sha(body), mediaType: "application/json", createdAt: nowIso(),
    };
    await this.options.store.createArtifact(artifact);
    await this.normalized(active.context.run.id, "artifact.created", "Atomic discovery evidence stored", {
      artifactId: artifact.id, checksum: artifact.checksum, uri: artifact.uri,
    });
  }

  private async writeLaunchManifest(context: RuntimeContext): Promise<void> {
    const workflowPath = join(this.options.packageDir, "workflows", "request-preflight.ts");
    const packageJson = JSON.parse(readFileSync(join(this.options.packageDir, "package.json"), "utf8")) as { version?: string };
    if (!existsSync(workflowPath)) throw new Error("Pinned Atomic package does not contain workflows/request-preflight.ts");
    const manifest = {
      schema_version: "1.1.0",
      run_id: context.run.id,
      project_id: context.run.projectId,
      task_id: context.run.taskId ?? `adhoc:${context.run.id}`,
      request: context.objective,
      request_class: "review-or-research",
      intent: "review-only",
      root_runtime: "atomic",
      context_pack_ref: context.contextPack!.uri,
      contract_ref: context.runContract!.uri,
      workflow: {
        name: "request-preflight",
        path: "workflows/request-preflight.ts",
        version: String(packageJson.version ?? "unknown"),
        content_hash: `sha256:${sha(readFileSync(workflowPath))}`,
        trust_state: "package-reviewed",
      },
      workspace_owner: "control-plane",
      workspace_id: context.workspace!.id,
      workspace_ref: context.workspace!.path,
      writer_lease: {
        lease_id: `lease:${context.workspace!.id}:${context.run.id}`,
        holder_run_id: context.run.id,
        workspace_id: context.workspace!.id,
        owner_id: context.writerLease!.ownerId,
        fencing_token: context.writerLease!.fencingToken,
        mode: "exclusive-writer",
        expires_at: context.writerLease!.expiresAt,
      },
      sandbox_policy_id: "policy:offline-connectivity-only",
      durability_required: false,
      crossProcessResume: false,
      final_action: "analysis_only",
      budget: { currency: "USD", max_cost_usd: context.run.budgetUsd },
      bounds: {
        max_duration_minutes: 2,
        max_turns: 1,
        max_repairs: 0,
        max_child_depth: 0,
        max_concurrency: 1,
      },
      model_policy: {
        planner: "none:offline-connectivity",
        worker: "none:offline-connectivity",
        reviewers: [],
        fallbacks: [],
      },
      approvals: [{
        action: "model_execution",
        exact_effect: "A later model-backed Atomic run requires an external container/VM and separate authorization.",
        required: true,
      }],
      idempotency_key: `runtime-connectivity:${context.run.id}`,
      correlation_id: context.run.id,
    };
    const validationErrors = validateAtomicLaunchManifest(manifest, this.options.packageDir);
    if (validationErrors.length > 0) {
      throw new Error(`Atomic launch manifest failed the imported JSON Schema: ${validationErrors.join("; ")}`);
    }
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    const dir = join(context.workspacePath, ".control-plane");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "atomic-launch-manifest.json");
    writeFileSync(path, body, { encoding: "utf8", flag: "wx" });
    const artifact: Artifact = {
      id: id("artifact"), runId: context.run.id, kind: "atomic-launch-manifest",
      uri: path, checksum: sha(body), mediaType: "application/json", createdAt: nowIso(),
    };
    await this.options.store.createArtifact(artifact);
    const current = await this.options.store.getRun(context.run.id) ?? context.run;
    await this.options.store.updateRun(context.run.id, {
      metadata: { ...current.metadata, launchManifestRef: path, launchManifestChecksum: artifact.checksum },
    });
    await this.normalized(context.run.id, "artifact.created", "Atomic launch manifest stored", {
      artifactId: artifact.id, checksum: artifact.checksum, uri: path,
    });
  }

  private async normalized(runId: string, type: string, message: string, payload: Record<string, unknown>): Promise<void> {
    const event: Omit<RunEvent, "seq"> = { id: id("event"), runId, type, message, payload, createdAt: nowIso() };
    await this.options.store.appendEvent(event);
  }
}
