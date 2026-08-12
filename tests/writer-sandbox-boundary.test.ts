import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";
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
import { OciSandboxProvider } from "../apps/control-plane/src/oci-sandbox-provider.ts";
import type { Project, Run } from "../apps/control-plane/src/types.ts";

const git = "/usr/bin/git";
const fakeOciEngine = resolve("scripts/fake-oci-engine.ts");
const fixtureImage = `fixture.invalid/valkyrie-runner@sha256:${"1".repeat(64)}`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function runRecord(id: string, workflow = "sandbox-fixture"): Run {
  return {
    id,
    projectId: "fixture",
    rootRuntime: workflow === "atomic-fixture-pilot" ? "atomic" : "codex",
    workflow,
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
    metadata: workflow === "sandbox-fixture" ? { sandboxFixture: true } : { atomicFixturePilot: true },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

async function fixture(runId: string, workflow = "sandbox-fixture") {
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
  const run = runRecord(runId, workflow);
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

  contract() {
    return {
      provider: "docker-compatible" as const,
      imageRef: `fixture.invalid/writer@sha256:${"a".repeat(64)}`,
      policyHash: "b".repeat(64),
    };
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

  async reconcileOrphans() {
    return [];
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
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.state, "cleaned");
    assert.equal(await item.store.getWorkspaceLease(result.workspaceId), null);
    assert.deepEqual(readdirSync(item.writerRoot).sort(), [".git-home"]);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("trusted workload prepares lease-bound context and leaves cleaned evidence ready for approval", async () => {
  const item = await fixture("run_atomic_workload_evidence", "atomic-fixture-pilot");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "unused\n");
  const originalContract = provider.contract.bind(provider);
  provider.contract = () => {
    events.push("contract");
    return originalContract();
  };
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
    const result = await boundary(item, provider, events).runWorkload({
      allowedWorkflow: "atomic-fixture-pilot",
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      artifacts: [{ relativePath: "evidence.txt", kind: "atomic-pilot-evidence", mediaType: "text/plain" }],
      completion: "evidence_ready",
      prepareContext: async (binding) => {
        events.push("prepare_context");
        assert.equal(binding.workflow, "atomic-fixture-pilot");
        assert.equal(binding.projectId, item.project.id);
        assert.equal(binding.sandboxContract.policyHash, "b".repeat(64));
        const persisted = await item.store.getRun(item.run.id);
        assert.equal(persisted?.workspaceId, binding.workspaceId);
        const lease = await item.store.getWorkspaceLease(binding.workspaceId);
        assert.equal(lease?.state, "active");
        assert.equal(lease?.ownerId, binding.leaseOwnerId);
        assert.equal(lease?.fencingToken, binding.fencingToken);
        assert.equal(await item.store.getSandboxInstance(item.run.id), null);
        writeFileSync(join(item.context, "launch-manifest.json"), JSON.stringify({
          runId: binding.runId,
          workspaceId: binding.workspaceId,
          fencingToken: binding.fencingToken,
          policyHash: binding.sandboxContract.policyHash,
        }), "utf8");
      },
      execute: async (handle, binding) => {
        events.push("trusted_execute");
        assert.equal(handle.runId, binding.runId);
        assert.equal(handle.workspaceId, binding.workspaceId);
        assert.equal(handle.fencingToken, binding.fencingToken);
        assert.match(readFileSync(join(item.context, "launch-manifest.json"), "utf8"), /policyHash/);
        writeFileSync(join(handle.workspacePath, "worktree", "evidence.txt"), "atomic evidence\n", "utf8");
        return { exitCode: 0, stdout: "atomic complete\n", stderr: "", stdoutBytes: 16, stderrBytes: 0 };
      },
      validateExports: (exports) => {
        events.push("validate_exports");
        assert.deepEqual(exports, [{
          relativePath: "evidence.txt",
          kind: "atomic-pilot-evidence",
          mediaType: "text/plain",
          checksum: digest("atomic evidence\n"),
          sizeBytes: 16,
        }]);
      },
    });
    assert.deepEqual(events, [
      "preflight", "contract", "prepare_context", "start", "trusted_execute", "stop",
      "freeze_cleanup", "validate_exports", "persist_artifacts", "cleanup", "workspace_cleanup", "release",
    ]);
    assert.equal(result.completion, "evidence_ready");
    assert.equal(result.execution.exitCode, 0);
    assert.equal(readFileSync(result.exports[0].path, "utf8"), "atomic evidence\n");
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "running");
    assert.equal(run?.stage, "evidence_ready");
    assert.equal(run?.completedAt, null);
    assert.equal(run?.metadata.sandboxEvidenceReady, true);
    assert.equal(run?.metadata.writerWorkloadCompleted, false);
    assert.equal(run?.metadata.writerLeaseReleased, true);
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.state, "cleaned");
    assert.equal(await item.store.getWorkspaceLease(result.workspaceId), null);
    assert.deepEqual(readdirSync(item.writerRoot).sort(), [".git-home"]);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("trusted workload rejects a caller workflow outside its exact allowlist before preflight", async () => {
  const item = await fixture("run_atomic_workload_allowlist", "atomic-fixture-pilot");
  const events: string[] = [];
  try {
    await assert.rejects(boundary(item, new FixtureProvider(events, ""), events).runWorkload({
      allowedWorkflow: "different-reviewed-workflow",
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      artifacts: [],
      completion: "evidence_ready",
      prepareContext: async () => undefined,
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 }),
    }), /outside the exact workload allowlist/);
    assert.deepEqual(events, []);
    assert.equal((await item.store.getRun(item.run.id))?.workspaceId, null);
    assert.equal((await item.store.listLeases()).length, 0);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("trusted workload quarantines context tamper before export", async () => {
  const item = await fixture("run_atomic_workload_context_tamper", "atomic-fixture-pilot");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "unused\n");
  try {
    await assert.rejects(boundary(item, provider, events).runWorkload({
      allowedWorkflow: "atomic-fixture-pilot",
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      artifacts: [{ relativePath: "evidence.txt", kind: "atomic-pilot-evidence", mediaType: "text/plain" }],
      completion: "evidence_ready",
      prepareContext: async () => undefined,
      execute: async (handle) => {
        events.push("trusted_execute");
        writeFileSync(join(handle.workspacePath, "worktree", "evidence.txt"), "must not export\n", "utf8");
        writeFileSync(join(item.context, "run-contract.json"), "{\"tampered\":true}\n", "utf8");
        return { exitCode: 0, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 };
      },
    }), (error: unknown) => error instanceof WriterSandboxQuarantinedError
      && error.reason === "context_integrity_changed");
    assert.deepEqual(events, ["preflight", "start", "trusted_execute", "stop", "cleanup"]);
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "failed");
    assert.equal(run?.stage, "workspace_quarantined");
    assert.equal(run?.metadata.sandboxQuarantineReason, "context_integrity_changed");
    assert.equal((await item.store.getWorkspaceLease(String(run?.workspaceId)))?.state, "quarantined");
    assert.equal((await item.store.listArtifacts(item.run.id)).length, 0);
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("trusted workload executor failure stops and cleans before workspace release", async () => {
  const item = await fixture("run_atomic_workload_executor_failure", "atomic-fixture-pilot");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "unused\n");
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
    await assert.rejects(boundary(item, provider, events).runWorkload({
      allowedWorkflow: "atomic-fixture-pilot",
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      artifacts: [{ relativePath: "evidence.txt", kind: "atomic-pilot-evidence", mediaType: "text/plain" }],
      completion: "evidence_ready",
      prepareContext: async () => undefined,
      execute: async () => {
        events.push("trusted_execute");
        throw new Error("injected trusted executor failure");
      },
    }), /injected trusted executor failure/);
    assert.deepEqual(events, [
      "preflight", "start", "trusted_execute", "stop", "cleanup",
      "freeze_cleanup", "workspace_cleanup", "release",
    ]);
    const run = await item.store.getRun(item.run.id);
    assert.equal(run?.status, "failed");
    assert.equal(run?.stage, "writer_workload_failed");
    assert.equal(run?.metadata.containerCleanupProven, true);
    assert.equal(run?.metadata.writerWorkspaceRemoved, true);
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.state, "quarantined");
    assert.equal(await item.store.getWorkspaceLease(String(run?.workspaceId)), null);
    assert.equal((await item.store.listArtifacts(item.run.id)).length, 0);
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
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.state, "quarantined");
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

test("writer context is checksummed and host-side drift quarantines before artifact export", async () => {
  const item = await fixture("run_boundary_context_drift");
  const events: string[] = [];
  const provider = new FixtureProvider(events, "unused evidence\n");
  provider.afterExecute = async () => {
    writeFileSync(join(item.context, "run-contract.json"), "{\"tampered\":true}\n", "utf8");
  };
  try {
    await assert.rejects(boundary(item, provider, events).runFixture({
      run: item.run,
      project: item.project,
      repositoryPath: item.source,
      contextPath: item.context,
      command: ["fixture-context-drift"],
      artifacts: [{ relativePath: "evidence.txt", kind: "sandbox-fixture", mediaType: "text/plain" }],
    }), (error: unknown) => error instanceof WriterSandboxQuarantinedError
      && error.reason === "context_integrity_changed");
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.state, "quarantined");
    assert.equal((await item.store.getWorkspaceLease(String((await item.store.getRun(item.run.id))?.workspaceId)))?.state, "quarantined");
    assert.equal((await item.store.listArtifacts(item.run.id)).length, 0);
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

test("restart reconciliation removes the exact orphan and durably quarantines its run and lease", async () => {
  const item = await fixture("run_boundary_restart_orphan");
  const stateRoot = join(item.root, "oci-state");
  const artifactRoot = join(item.root, "artifacts");
  const options = {
    enabled: true,
    engineCommand: process.execPath,
    enginePrefixArgs: ["--experimental-strip-types", fakeOciEngine, "--state", join(item.root, "fake-oci.json")],
    image: fixtureImage,
    user: "65532:65532",
    workspaceRoot: item.writerRoot,
    contextRoot: dirname(item.context),
    artifactRoot,
    stateRoot,
    timeoutBounds: {
      // This restart test launches several real Node subprocesses. Keep the
      // fake engine bounded while allowing cold startup on a loaded CI host.
      preflightMs: 5_000, startMs: 5_000, inspectMs: 5_000, readinessMs: 5_000,
      runMs: 5_000, stopMs: 5_000, killMs: 5_000, cleanupMs: 5_000,
      terminationGraceMs: 25, readinessPollMs: 25,
    },
  };
  try {
    const prepared = await item.workspaces.create({
      runId: item.run.id,
      project: item.project,
      repositoryPath: item.source,
      ownerId: "worker_fixture",
    });
    const lease = prepared.persistedLease;
    const provider = new OciSandboxProvider(options);
    const contract = provider.contract();
    const createdAt = item.now().toISOString();
    await item.store.createSandboxInstance({
      runId: item.run.id,
      workspaceId: prepared.workspaceId,
      leaseOwnerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      provider: contract.provider,
      imageRef: contract.imageRef,
      policyHash: contract.policyHash,
      workspaceDigest: digest(realpathSync(prepared.runRoot)),
      contextDigest: digest(realpathSync(item.context)),
      contextContentHash: digest(readFileSync(join(item.context, "run-contract.json"), "utf8")),
      workdirDigest: digest("worktree"),
      createdAt,
      updatedAt: createdAt,
    });
    const handle = await provider.start({
      runId: item.run.id,
      workspaceId: prepared.workspaceId,
      leaseOwnerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      workspacePath: prepared.runRoot,
      contextPath: item.context,
      workingDirectoryRelativePath: "worktree",
    });
    assert.ok(await item.store.transitionSandboxInstance({
      workspaceId: lease.workspaceId, runId: lease.runId, ownerId: lease.ownerId,
      fencingToken: lease.fencingToken, expectedState: "provisioning", state: "ready",
      engineId: handle.containerId, updatedAt: item.now().toISOString(),
    }));
    assert.ok(await item.store.transitionSandboxInstance({
      workspaceId: lease.workspaceId, runId: lease.runId, ownerId: lease.ownerId,
      fencingToken: lease.fencingToken, expectedState: "ready", state: "running",
      updatedAt: item.now().toISOString(),
    }));
    await item.store.updateRun(item.run.id, { status: "running", stage: "sandbox_fixture_running" });

    const restartedProvider = new OciSandboxProvider(options);
    const restartedBoundary = new WriterSandboxBoundary({
      store: item.store,
      workspaces: item.workspaces,
      provider: restartedProvider,
      artifactRoot,
      ownerId: "worker_fixture",
      now: item.now,
    });
    assert.deepEqual(await restartedBoundary.reconcileStartup(), {
      instancesExamined: 1,
      engineObjectsCleaned: 1,
      engineObjectsAbsent: 0,
      instancesQuarantined: 1,
      runsFailed: 1,
    });
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.state, "quarantined");
    assert.equal((await item.store.getSandboxInstance(item.run.id))?.cleanupAttempts, 1);
    assert.equal((await item.store.getWorkspaceLease(prepared.workspaceId))?.state, "quarantined");
    assert.equal((await item.store.getRun(item.run.id))?.stage, "workspace_quarantined");
    assert.equal((await item.store.getRun(item.run.id))?.metadata.sandboxEngineCleanupProven, true);
    assert.equal(existsSync(prepared.runRoot), true, "restart cleanup preserves the workspace for operator review");
  } finally {
    await item.store.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
