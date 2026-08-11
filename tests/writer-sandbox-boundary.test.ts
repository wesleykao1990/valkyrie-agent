import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import {
  WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON,
  WriterWorkspaceManager,
} from "../apps/control-plane/src/writer-workspace.ts";
import {
  WriterSandboxBoundary,
  WriterSandboxQuarantinedError,
  type WriterSandboxProvider,
} from "../apps/control-plane/src/writer-sandbox-boundary.ts";
import type {
  OciCleanupResult,
  OciRunResult,
  OciSandboxHandle,
  OciSandboxStartInput,
} from "../apps/control-plane/src/oci-sandbox-provider.ts";
import type { Project, Run } from "../apps/control-plane/src/types.ts";

const git = "/usr/bin/git";

function gitRun(repository: string, args: string[]): string {
  const result = spawnSync(git, ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Valkyrie Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Valkyrie Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return result.stdout.trim();
}

function runRecord(id: string): Run {
  return {
    id,
    projectId: "fixture",
    rootRuntime: "codex",
    workflow: "sandbox-fixture",
    status: "queued",
    stage: null,
    stageIndex: 0,
    budgetUsd: 1,
    costUsd: 0,
    workspaceId: null,
    nativeRunId: null,
    nextActionAt: null,
    startedAt: null,
    completedAt: null,
    metadata: { sandboxFixture: true },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

async function fixture(runId: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-writer-boundary-")));
  let nowMs = Date.parse("2026-08-11T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const setNow = (value: string) => { nowMs = Date.parse(value); };
  const source = join(root, "source");
  const context = join(root, "contexts", runId);
  mkdirSync(source);
  mkdirSync(context, { recursive: true });
  gitRun(source, ["init", "--initial-branch=main"]);
  writeFileSync(join(source, "fixture.txt"), "base\n", "utf8");
  gitRun(source, ["add", "fixture.txt"]);
  gitRun(source, ["commit", "-m", "fixture base"]);
  writeFileSync(join(context, "run-contract.json"), "{\"finalAction\":\"analysis_only\"}\n", "utf8");
  const store = new SqliteStore(join(root, "store.sqlite"), { now });
  const project: Project = {
    id: "fixture",
    name: "Fixture",
    objective: "Exercise the writer boundary",
    currentMilestone: "M4",
    health: "on_track",
    linearTeam: "FIX",
    repository: "fixture/repo",
    vaultPath: "Projects/Fixture",
    memoryNamespace: "projects/fixture",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  await store.seedProjects([{ ...project }]);
  const run = runRecord(runId);
  await store.createRun(run);
  const writerRoot = join(root, "writers");
  const workspaces = new WriterWorkspaceManager({
    store,
    root: writerRoot,
    gitCommand: git,
    now,
  });
  return { root, source, context, store, project, run, writerRoot, workspaces, now, setNow };
}

class FixtureProvider implements WriterSandboxProvider {
  readonly events: string[];
  readonly output: string;
  readonly available: boolean;
  afterExecute?: (handle: OciSandboxHandle) => Promise<void>;
  startInput?: OciSandboxStartInput;

  constructor(events: string[], output: string, available = true) {
    this.events = events;
    this.output = output;
    this.available = available;
  }

  async preflight() {
    this.events.push("preflight");
    return this.available
      ? { enabled: true, available: true, engine: "docker-compatible" as const, version: "fixture" }
      : { enabled: false, available: false, engine: "docker-compatible" as const, reason: "disabled" as const };
  }

  async start(input: OciSandboxStartInput): Promise<OciSandboxHandle> {
    this.events.push("start");
    this.startInput = input;
    return {
      runId: input.runId,
      workspaceId: input.workspaceId,
      leaseOwnerId: input.leaseOwnerId,
      fencingToken: input.fencingToken,
      containerId: "a".repeat(64),
      containerName: "valkyrie-fixture",
      workspacePath: input.workspacePath,
      contextPath: input.contextPath,
      workspaceDigest: "workspace-digest",
      contextDigest: "context-digest",
      workingDirectoryRelativePath: input.workingDirectoryRelativePath ?? ".",
      workingDirectoryDigest: "workdir-digest",
      status: "running",
    };
  }

  async execute(handle: OciSandboxHandle, _command: readonly string[]): Promise<OciRunResult> {
    this.events.push("execute");
    writeFileSync(join(handle.workspacePath, "worktree", "evidence.txt"), this.output, "utf8");
    if (this.afterExecute) await this.afterExecute(handle);
    return { exitCode: 0, stdout: "fixture complete\n", stderr: "", stdoutBytes: 17, stderrBytes: 0 };
  }

  async stop(handle: OciSandboxHandle): Promise<{ status: "stopped" }> {
    this.events.push("stop");
    handle.status = "stopped";
    return { status: "stopped" };
  }

  async cleanup(handle: OciSandboxHandle): Promise<OciCleanupResult> {
    this.events.push("cleanup");
    handle.status = "cleaned";
    return { status: "cleaned" };
  }
}

class SlowStartProvider extends FixtureProvider {
  readonly startEntered: Promise<void>;
  lateHandle?: OciSandboxHandle;
  private resolveStartEntered!: () => void;
  private resolveStartGate!: () => void;
  private readonly startGate: Promise<void>;

  constructor(events: string[], output: string) {
    super(events, output);
    this.startEntered = new Promise((resolve) => { this.resolveStartEntered = resolve; });
    this.startGate = new Promise((resolve) => { this.resolveStartGate = resolve; });
  }

  releaseStart(): void {
    this.resolveStartGate();
  }

  override async start(input: OciSandboxStartInput): Promise<OciSandboxHandle> {
    this.events.push("start");
    this.startInput = input;
    this.resolveStartEntered();
    await this.startGate;
    const handle: OciSandboxHandle = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      leaseOwnerId: input.leaseOwnerId,
      fencingToken: input.fencingToken,
      containerId: "b".repeat(64),
      containerName: "valkyrie-slow-start-fixture",
      workspacePath: input.workspacePath,
      contextPath: input.contextPath,
      workspaceDigest: "workspace-digest",
      contextDigest: "context-digest",
      workingDirectoryRelativePath: input.workingDirectoryRelativePath ?? ".",
      workingDirectoryDigest: "workdir-digest",
      status: "running",
    };
    this.lateHandle = handle;
    return handle;
  }
}

function boundary(
  item: Awaited<ReturnType<typeof fixture>>,
  provider: WriterSandboxProvider,
  events: string[],
  artifactRoot = join(item.root, "artifacts"),
  timing: { leaseTtlMs?: number; heartbeatIntervalMs?: number } = {},
) {
  return new WriterSandboxBoundary({
    store: item.store,
    workspaces: item.workspaces,
    provider,
    artifactRoot,
    ownerId: "worker_fixture",
    leaseTtlMs: timing.leaseTtlMs ?? 30_000,
    heartbeatIntervalMs: timing.heartbeatIntervalMs ?? 5_000,
    now: item.now,
  });
}

test("writer boundary orders stop, scan, atomic artifact persistence, container cleanup, workspace cleanup, and release", async () => {
  const item = await fixture("run_boundary_success");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "deterministic evidence\n");
  const originalBatch = item.store.createArtifactBatch.bind(item.store);
  item.store.createArtifactBatch = async (artifacts) => {
    events.push("persist_artifacts");
    return originalBatch(artifacts);
  };
  const originalQuarantine = item.store.quarantineWorkspaceLease.bind(item.store);
  item.store.quarantineWorkspaceLease = async (input) => {
    events.push("freeze_cleanup");
    return originalQuarantine(input);
  };
  const originalRemove = item.workspaces.removeFilesystem.bind(item.workspaces);
  item.workspaces.removeFilesystem = async (prepared, leaseFence) => {
    events.push("workspace_cleanup");
    return originalRemove(prepared, leaseFence);
  };
  const originalRelease = item.store.releaseWorkspaceLease.bind(item.store);
  item.store.releaseWorkspaceLease = async (leaseFence) => {
    events.push("release");
    return originalRelease(leaseFence);
  };
  try {
    const result = await boundary(item, provider, events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture-check"],
      artifacts: [{ relativePath: "evidence.txt", kind: "sandbox-fixture", mediaType: "text/plain" }],
    });
    assert.deepEqual(events, [
      "preflight", "start", "execute", "stop", "freeze_cleanup", "persist_artifacts",
      "cleanup", "workspace_cleanup", "release",
    ]);
    assert.equal(provider.startInput?.workingDirectoryRelativePath, "worktree");
    assert.equal(provider.startInput?.fencingToken, result.fencingToken);
    assert.equal(readFileSync(result.exports[0].path, "utf8"), "deterministic evidence\n");
    assert.match(result.artifacts[0].uri, /^artifact:\/\/runs\//);
    assert.equal(result.artifacts[0].uri.includes(item.root), false);
    assert.equal((await item.store.listArtifacts(item.run.id)).length, 1);
    assert.equal((await item.store.getRun(item.run.id))?.status, "completed");
    assert.equal(await item.store.getWorkspaceLease(result.workspaceId), null);
    assert.deepEqual(readdirSync(item.writerRoot).sort(), [".git-home"]);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("a pre-container storage failure freezes, removes, and releases the prepared writer workspace", async () => {
  const item = await fixture("run_boundary_prestart_failure");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "unused\n");
  const originalUpdateRun = item.store.updateRun.bind(item.store);
  let failFirstUpdate = true;
  item.store.updateRun = async (runId, patch) => {
    if (failFirstUpdate) {
      failFirstUpdate = false;
      throw new Error("injected pre-container storage failure");
    }
    return originalUpdateRun(runId, patch);
  };
  try {
    await assert.rejects(boundary(item, provider, events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture"],
      artifacts: [{ relativePath: "evidence.txt", kind: "fixture", mediaType: "text/plain" }],
    }), /pre-container storage failure/);
    assert.deepEqual(events, ["preflight"]);
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "failed");
    assert.equal(await item.store.getWorkspaceLease(String(run?.workspaceId)), null);
    assert.deepEqual(readdirSync(item.writerRoot).sort(), [".git-home"]);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("secret detection cleans the container but quarantines the lease and preserves the workspace for review", async () => {
  const item = await fixture("run_boundary_secret");
  const events: string[] = [];
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
  const provider = new FixtureProvider(events, `credential=${secret}\n`);
  try {
    await assert.rejects(boundary(item, provider, events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture-secret"],
      artifacts: [{ relativePath: "evidence.txt", kind: "sandbox-fixture", mediaType: "text/plain" }],
    }), (error: unknown) => error instanceof WriterSandboxQuarantinedError && !error.message.includes(secret));
    assert.deepEqual(events, ["preflight", "start", "execute", "stop", "stop", "cleanup"]);
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "failed");
    assert.equal(run?.stage, "workspace_quarantined");
    assert.equal((await item.store.listArtifacts(item.run.id)).length, 0);
    const lease = await item.store.getWorkspaceLease(String(run?.workspaceId));
    assert.equal(lease?.state, "quarantined");
    assert.equal(lease?.quarantineReason, WRITER_FILESYSTEM_CLEANUP_CLAIM_REASON);
    assert.equal((await item.store.getWorkspace(String(run?.workspaceId)))?.status, "quarantined");
    assert.equal(run?.metadata.sandboxQuarantineReason, "artifact_secret_detected");
    assert.equal(existsSync(join(item.root, "artifacts")), false);
    assert.equal(existsSync(join(item.writerRoot, String(readdirSync(item.writerRoot).find((name) => name !== ".git-home")))), true);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("uncertain artifact persistence preserves governed exports and the frozen workspace for reconciliation", async () => {
  const item = await fixture("run_boundary_artifact_persistence");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "governed evidence\n");
  item.store.createArtifactBatch = async () => {
    throw new Error("injected artifact transaction outcome uncertainty");
  };
  try {
    await assert.rejects(boundary(item, provider, events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture-artifact-persistence"],
      artifacts: [{ relativePath: "evidence.txt", kind: "sandbox-fixture", mediaType: "text/plain" }],
    }), (error: unknown) => error instanceof WriterSandboxQuarantinedError
      && error.reason === "artifact_persistence_uncertain");
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "failed");
    assert.equal(run?.stage, "workspace_quarantined");
    assert.equal(run?.metadata.sandboxQuarantineReason, "artifact_persistence_uncertain");
    assert.equal((await item.store.listArtifacts(item.run.id)).length, 0);
    const lease = await item.store.getWorkspaceLease(String(run?.workspaceId));
    assert.equal(lease?.state, "quarantined");
    assert.equal((await item.store.getWorkspace(String(run?.workspaceId)))?.status, "quarantined");
    assert.equal(existsSync(join(item.root, "artifacts", item.run.id, "evidence.txt")), true);
    assert.equal(readdirSync(item.writerRoot).some((name) => name !== ".git-home"), true);
    assert.ok(events.includes("cleanup"), "owned container cleanup is still attempted");
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("lease loss stops the old container before quarantine and cannot mutate its successor fence", async () => {
  const item = await fixture("run_boundary_stale");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "evidence\n");
  const originalQuarantine = item.store.quarantineWorkspaceLease.bind(item.store);
  item.store.quarantineWorkspaceLease = async (input) => {
    events.push("quarantine");
    return originalQuarantine(input);
  };
  provider.afterExecute = async (handle) => {
    const current = await item.store.getWorkspaceLease(handle.workspaceId);
    assert.ok(current);
    assert.equal(await item.store.releaseWorkspaceLease(current), true);
    await item.store.rotateWorkspaceLease({
      workspaceId: current.workspaceId,
      runId: current.runId,
      ownerId: "worker_successor",
      mode: "writer",
      heartbeatAt: "2026-08-11T00:00:11.000Z",
      expiresAt: "2026-08-11T00:01:11.000Z",
    });
  };
  try {
    await assert.rejects(boundary(item, provider, events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture-stale"],
      artifacts: [{ relativePath: "evidence.txt", kind: "sandbox-fixture", mediaType: "text/plain" }],
    }), /Writer lease lost/);
    assert.ok(events.indexOf("stop") >= 0);
    assert.ok(events.indexOf("quarantine") > events.indexOf("stop"));
    const successor = await item.store.getWorkspaceLease(String((await item.store.getRun(item.run.id))?.workspaceId));
    assert.equal((await item.store.getRun(item.run.id))?.stage, "sandbox_fixture_failed");
    assert.equal(successor?.ownerId, "worker_successor");
    assert.equal(successor?.state, "active");
    assert.ok(successor && successor.fencingToken > Number(provider.startInput?.fencingToken));
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("lease supervision rejects and cleans a late provider handle after rotation during slow startup", async () => {
  const item = await fixture("run_boundary_slow_start_rotation");
  const events: string[] = [];
  const provider = new SlowStartProvider(events, "must never execute\n");
  const originalQuarantine = item.store.quarantineWorkspaceLease.bind(item.store);
  let resolveQuarantineAttempt!: () => void;
  const quarantineAttempted = new Promise<void>((resolve) => { resolveQuarantineAttempt = resolve; });
  let quarantineSawNoHandle = false;
  item.store.quarantineWorkspaceLease = async (input) => {
    quarantineSawNoHandle ||= provider.lateHandle === undefined;
    const result = await originalQuarantine(input);
    resolveQuarantineAttempt();
    return result;
  };

  const operation = boundary(
    item,
    provider,
    events,
    join(item.root, "artifacts"),
    { leaseTtlMs: 5_000, heartbeatIntervalMs: 25 },
  ).runFixture({
    run: item.run,
    project: item.project,
    repositoryPath: item.source,
    contextPath: item.context,
    command: ["fixture-must-not-run"],
    artifacts: [{ relativePath: "evidence.txt", kind: "sandbox-fixture", mediaType: "text/plain" }],
  });

  try {
    await provider.startEntered;
    const claimedRun = await item.store.getRun(item.run.id);
    const original = await item.store.getWorkspaceLease(String(claimedRun?.workspaceId));
    assert.ok(original);

    item.setNow("2026-08-11T00:00:31.000Z");
    const successor = await item.store.rotateWorkspaceLease({
      workspaceId: original.workspaceId,
      runId: original.runId,
      ownerId: "worker_successor_during_start",
      mode: "writer",
      heartbeatAt: "2026-08-11T00:00:31.000Z",
      expiresAt: "2026-08-11T00:01:31.000Z",
    });

    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      quarantineAttempted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("lease supervisor did not detect startup rotation")), 1_000);
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    assert.equal(quarantineSawNoHandle, true, "loss is handled while provider.start remains in flight");

    provider.releaseStart();
    await assert.rejects(operation, /Writer lease lost: fence_rejected_or_lease_expired/);

    assert.deepEqual(events, ["preflight", "start", "stop", "cleanup"]);
    assert.equal(provider.lateHandle?.status, "cleaned");
    const current = await item.store.getWorkspaceLease(original.workspaceId);
    assert.equal(current?.ownerId, successor.ownerId);
    assert.equal(current?.fencingToken, successor.fencingToken);
    assert.equal(current?.state, "active");
    assert.ok(current && current.fencingToken > original.fencingToken);
    assert.equal((await item.store.getRun(item.run.id))?.stage, "sandbox_fixture_failed");
    assert.equal((await item.store.getRun(item.run.id))?.metadata.containerCleanupProven, true);
    assert.equal((await item.store.getRun(item.run.id))?.metadata.writerWorkspaceRemoved, false);
    assert.equal(readdirSync(item.writerRoot).some((name) => name !== ".git-home"), true);
  } finally {
    provider.releaseStart();
    await operation.catch(() => undefined);
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("disabled provider fails before creating a workspace or lease", async () => {
  const item = await fixture("run_boundary_disabled");
  const events: string[] = [];
  try {
    await assert.rejects(boundary(item, new FixtureProvider(events, "", false), events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture"],
      artifacts: [{ relativePath: "evidence.txt", kind: "fixture", mediaType: "text/plain" }],
    }), /provider is unavailable/);
    assert.deepEqual(events, ["preflight"]);
    assert.equal((await item.store.getRun(item.run.id))?.workspaceId, null);
    assert.equal((await item.store.listLeases()).length, 0);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("persisted run state is authoritative over a stale caller-supplied queued fixture", async () => {
  const item = await fixture("run_boundary_stale_input");
  const events: string[] = [];
  try {
    await item.store.updateRun(item.run.id, {
      status: "failed",
      stage: "already_terminal",
      completedAt: "2026-08-11T00:00:01.000Z",
    });
    await assert.rejects(boundary(item, new FixtureProvider(events, ""), events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture"],
      artifacts: [{ relativePath: "evidence.txt", kind: "fixture", mediaType: "text/plain" }],
    }), /persisted writer sandbox run does not match/i);
    assert.deepEqual(events, []);
    assert.equal((await item.store.getRun(item.run.id))?.workspaceId, null);
    assert.deepEqual(readdirSync(item.writerRoot).sort(), [".git-home"]);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("artifact storage must be disjoint from the disposable writer and context roots", async () => {
  const item = await fixture("run_boundary_artifact_overlap");
  const events: string[] = [];
  try {
    await assert.rejects(boundary(
      item,
      new FixtureProvider(events, ""),
      events,
      item.writerRoot,
    ).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture"],
      artifacts: [{ relativePath: "evidence.txt", kind: "fixture", mediaType: "text/plain" }],
    }), /artifact root must be disjoint/);
    assert.deepEqual(events, ["preflight"]);
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "failed");
    assert.equal(await item.store.getWorkspaceLease(String(run?.workspaceId)), null);
    assert.deepEqual(readdirSync(item.writerRoot).sort(), [".git-home"]);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
