import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  OciSandboxProvider,
  type OciSandboxHandle,
  type OciSandboxProviderOptions,
} from "../apps/control-plane/src/oci-sandbox-provider.ts";
import { exportGovernedArtifacts } from "../apps/control-plane/src/governed-artifact-export.ts";

const IMAGE = `fixture.invalid/valkyrie-runner@sha256:${"1".repeat(64)}`;
const FAKE_ENGINE = resolve("scripts/fake-oci-engine.ts");

interface Fixture {
  root: string;
  workspaceRoot: string;
  contextRoot: string;
  workspace: string;
  context: string;
  artifactRoot: string;
  stateRoot: string;
  stateFile: string;
  options: OciSandboxProviderOptions;
  provider: OciSandboxProvider;
}

interface FakeState {
  calls: Array<{ argv: string[]; envKeys: string[] }>;
  containers: Record<string, {
    Config: { Labels: Record<string, string> };
    HostConfig: { NetworkMode: string };
    NetworkSettings: { Networks: Record<string, Record<string, unknown>> };
  }>;
  behavior?: Record<string, boolean>;
}

function fixture(overrides: Partial<OciSandboxProviderOptions> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "valkyrie-oci-provider-"));
  const workspaceRoot = join(root, "workspaces");
  const contextRoot = join(root, "contexts");
  const workspace = join(workspaceRoot, "run-1");
  const context = join(contextRoot, "run-1");
  const artifactRoot = join(root, "artifacts");
  const stateRoot = join(root, "state");
  const stateFile = join(root, "fake-engine.json");
  for (const path of [workspace, context]) mkdirSync(path, { recursive: true });
  const options: OciSandboxProviderOptions = {
    enabled: true,
    engineCommand: process.execPath,
    enginePrefixArgs: ["--experimental-strip-types", FAKE_ENGINE, "--state", stateFile],
    image: IMAGE,
    user: "65532:65532",
    workspaceRoot,
    contextRoot,
    artifactRoot,
    stateRoot,
    resourceBounds: {
      memoryBytes: 256 * 1024 * 1024,
      cpus: 0.5,
      pidsLimit: 64,
      tmpfsBytes: 8 * 1024 * 1024,
    },
    timeoutBounds: {
      preflightMs: 1_000,
      startMs: 1_000,
      inspectMs: 1_000,
      readinessMs: 1_000,
      runMs: 1_000,
      stopMs: 1_000,
      killMs: 1_000,
      cleanupMs: 1_000,
      terminationGraceMs: 25,
      readinessPollMs: 25,
    },
    maxEngineOutputBytes: 16 * 1024,
    maxRunOutputBytes: 1024,
    ...overrides,
  };
  return {
    root,
    workspaceRoot,
    contextRoot,
    workspace,
    context,
    artifactRoot,
    stateRoot,
    stateFile,
    options,
    provider: new OciSandboxProvider(options),
  };
}

function readState(item: Fixture): FakeState {
  return JSON.parse(readFileSync(item.stateFile, "utf8")) as FakeState;
}

function updateState(item: Fixture, mutate: (state: FakeState) => void): void {
  const state = readState(item);
  mutate(state);
  writeFileSync(item.stateFile, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function start(item: Fixture, runId = "run_oci_001"): Promise<OciSandboxHandle> {
  return item.provider.start({
    runId,
    workspaceId: "ws_oci_001",
    leaseOwnerId: "worker_fixture",
    fencingToken: 7,
    workspacePath: item.workspace,
    contextPath: item.context,
  });
}

test("OCI sandbox is disabled by default without spawning or creating state", async () => {
  const item = fixture({ enabled: undefined });
  try {
    const preflight = await item.provider.preflight();
    assert.deepEqual(preflight, {
      enabled: false,
      available: false,
      engine: "docker-compatible",
      reason: "disabled",
    });
    assert.equal(item.provider.transcript().length, 0);
    assert.equal(existsSync(item.stateFile), false);
    assert.equal(existsSync(item.stateRoot), false);
    await assert.rejects(start(item), /disabled/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("OCI provider uses exact argv, two governed mounts, no network, and no host credentials", async () => {
  const priorSecret = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "MUST_NOT_REACH_ENGINE_OR_CONTAINER";
  const item = fixture();
  try {
    const preflight = await item.provider.preflight();
    assert.equal(preflight.available, true);
    assert.equal(preflight.version, "27.4.1");
    const handle = await start(item);
    const state = readState(item);
    assert.equal(state.calls.length, 4);
    assert.deepEqual(state.calls[0].argv, ["version", "--format", "{{.Client.Version}}"]);

    const expectedCreate = [
      "create",
      "--name", handle.containerName,
      "--hostname", "valkyrie-sandbox",
      "--label", "valkyrie.managed=true",
      "--label", "valkyrie.run-id=run_oci_001",
      "--label", "valkyrie.workspace-id=ws_oci_001",
      "--label", `valkyrie.lease-owner-sha256=${digest("worker_fixture")}`,
      "--label", "valkyrie.lease-fencing-token=7",
      "--label", `valkyrie.workspace-sha256=${digest(handle.workspacePath)}`,
      "--label", `valkyrie.context-sha256=${digest(handle.contextPath)}`,
      "--label", `valkyrie.workdir-sha256=${digest(".")}`,
      "--pull", "never",
      "--network", "none",
      "--ipc", "none",
      "--restart", "no",
      "--memory", String(256 * 1024 * 1024),
      "--cpus", "0.5",
      "--pids-limit", "64",
      "--read-only",
      "--init",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--security-opt", "seccomp=builtin",
      "--user", "65532:65532",
      "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${8 * 1024 * 1024}`,
      "--mount", `type=bind,src=${handle.workspacePath},dst=/workspace`,
      "--mount", `type=bind,src=${handle.contextPath},dst=/run-context,readonly`,
      "--workdir", "/workspace",
      "--entrypoint", "sleep",
      IMAGE,
      "infinity",
    ];
    assert.deepEqual(state.calls[1].argv, expectedCreate);
    assert.deepEqual(state.calls[2].argv, ["start", handle.containerId]);
    assert.deepEqual(state.calls[3].argv, ["inspect", "--type", "container", handle.containerId]);
    for (const call of state.calls) {
      assert.deepEqual(call.envKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"), ["LANG", "LC_ALL"]);
      assert.equal(call.envKeys.some((key) => /TOKEN|KEY|SECRET|PASSWORD|HOME|CONFIG|CREDENTIAL/i.test(key)), false);
      assert.equal(call.argv.join(" ").includes("MUST_NOT_REACH_ENGINE_OR_CONTAINER"), false);
    }
    assert.match(handle.containerId, /^[a-f0-9]{64}$/);
    assert.equal(handle.status, "running");
    await assert.rejects(start(item), /already exists/);

    const createTranscript = item.provider.transcript().find((entry) => entry.operation === "create");
    assert.ok(createTranscript);
    assert.equal(JSON.stringify(createTranscript).includes(handle.workspacePath), false);
    assert.equal(JSON.stringify(createTranscript).includes(handle.contextPath), false);
    assert.equal((await item.provider.cleanup(handle)).status, "cleaned");
    await assert.rejects(start(item), /persistent OCI container state/);
  } finally {
    if (priorSecret === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorSecret;
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("an explicit local engine socket is allow-listed without retaining its value", async () => {
  const socket = "unix:///private/tmp/valkyrie-fixture.sock";
  const item = fixture({ engineSocket: socket });
  try {
    assert.equal((await item.provider.preflight()).available, true);
    const state = readState(item);
    assert.ok(state.calls[0].envKeys.includes("DOCKER_HOST"));
    assert.equal(JSON.stringify(item.provider.transcript()).includes(socket), false);
    assert.throws(() => new OciSandboxProvider({ ...item.options, engineSocket: "tcp://127.0.0.1:2375" }), /remote engines/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("container argv is exact while the evidence transcript redacts command arguments", async () => {
  const item = fixture();
  try {
    const handle = await start(item);
    const secretSentinel = "TRANSCRIPT_MUST_NOT_CONTAIN_THIS_VALUE";
    const result = await item.provider.execute(handle, ["tool", "--token", secretSentinel]);
    assert.equal(result.stdout, "ok\n");
    const state = readState(item);
    assert.deepEqual(state.calls.find((call) => call.argv[0] === "exec")?.argv, [
      "exec", handle.containerId, "tool", "--token", secretSentinel,
    ]);
    const operations = state.calls.map((call) => call.argv[0]);
    assert.deepEqual(operations.slice(-2), ["inspect", "exec"]);
    const transcript = JSON.stringify(item.provider.transcript());
    assert.equal(transcript.includes(secretSentinel), false);
    assert.match(transcript, /<argv:3:sha256:/);
    await item.provider.cleanup(handle);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("effective policy is re-inspected before execution and drift is quarantined", async () => {
  const item = fixture();
  try {
    const handle = await start(item);
    updateState(item, (state) => {
      state.containers[handle.containerId].NetworkSettings.Networks.bridge = {};
    });
    await assert.rejects(item.provider.execute(handle, ["tool"]), /ownership changed/);
    assert.equal(handle.status, "quarantined");
    assert.equal(readState(item).calls.some((call) => call.argv[0] === "exec"), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("concurrent execute and stop serialize behind terminal quarantine without recreating active state", async () => {
  const item = fixture();
  try {
    const handle = await start(item);
    updateState(item, (state) => {
      state.containers[handle.containerId].NetworkSettings.Networks.bridge = {};
    });
    const [execution, stopping] = await Promise.allSettled([
      item.provider.execute(handle, ["tool"]),
      item.provider.stop(handle),
    ]);
    assert.equal(execution.status, "rejected");
    if (stopping.status === "rejected") throw stopping.reason;
    assert.equal(stopping.value.status, "quarantined");
    assert.equal(handle.status, "quarantined");
    const recordName = `${digest(handle.runId)}.json`;
    assert.equal(existsSync(join(item.stateRoot, "active", recordName)), false);
    assert.equal(existsSync(join(item.stateRoot, "quarantine", recordName)), true);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("run timeout and output overflow terminate the engine exec and stop the container", async () => {
  const timeoutFixture = fixture({
    timeoutBounds: {
      preflightMs: 1_000,
      startMs: 1_000,
      inspectMs: 1_000,
      readinessMs: 1_000,
      runMs: 75,
      stopMs: 1_000,
      killMs: 1_000,
      cleanupMs: 1_000,
      terminationGraceMs: 25,
      readinessPollMs: 25,
    },
  });
  try {
    const handle = await start(timeoutFixture);
    await assert.rejects(timeoutFixture.provider.execute(handle, ["hang"]), /TIMEOUT/);
    assert.equal(handle.status, "stopped");
    const execute = timeoutFixture.provider.transcript().find((entry) => entry.operation === "execute");
    assert.equal(execute?.timedOut, true);
    assert.ok(timeoutFixture.provider.transcript().some((entry) => entry.operation === "stop"));
    await timeoutFixture.provider.cleanup(handle);
  } finally {
    rmSync(timeoutFixture.root, { recursive: true, force: true });
  }

  const outputFixture = fixture();
  try {
    const handle = await start(outputFixture, "run_oci_output");
    await assert.rejects(outputFixture.provider.execute(handle, ["emit-bytes", "4096"]), /OUTPUT_LIMIT/);
    assert.equal(handle.status, "stopped");
    const execute = outputFixture.provider.transcript().find((entry) => entry.operation === "execute");
    assert.equal(execute?.outputLimitExceeded, true);
    await outputFixture.provider.cleanup(handle);
  } finally {
    rmSync(outputFixture.root, { recursive: true, force: true });
  }
});

test("stop bypasses a hung execution queue so lease loss can terminate promptly", async () => {
  const item = fixture({
    timeoutBounds: {
      preflightMs: 1_000,
      startMs: 1_000,
      inspectMs: 1_000,
      readinessMs: 1_000,
      runMs: 1_500,
      stopMs: 500,
      killMs: 500,
      cleanupMs: 1_000,
      terminationGraceMs: 25,
      readinessPollMs: 25,
    },
  });
  try {
    const handle = await start(item);
    const execution = item.provider.execute(handle, ["hang"]);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
    const stopStarted = Date.now();
    assert.deepEqual(await item.provider.stop(handle), { status: "stopped" });
    assert.ok(Date.now() - stopStarted < 1_000, "stop must not wait for the 1.5s execution timeout");
    await assert.rejects(execution, /TIMEOUT/);
    assert.equal(handle.status, "stopped");
    assert.equal((await item.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("writable workspace and read-only context mounts must be disjoint", async () => {
  const item = fixture();
  const nestedContext = join(item.workspace, "context");
  mkdirSync(nestedContext);
  const provider = new OciSandboxProvider({
    ...item.options,
    workspaceRoot: item.root,
    contextRoot: item.root,
    stateRoot: join(item.root, "overlap-state"),
  });
  try {
    await assert.rejects(
      provider.start({
        runId: "run_overlap",
        workspaceId: "ws_overlap",
        leaseOwnerId: "worker_fixture",
        fencingToken: 10,
        workspacePath: item.workspace,
        contextPath: nestedContext,
      }),
      /must not overlap/,
    );
    assert.equal(provider.transcript().length, 0);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("nested working directory is ownership-bound and traversal is rejected before spawn", async () => {
  const item = fixture();
  mkdirSync(join(item.workspace, "worktree"));
  try {
    await assert.rejects(
      item.provider.start({
        runId: "run_workdir_escape",
        workspaceId: "ws_workdir_escape",
        leaseOwnerId: "worker_fixture",
        fencingToken: 8,
        workspacePath: item.workspace,
        contextPath: item.context,
        workingDirectoryRelativePath: "../escape",
      }),
      /unsafe|relative|escaped/,
    );
    assert.equal(item.provider.transcript().length, 0);

    const handle = await item.provider.start({
      runId: "run_workdir_nested",
      workspaceId: "ws_workdir_nested",
      leaseOwnerId: "worker_fixture",
      fencingToken: 9,
      workspacePath: item.workspace,
      contextPath: item.context,
      workingDirectoryRelativePath: "worktree",
    });
    assert.equal(handle.workingDirectoryRelativePath, "worktree");
    assert.equal(handle.workingDirectoryDigest, digest("worktree"));
    const create = readState(item).calls.find((call) => call.argv[0] === "create")?.argv;
    assert.ok(create);
    assert.equal(create[create.indexOf("--workdir") + 1], "/workspace/worktree");
    assert.ok(create.includes(`valkyrie.workdir-sha256=${digest("worktree")}`));
    assert.equal((await item.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("ownership mismatch quarantines the container without unsafe removal", async () => {
  const item = fixture();
  try {
    const handle = await start(item);
    const staleHandle = { ...handle, fencingToken: handle.fencingToken - 1 } as OciSandboxHandle;
    await assert.rejects(item.provider.cleanup(staleHandle), /not owned by this provider/);
    updateState(item, (state) => {
      state.containers[handle.containerId].Config.Labels["valkyrie.lease-fencing-token"] = String(handle.fencingToken - 1);
    });
    const result = await item.provider.cleanup(handle);
    assert.equal(result.status, "quarantined");
    if (result.status !== "quarantined") throw new Error("expected quarantine");
    assert.equal(result.reason, "OWNERSHIP_MISMATCH");
    assert.equal(existsSync(result.quarantineRecord), true);
    assert.equal(handle.status, "quarantined");
    const calls = readState(item).calls;
    assert.equal(calls.some((call) => call.argv[0] === "rm"), false);
    assert.equal(readFileSync(result.quarantineRecord, "utf8").includes(item.workspace), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("bounded stop falls back to kill and bounded remove failure quarantines", async () => {
  const item = fixture();
  try {
    const handle = await start(item);
    updateState(item, (state) => {
      state.behavior = { failStop: true };
    });
    assert.deepEqual(await item.provider.stop(handle), { status: "stopped" });
    assert.ok(item.provider.transcript().some((entry) => entry.operation === "kill"));
    updateState(item, (state) => {
      state.behavior = { failRemove: true };
    });
    const cleanup = await item.provider.cleanup(handle);
    assert.equal(cleanup.status, "quarantined");
    if (cleanup.status !== "quarantined") throw new Error("expected quarantine");
    assert.equal(cleanup.reason, "REMOVE_FAILED");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("live Docker-compatible sandbox is opt-in and skips honestly when unavailable", async (t) => {
  const engineCommand = process.env.VALKYRIE_OCI_LIVE_ENGINE;
  const image = process.env.VALKYRIE_OCI_LIVE_IMAGE;
  const engineSocket = process.env.VALKYRIE_OCI_LIVE_SOCKET;
  if (!engineCommand || !image) {
    t.skip("set VALKYRIE_OCI_LIVE_ENGINE and a locally present digest-pinned VALKYRIE_OCI_LIVE_IMAGE");
    return;
  }
  const hostUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : undefined;
  const liveUser = process.env.VALKYRIE_OCI_LIVE_USER
    ?? (Number(hostUid) > 0 && Number(hostGid) > 0 ? `${hostUid}:${hostGid}` : undefined);
  if (!liveUser) {
    t.skip("set VALKYRIE_OCI_LIVE_USER to a reviewed non-root numeric uid:gid that owns the bind-mounted fixture");
    return;
  }
  const item = fixture({
    engineCommand,
    enginePrefixArgs: [],
    ...(engineSocket ? { engineSocket } : {}),
    image,
    user: liveUser,
    timeoutBounds: {
      preflightMs: 3_000,
      startMs: 10_000,
      inspectMs: 3_000,
      readinessMs: 10_000,
      runMs: 10_000,
      stopMs: 3_000,
      killMs: 3_000,
      cleanupMs: 5_000,
      terminationGraceMs: 250,
      readinessPollMs: 100,
    },
  });
  let handle: OciSandboxHandle | undefined;
  let cleanupProven = false;
  let startAttempted = false;
  const priorCanary = process.env.VALKYRIE_HOST_SECRET_CANARY;
  process.env.VALKYRIE_HOST_SECRET_CANARY = "MUST_NOT_ENTER_WRITER_CONTAINER";
  try {
    const preflight = await item.provider.preflight();
    if (!preflight.available) {
      t.skip("configured Docker-compatible engine is not reachable without host credential forwarding");
      return;
    }
    mkdirSync(join(item.workspace, "worktree"));
    writeFileSync(join(item.context, "context-canary.txt"), "read-only context\n", "utf8");
    startAttempted = true;
    handle = await item.provider.start({
      runId: "run_oci_live",
      workspaceId: "ws_oci_live",
      leaseOwnerId: "worker_live_fixture",
      fencingToken: 1,
      workspacePath: item.workspace,
      contextPath: item.context,
      workingDirectoryRelativePath: "worktree",
    });
    const result = await item.provider.execute(handle, [
      "/bin/sh",
      "-ceu",
      [
        "test \"$(id -u)\" -ne 0",
        "test -r /run-context/context-canary.txt",
        "printf 'live sandbox evidence\\n' > /workspace/worktree/evidence.txt",
        "if touch /run-context/must-not-write 2>/dev/null; then exit 21; fi",
        "if touch /etc/valkyrie-must-not-write 2>/dev/null; then exit 22; fi",
        "if test -e /sys/class/net/eth0; then exit 23; fi",
        "if grep -Eq '^[^[:space:]]+[[:space:]]+00000000[[:space:]]' /proc/net/route; then exit 24; fi",
        "test -z \"${VALKYRIE_HOST_SECRET_CANARY+x}\"",
        "printf 'VALKYRIE_OCI_LIVE_OK\\n'",
      ].join("\n"),
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "VALKYRIE_OCI_LIVE_OK\n");
    assert.deepEqual(await item.provider.stop(handle), { status: "stopped" });
    const [artifact] = exportGovernedArtifacts([
      { relativePath: "evidence.txt", kind: "live-sandbox-evidence", mediaType: "text/plain" },
    ], {
      workspacePath: join(item.workspace, "worktree"),
      artifactRoot: item.artifactRoot,
      runId: "run_oci_live",
      maxFiles: 1,
      maxFileBytes: 4096,
      maxTotalBytes: 4096,
    });
    assert.equal(readFileSync(artifact.path, "utf8"), "live sandbox evidence\n");
    const cleanup = await item.provider.cleanup(handle);
    assert.deepEqual(cleanup, { status: "cleaned" });
    cleanupProven = true;
    const absent = spawnSync(engineCommand, ["inspect", "--type", "container", handle.containerId], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", ...(engineSocket ? { DOCKER_HOST: engineSocket } : {}) },
      timeout: 3_000,
      maxBuffer: 16 * 1024,
    });
    assert.equal(absent.error, undefined, "post-cleanup engine inspection must not fail or time out");
    assert.equal(absent.signal, null, "post-cleanup engine inspection must terminate normally");
    assert.notEqual(absent.status, null, "post-cleanup engine inspection must return an exit status");
    assert.notEqual(absent.status, 0, "cleaned live container must be absent from the engine");
  } finally {
    if (handle && handle.status !== "cleaned" && handle.status !== "quarantined") {
      const cleanup = await item.provider.cleanup(handle);
      cleanupProven = cleanup.status === "cleaned";
    }
    if (priorCanary === undefined) delete process.env.VALKYRIE_HOST_SECRET_CANARY;
    else process.env.VALKYRIE_HOST_SECRET_CANARY = priorCanary;
    const providerEvidence = ["active", "quarantine", "completed"].some((kind) => {
      const path = join(item.stateRoot, kind);
      return existsSync(path) && readdirSync(path).length > 0;
    });
    if (cleanupProven || (!handle && (!startAttempted || !providerEvidence))) {
      rmSync(item.root, { recursive: true, force: true });
    } else {
      throw new Error("Live OCI cleanup was not proven; retained the provider evidence and fixture root for operator inspection");
    }
  }
});
