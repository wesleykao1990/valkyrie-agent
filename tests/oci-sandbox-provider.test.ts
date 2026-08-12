import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
const ATOMIC_BINARY = "/opt/valkyrie/bin/atomic";
const ATOMIC_VERSION = "0.9.12";
const REVIEWED_IMAGE_LABELS = Object.freeze({
  "io.valkyrie.atomic.version": ATOMIC_VERSION,
  "io.valkyrie.git.version": "2.50.1",
  "io.valkyrie.git.source": "https://www.kernel.org/pub/software/scm/git/git-2.50.1.tar.xz",
  "io.valkyrie.git.source.sha256": "7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4",
});
const REVIEWED_ATOMIC_RPC = Object.freeze({
  reviewedBinaryPath: ATOMIC_BINARY,
  expectedVersion: ATOMIC_VERSION,
  reviewedImageLabels: REVIEWED_IMAGE_LABELS,
});

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
    State: { Running: boolean; Status: string };
  }>;
  behavior?: Record<string, boolean>;
}

function fixture(overrides: Partial<OciSandboxProviderOptions> = {}, rootParent = tmpdir()): Fixture {
  const root = mkdtempSync(join(rootParent, "valkyrie-oci-provider-"));
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

function atomicFixture(
  transportBounds: NonNullable<OciSandboxProviderOptions["atomicRpc"]>["transportBounds"] = {},
  timeoutOverrides: Partial<NonNullable<OciSandboxProviderOptions["timeoutBounds"]>> = {},
  stagedAgentConfig = false,
): Fixture {
  const item = fixture({
    timeoutBounds: {
      preflightMs: 5_000,
      startMs: 5_000,
      inspectMs: 5_000,
      readinessMs: 5_000,
      runMs: 5_000,
      stopMs: 5_000,
      killMs: 5_000,
      cleanupMs: 5_000,
      terminationGraceMs: 25,
      readinessPollMs: 25,
      ...timeoutOverrides,
    },
    atomicRpc: {
      reviewedBinaryPath: ATOMIC_BINARY,
      expectedVersion: ATOMIC_VERSION,
      reviewedImageLabels: REVIEWED_IMAGE_LABELS,
      stagedAgentConfig,
      transportBounds: {
        requestTimeoutMs: 1_000,
        stopTimeoutMs: 500,
        maxLineBytes: 4 * 1024,
        maxFrameBytes: 4 * 1024,
        maxTransportBytes: 64 * 1024,
        maxPendingRequests: 4,
        sessionMs: 5_000,
        ...transportBounds,
      },
    },
  });
  mkdirSync(join(item.workspace, "worktree"));
  mkdirSync(join(item.context, "atomic-package"));
  if (stagedAgentConfig) {
    mkdirSync(join(item.context, "atomic-agent"));
    writeFileSync(join(item.context, "atomic-agent", "models.json"), "{\"providers\":{}}\n", { mode: 0o600 });
    writeFileSync(join(item.context, "atomic-agent", "settings.json"), "{}\n", { mode: 0o600 });
  }
  return item;
}

async function startAtomic(item: Fixture, runId = "run_oci_atomic"): Promise<OciSandboxHandle> {
  return item.provider.start({
    runId,
    workspaceId: "ws_oci_atomic",
    leaseOwnerId: "worker_atomic_fixture",
    fencingToken: 11,
    workspacePath: item.workspace,
    contextPath: item.context,
    workingDirectoryRelativePath: "worktree",
  });
}

function reconciliationExpectation(item: Fixture, handle: OciSandboxHandle, engineId: string | null = handle.containerId) {
  const contract = item.provider.contract();
  return {
    runId: handle.runId,
    workspaceId: handle.workspaceId,
    leaseOwnerId: handle.leaseOwnerId,
    fencingToken: handle.fencingToken,
    engineId,
    imageRef: contract.imageRef,
    policyHash: contract.policyHash,
    workspaceDigest: handle.workspaceDigest,
    contextDigest: handle.contextDigest,
    workdirDigest: handle.workingDirectoryDigest,
    cleanupAttempts: 0,
  };
}

test("named writer network must be a local internal bridge before start", async () => {
  const item = fixture({ networkPolicy: { mode: "named", name: "valkyrie-run-test", internal: true } });
  try {
    assert.equal((await item.provider.preflight()).available, true);
    const handle = await start(item, "run_internal_network");
    assert.equal(readState(item).containers[handle.containerId].HostConfig.NetworkMode, "valkyrie-run-test");
    await item.provider.cleanup(handle);
    updateState(item, (state) => { state.behavior = { wrongInternalNetwork: true }; });
    assert.deepEqual(await item.provider.preflight(), {
      enabled: true, available: false, engine: "docker-compatible", reason: "engine-unavailable",
    });
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

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

test("Atomic runner preflight binds the exact digest, reviewed labels, and offline binary version", async () => {
  const item = atomicFixture();
  try {
    const preflight = await item.provider.preflightAtomicRunner();
    assert.deepEqual(preflight, {
      enabled: true,
      available: true,
      provider: {
        enabled: true,
        available: true,
        engine: "docker-compatible",
        version: "27.4.1",
      },
      imageRef: IMAGE,
      imageDigest: `sha256:${"1".repeat(64)}`,
      atomicVersion: ATOMIC_VERSION,
      provenanceLabels: REVIEWED_IMAGE_LABELS,
      provenanceDigest: digest(JSON.stringify(Object.fromEntries(
        Object.entries(REVIEWED_IMAGE_LABELS).sort(([left], [right]) => left.localeCompare(right)),
      ))),
    });
    const calls = readState(item).calls;
    assert.deepEqual(calls.map((call) => call.argv[0]), [
      "version", "ps", "image", "create", "start", "inspect", "exec", "ps", "inspect", "stop", "rm", "ps",
    ]);
    assert.deepEqual(calls[2].argv, [
      "image", "inspect", "--format",
      '{"repoDigests":{{json .RepoDigests}},"labels":{{json .Config.Labels}}}',
      IMAGE,
    ]);
    assert.deepEqual(calls[1].argv, [
      "ps", "--no-trunc", "--all",
      "--filter", "label=valkyrie.managed=true",
      "--filter", "label=valkyrie.kind=atomic-runner-preflight",
      "--format", "{{.ID}}",
    ]);
    const probeName = calls[3].argv[2];
    assert.match(probeName, /^valkyrie-atomic-preflight-[a-f0-9]{24}$/);
    const probeLabel = calls[3].argv.find((arg) => arg.startsWith("valkyrie.probe-id="));
    assert.match(probeLabel ?? "", /^valkyrie\.probe-id=[a-f0-9]{32}$/);
    const probeId = probeLabel!.slice("valkyrie.probe-id=".length);
    const ownerLabel = calls[3].argv.find((arg) => arg.startsWith("valkyrie.probe-owner-sha256="));
    const createdLabel = calls[3].argv.find((arg) => arg.startsWith("valkyrie.probe-created-at-ms="));
    const expiresLabel = calls[3].argv.find((arg) => arg.startsWith("valkyrie.probe-expires-at-ms="));
    assert.match(ownerLabel ?? "", /^valkyrie\.probe-owner-sha256=[a-f0-9]{64}$/);
    assert.match(createdLabel ?? "", /^valkyrie\.probe-created-at-ms=[0-9]{13}$/);
    assert.match(expiresLabel ?? "", /^valkyrie\.probe-expires-at-ms=[0-9]{13}$/);
    const containerId = digest(probeName);
    assert.deepEqual(calls[3].argv, [
      "create",
      "--name", probeName,
      "--hostname", "valkyrie-preflight",
      "--label", "valkyrie.managed=true",
      "--label", "valkyrie.kind=atomic-runner-preflight",
      "--label", `valkyrie.policy-sha256=${item.provider.contract().policyHash}`,
      "--label", `valkyrie.image-ref-sha256=${digest(IMAGE)}`,
      "--label", `valkyrie.probe-id=${probeId}`,
      "--label", ownerLabel!,
      "--label", createdLabel!,
      "--label", expiresLabel!,
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
      "--workdir", "/tmp",
      "--entrypoint", "sleep",
      IMAGE,
      "infinity",
    ]);
    assert.deepEqual(calls[4].argv, ["start", containerId]);
    assert.deepEqual(calls[5].argv, ["inspect", "--type", "container", containerId]);
    assert.deepEqual(calls[6].argv, [
      "exec",
      "--workdir", "/tmp",
      "--env", "HOME=/tmp/atomic-home",
      "--env", "ATOMIC_OFFLINE=1",
      containerId,
      ATOMIC_BINARY,
      "--version",
    ]);
    assert.deepEqual(calls[7].argv, [
      "ps", "--no-trunc", "--all",
      "--filter", "label=valkyrie.managed=true",
      "--filter", "label=valkyrie.kind=atomic-runner-preflight",
      "--filter", `label=valkyrie.probe-id=${probeId}`,
      "--format", "{{.ID}}",
    ]);
    assert.deepEqual(calls[8].argv, ["inspect", "--type", "container", containerId]);
    assert.deepEqual(calls[9].argv, ["stop", "--time", "5", containerId]);
    assert.deepEqual(calls[10].argv, ["rm", "--force", "--volumes", containerId]);
    assert.deepEqual(calls[11].argv, calls[7].argv);
    assert.deepEqual(readState(item).containers, {});
    for (const call of calls) {
      assert.deepEqual(call.envKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"), ["LANG", "LC_ALL"]);
    }
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

for (const [behavior, reason] of [
  ["missingImageDigest", "image-digest-missing"],
  ["wrongImageDigest", "image-digest-mismatch"],
  ["missingImageLabels", "image-provenance-missing"],
  ["wrongImageLabels", "image-provenance-mismatch"],
  ["missingAtomicVersion", "atomic-version-missing"],
  ["wrongAtomicVersion", "atomic-version-mismatch"],
] as const) {
  test(`Atomic runner preflight fails closed for ${behavior}`, async () => {
    const item = atomicFixture();
    try {
      writeFileSync(item.stateFile, `${JSON.stringify({
        calls: [],
        containers: {},
        behavior: { [behavior]: true },
      })}\n`, { encoding: "utf8", mode: 0o600 });
      const preflight = await item.provider.preflightAtomicRunner();
      assert.equal(preflight.enabled, true);
      assert.equal(preflight.available, false);
      assert.equal(preflight.provider.available, true);
      assert.equal(preflight.reason, reason);
      assert.equal(preflight.atomicVersion === ATOMIC_VERSION, false);
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  });
}

test("timed-out Atomic version probe is stopped, removed, and proven absent", async () => {
  const item = atomicFixture({}, { startMs: 1_000 });
  try {
    writeFileSync(item.stateFile, `${JSON.stringify({
      calls: [],
      containers: {},
      behavior: { hangAtomicVersion: true },
    })}\n`, { encoding: "utf8", mode: 0o600 });
    const preflight = await item.provider.preflightAtomicRunner();
    assert.equal(preflight.available, false);
    assert.equal(preflight.reason, "atomic-version-unavailable");
    assert.deepEqual(readState(item).containers, {});
    const transcript = item.provider.transcript();
    assert.equal(transcript.find((entry) => entry.operation === "runner-version")?.timedOut, true);
    assert.ok(transcript.some((entry) => entry.operation === "runner-probe-stop" && entry.exitCode === 0));
    assert.ok(transcript.some((entry) => entry.operation === "runner-probe-cleanup" && entry.exitCode === 0));
    assert.equal(transcript.at(-1)?.operation, "runner-probe-inventory");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("ambiguous probe create cleans only an exact inspected probe ID and never an unresolved name", async () => {
  for (const behavior of ["createNameCollision", "hangAfterProbeCreate"] as const) {
    const item = atomicFixture({}, { startMs: 1_000 });
    try {
      writeFileSync(item.stateFile, `${JSON.stringify({
        calls: [],
        containers: {},
        behavior: { [behavior]: true },
      })}\n`, { encoding: "utf8", mode: 0o600 });
      const preflight = await item.provider.preflightAtomicRunner();
      assert.equal(preflight.available, false);
      assert.equal(preflight.reason, "atomic-probe-unavailable");
      const state = readState(item);
      if (behavior === "createNameCollision") {
        assert.equal(Object.keys(state.containers).length, 1);
        assert.deepEqual(Object.values(state.containers)[0].Config.Labels, { "unrelated.owner": "true" });
        assert.equal(item.provider.transcript().some((entry) =>
          entry.operation === "runner-probe-stop"
          || entry.operation === "runner-probe-kill"
          || entry.operation === "runner-probe-cleanup"), false);
      } else {
        assert.deepEqual(state.containers, {});
        const cleanup = item.provider.transcript().find((entry) => entry.operation === "runner-probe-cleanup");
        assert.match(cleanup?.args.at(-1) ?? "", /^[a-f0-9]{64}$/);
        assert.equal(cleanup?.args.some((arg) => arg.startsWith("valkyrie-atomic-preflight-")), false);
      }
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("concurrent runner preflights coalesce to one bounded probe and reuse the short success cache", async () => {
  const item = atomicFixture();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => item.provider.preflightAtomicRunner()));
    assert.ok(results.every((result) => result.available && result === results[0]));
    const callsAfterCoalesced = readState(item).calls.length;
    assert.equal(readState(item).calls.filter((call) => call.argv[0] === "create").length, 1);
    assert.equal((await item.provider.preflightAtomicRunner()).available, true);
    assert.equal(readState(item).calls.length, callsAfterCoalesced, "short success cache must not launch another probe");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("engine invoke hard-settles after KILL even when a descendant retains stdio", async () => {
  const item = atomicFixture({}, { startMs: 1_000, terminationGraceMs: 50 });
  try {
    writeFileSync(item.stateFile, `${JSON.stringify({
      calls: [],
      containers: {},
      behavior: { retainAtomicVersionPipe: true },
    })}\n`, { encoding: "utf8", mode: 0o600 });
    const preflight = await item.provider.preflightAtomicRunner();
    assert.equal(preflight.available, false);
    assert.equal(preflight.reason, "atomic-version-unavailable");
    assert.deepEqual(readState(item).containers, {});
    const version = item.provider.transcript().find((entry) => entry.operation === "runner-version");
    assert.equal(version?.timedOut, true);
    assert.ok((version?.durationMs ?? Infinity) < 2_000, "retained stdio must not outlive the post-KILL settle bound");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("next runner preflight inventories and removes an exact stale managed probe", async () => {
  const item = atomicFixture({}, { startMs: 1_000 });
  try {
    writeFileSync(item.stateFile, `${JSON.stringify({
      calls: [],
      containers: {},
      behavior: { hangAtomicVersion: true, failRemove: true },
    })}\n`, { encoding: "utf8", mode: 0o600 });
    const failed = await item.provider.preflightAtomicRunner();
    assert.equal(failed.available, false);
    assert.equal(failed.reason, "atomic-probe-cleanup-failed");
    assert.equal(Object.keys(readState(item).containers).length, 1);
    const staleId = Object.keys(readState(item).containers)[0];
    const writerReconciler = new OciSandboxProvider(item.options);
    assert.deepEqual(await writerReconciler.reconcileOrphans([]), [],
      "writer restart inventory must partition runner probes from writer sandboxes");

    updateState(item, (state) => {
      state.behavior = {};
    });
    const restarted = new OciSandboxProvider(item.options);
    const whileForeignProbeIsFresh = await restarted.preflightAtomicRunner();
    assert.equal(whileForeignProbeIsFresh.available, true);
    assert.equal(whileForeignProbeIsFresh.atomicVersion, ATOMIC_VERSION);
    assert.deepEqual(Object.keys(readState(item).containers), [staleId]);
    assert.equal(
      restarted.transcript().some((entry) =>
        (entry.operation === "runner-probe-stop" || entry.operation === "runner-probe-cleanup")
        && entry.args.includes(staleId)),
      false,
      "a fresh foreign probe must never be removed as stale",
    );

    updateState(item, (state) => {
      const labels = state.containers[staleId].Config.Labels;
      const created = Number(labels["valkyrie.probe-created-at-ms"]);
      const expires = Number(labels["valkyrie.probe-expires-at-ms"]);
      const ttl = expires - created;
      const expiredAt = Date.now() - 1_000;
      labels["valkyrie.probe-created-at-ms"] = String(expiredAt - ttl);
      labels["valkyrie.probe-expires-at-ms"] = String(expiredAt);
    });
    const afterExpiry = new OciSandboxProvider(item.options);
    const recovered = await afterExpiry.preflightAtomicRunner();
    assert.equal(recovered.available, true);
    assert.deepEqual(readState(item).containers, {});
    assert.ok(afterExpiry.transcript().some((entry) =>
      entry.operation === "runner-probe-cleanup" && entry.args.includes(staleId)));
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
      "--label", "valkyrie.kind=writer-sandbox",
      "--label", "valkyrie.run-id=run_oci_001",
      "--label", "valkyrie.workspace-id=ws_oci_001",
      "--label", `valkyrie.lease-owner-sha256=${digest("worker_fixture")}`,
      "--label", "valkyrie.lease-fencing-token=7",
      "--label", `valkyrie.policy-sha256=${item.provider.contract().policyHash}`,
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

test("provider opens one fixed Atomic RPC stream and container stop remains mandatory", async () => {
  const priorSecret = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "MUST_NOT_ENTER_ATOMIC_RPC_OR_EVIDENCE";
  const item = atomicFixture();
  try {
    const handle = await startAtomic(item);
    const client = await item.provider.openAtomicRpc(handle);
    const stateResponse = await client.getState<{ sessionId: string; isStreaming: boolean }>();
    assert.deepEqual(stateResponse.data, {
      sessionId: "oci-run_oci_atomic",
      isStreaming: false,
    });
    const rpcCall = readState(item).calls.find((call) => call.argv[0] === "exec" && call.argv.includes("--mode"));
    assert.ok(rpcCall);
    assert.deepEqual(rpcCall.argv, [
      "exec", "-i",
      "--workdir", "/workspace/worktree",
      "--env", "HOME=/workspace/.atomic-home",
      "--env", "XDG_CONFIG_HOME=/workspace/.atomic-home/config",
      "--env", "XDG_DATA_HOME=/workspace/.atomic-home/data",
      "--env", "XDG_CACHE_HOME=/workspace/.atomic-home/cache",
      "--env", "TMPDIR=/tmp",
      "--env", "TMP=/tmp",
      "--env", "TEMP=/tmp",
      handle.containerId,
      ATOMIC_BINARY,
      "--mode", "rpc",
      "--session-dir", "/workspace/.atomic-sessions",
      "--name", handle.runId,
      "-e", "/run-context/atomic-package",
      "--approve",
    ]);
    assert.equal(rpcCall.envKeys.includes("ANTHROPIC_API_KEY"), false);
    assert.deepEqual(
      rpcCall.envKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
      ["LANG", "LC_ALL"],
    );
    assert.equal(JSON.stringify(item.provider.transcript()).includes("MUST_NOT_ENTER_ATOMIC_RPC_OR_EVIDENCE"), false);
    await assert.rejects(item.provider.openAtomicRpc(handle), /already open/);
    await assert.rejects(item.provider.execute(handle, ["tool"]), /open Atomic RPC stream/);

    await client.stop();
    assert.equal(readState(item).containers[handle.containerId].State.Running, true,
      "ending the host docker-exec transport is not container-side termination evidence");
    assert.throws(() => client.start({ cwd: item.root, extraArgs: ["--unsafe-restart"] }), /single-use/);
    await assert.rejects(client.probeVersion({ env: { ANTHROPIC_API_KEY: "must-not-spawn" } }), /disabled/);
    await assert.rejects(item.provider.openAtomicRpc(handle), /already open/,
      "a closed host transport cannot be replaced before the provider stops the container");
    assert.deepEqual(await item.provider.stop(handle), { status: "stopped" });
    assert.equal(readState(item).containers[handle.containerId].State.Running, false);
    assert.equal((await item.provider.cleanup(handle)).status, "cleaned");
  } finally {
    if (priorSecret === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorSecret;
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("model RPC reads only bounded staged agent config and never forwards a provider credential", async () => {
  const item = atomicFixture({}, {}, true);
  try {
    const handle = await startAtomic(item, "run_oci_atomic_model");
    const client = await item.provider.openAtomicRpc(handle);
    await client.getState();
    const rpcCall = readState(item).calls.find((call) => call.argv[0] === "exec" && call.argv.includes("--mode"));
    assert.ok(rpcCall);
    assert.ok(rpcCall.argv.includes("ATOMIC_CODING_AGENT_DIR=/run-context/atomic-agent"));
    assert.equal(rpcCall.envKeys.some((key) => /OPENAI|ANTHROPIC|API_KEY|TOKEN/.test(key)), false);
    await client.stop();
    assert.deepEqual(await item.provider.stop(handle), { status: "stopped" });
    assert.deepEqual(await item.provider.cleanup(handle), { status: "cleaned" });
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("Atomic RPC re-inspects ownership and validates its fixed staged extension before spawn", async () => {
  const missingExtension = fixture({
    atomicRpc: REVIEWED_ATOMIC_RPC,
  });
  mkdirSync(join(missingExtension.workspace, "worktree"));
  try {
    const handle = await startAtomic(missingExtension, "run_atomic_missing_extension");
    const outsideExtension = join(missingExtension.root, "outside-atomic-package");
    mkdirSync(outsideExtension);
    symlinkSync(outsideExtension, join(missingExtension.context, "atomic-package"), "dir");
    await assert.rejects(missingExtension.provider.openAtomicRpc(handle), /symbolic link|symlink/i);
    assert.equal(readState(missingExtension).calls.some((call) => call.argv[0] === "exec"), false);
    assert.equal((await missingExtension.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(missingExtension.root, { recursive: true, force: true });
  }

  const drift = atomicFixture();
  try {
    const handle = await startAtomic(drift, "run_atomic_policy_drift");
    updateState(drift, (state) => {
      state.containers[handle.containerId].NetworkSettings.Networks.bridge = {};
    });
    await assert.rejects(drift.provider.openAtomicRpc(handle), /ownership changed/);
    assert.equal(handle.status, "quarantined");
    assert.equal(readState(drift).calls.some((call) => call.argv[0] === "exec"), false);
  } finally {
    rmSync(drift.root, { recursive: true, force: true });
  }

  const invalid = fixture();
  try {
    assert.throws(() => new OciSandboxProvider({
      ...invalid.options,
      atomicRpc: { ...REVIEWED_ATOMIC_RPC, reviewedBinaryPath: "atomic" },
    }), /absolute POSIX container path/);
    assert.throws(() => new OciSandboxProvider({
      ...invalid.options,
      atomicRpc: { ...REVIEWED_ATOMIC_RPC, reviewedBinaryPath: "/bin/sh" },
    }), /reviewed Atomic executable/);
  } finally {
    rmSync(invalid.root, { recursive: true, force: true });
  }
});

test("Atomic RPC frame, cumulative transport, and session lifetime are bounded", async () => {
  const frameBound = atomicFixture({ maxFrameBytes: 1024 });
  try {
    const handle = await startAtomic(frameBound, "run_atomic_frame_bound");
    const client = await frameBound.provider.openAtomicRpc(handle);
    await assert.rejects(client.prompt("x".repeat(2_000)), /outbound frame exceeded/);
    assert.equal((await client.getState()).success, true, "one rejected frame does not weaken later correlation");
    assert.deepEqual(await frameBound.provider.stop(handle), { status: "stopped" });
    assert.equal((await frameBound.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(frameBound.root, { recursive: true, force: true });
  }

  const totalBound = atomicFixture({ maxLineBytes: 1024, maxFrameBytes: 1024, maxTransportBytes: 4096 });
  try {
    const handle = await startAtomic(totalBound, "run_atomic_total_bound");
    const client = await totalBound.provider.openAtomicRpc(handle);
    const issue = once(client, "transport_error");
    await assert.rejects(client.prompt("__fake:transport-overflow__"), /transport exceeded/);
    assert.equal((await issue)[0].stream, "stdout");
    assert.equal(handle.status, "running", "host transport failure does not claim container termination");
    assert.deepEqual(await totalBound.provider.stop(handle), { status: "stopped" });
    assert.equal((await totalBound.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(totalBound.root, { recursive: true, force: true });
  }

  const lifetimeBound = atomicFixture({ sessionMs: 75 });
  try {
    const handle = await startAtomic(lifetimeBound, "run_atomic_lifetime_bound");
    const client = await lifetimeBound.provider.openAtomicRpc(handle);
    await once(client, "exit");
    const deadline = Date.now() + 2_000;
    while (
      (readState(lifetimeBound).containers[handle.containerId].State.Running || handle.status === "running")
      && Date.now() < deadline
    ) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(handle.status, "stopped");
    assert.equal(readState(lifetimeBound).containers[handle.containerId].State.Running, false);
    assert.equal((await lifetimeBound.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(lifetimeBound.root, { recursive: true, force: true });
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

test("restart reconciliation removes only the exact durable engine instance", async () => {
  const item = fixture();
  try {
    const handle = await start(item, "run_oci_restart");
    const restarted = new OciSandboxProvider(item.options);
    const results = await restarted.reconcileOrphans([reconciliationExpectation(item, handle)]);
    assert.deepEqual(results, [{
      runId: handle.runId,
      workspaceId: handle.workspaceId,
      containerId: handle.containerId,
      outcome: "cleaned",
      reason: "restart_orphan_removed",
      cleanupAttempted: true,
    }]);
    assert.deepEqual(Object.keys(readState(item).containers), []);
    assert.equal(readdirSync(join(item.stateRoot, "completed")).length, 1);
    assert.equal(existsSync(join(item.stateRoot, "active", `${digest(handle.runId)}.json`)), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("restart inventory requests untruncated Docker IDs before enforcing durable ownership", async () => {
  const item = fixture({
    timeoutBounds: {
      preflightMs: 5_000,
      startMs: 5_000,
      inspectMs: 5_000,
      stopMs: 5_000,
      killMs: 5_000,
      cleanupMs: 5_000,
    },
  });
  try {
    const handle = await start(item, "run_oci_restart_untruncated");
    const restarted = new OciSandboxProvider(item.options);
    const [result] = await restarted.reconcileOrphans([reconciliationExpectation(item, handle)]);
    assert.equal(result.containerId, handle.containerId);
    assert.match(result.containerId ?? "", /^[a-f0-9]{64}$/);
    const inventory = restarted.transcript().find((entry) => entry.operation === "inventory");
    assert.deepEqual(inventory?.args, [
      "ps",
      "--no-trunc",
      "--all",
      "--filter",
      "label=valkyrie.managed=true",
      "--filter",
      "label=valkyrie.kind=writer-sandbox",
      "--format",
      "{{.ID}}",
    ]);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("restart reconciliation recovers engine-only and database-only lifecycle gaps", async () => {
  const engineOnly = fixture();
  const databaseOnly = fixture();
  try {
    const engineHandle = await start(engineOnly, "run_oci_engine_only");
    rmSync(join(engineOnly.stateRoot, "active"), { recursive: true, force: true });
    const engineRestart = new OciSandboxProvider(engineOnly.options);
    const [engineResult] = await engineRestart.reconcileOrphans([
      reconciliationExpectation(engineOnly, engineHandle, null),
    ]);
    assert.equal(engineResult.outcome, "cleaned");
    assert.equal(engineResult.containerId, engineHandle.containerId);

    const databaseHandle = await start(databaseOnly, "run_oci_database_only");
    assert.equal((await databaseOnly.provider.cleanup(databaseHandle)).status, "cleaned");
    const databaseRestart = new OciSandboxProvider(databaseOnly.options);
    const [databaseResult] = await databaseRestart.reconcileOrphans([
      reconciliationExpectation(databaseOnly, databaseHandle),
    ]);
    assert.equal(databaseResult.outcome, "absent");
    assert.equal(databaseResult.reason, "engine_id_absent");
    assert.equal(databaseResult.cleanupAttempted, false);
  } finally {
    rmSync(engineOnly.root, { recursive: true, force: true });
    rmSync(databaseOnly.root, { recursive: true, force: true });
  }
});

test("restart reconciliation quarantines policy drift and never touches an unmatched managed container", async () => {
  const drift = fixture();
  const unmatched = fixture();
  try {
    const driftHandle = await start(drift, "run_oci_restart_drift");
    updateState(drift, (state) => {
      state.containers[driftHandle.containerId].HostConfig.NetworkMode = "bridge";
    });
    const driftRestart = new OciSandboxProvider(drift.options);
    const [driftResult] = await driftRestart.reconcileOrphans([reconciliationExpectation(drift, driftHandle)]);
    assert.equal(driftResult.outcome, "quarantined");
    assert.equal(driftResult.reason, "ownership_or_policy_mismatch");
    assert.ok(readState(drift).containers[driftHandle.containerId]);

    const unmatchedHandle = await start(unmatched, "run_oci_unmatched");
    const unmatchedRestart = new OciSandboxProvider(unmatched.options);
    const [unmatchedResult] = await unmatchedRestart.reconcileOrphans([]);
    assert.deepEqual(unmatchedResult, {
      runId: null,
      workspaceId: null,
      containerId: unmatchedHandle.containerId,
      outcome: "unmatched",
      reason: "managed_engine_object_without_database_instance",
      cleanupAttempted: false,
    });
    assert.ok(readState(unmatched).containers[unmatchedHandle.containerId]);
    assert.equal((await unmatched.provider.cleanup(unmatchedHandle)).status, "cleaned");
  } finally {
    rmSync(drift.root, { recursive: true, force: true });
    rmSync(unmatched.root, { recursive: true, force: true });
  }
});

test("restart reconciliation fails closed on engine outage without changing durable provider state", async () => {
  const item = fixture({ engineCommand: "/definitely/not/a/valkyrie-engine" });
  try {
    await assert.rejects(item.provider.reconcileOrphans([]), /unavailable/);
    assert.equal(existsSync(item.stateRoot), false);
    assert.equal(item.provider.transcript().every((entry) => entry.operation === "preflight"), true);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("restart reconciliation stops retrying after the bounded cleanup-attempt limit", async () => {
  const item = fixture();
  try {
    const handle = await start(item, "run_oci_retry_exhausted");
    const expectation = { ...reconciliationExpectation(item, handle), cleanupAttempts: 3 };
    const restarted = new OciSandboxProvider(item.options);
    const [result] = await restarted.reconcileOrphans([expectation]);
    assert.deepEqual(result, {
      runId: handle.runId,
      workspaceId: handle.workspaceId,
      containerId: handle.containerId,
      outcome: "quarantined",
      reason: "cleanup_retry_exhausted",
      cleanupAttempted: false,
    });
    assert.ok(readState(item).containers[handle.containerId]);
    assert.equal(restarted.transcript().some((entry) => entry.operation === "stop" || entry.operation === "cleanup"), false);
    assert.equal((await item.provider.cleanup(handle)).status, "cleaned");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("live Docker-compatible sandbox is opt-in and skips honestly when unavailable", async (t) => {
  const engineCommand = process.env.VALKYRIE_OCI_LIVE_ENGINE;
  const image = process.env.VALKYRIE_OCI_LIVE_IMAGE;
  const engineSocket = process.env.VALKYRIE_OCI_LIVE_SOCKET;
  const configuredRoot = process.env.VALKYRIE_OCI_LIVE_ROOT;
  if (!engineCommand || !image || !configuredRoot) {
    t.skip("set VALKYRIE_OCI_LIVE_ENGINE, VALKYRIE_OCI_LIVE_ROOT, and a locally present digest-pinned VALKYRIE_OCI_LIVE_IMAGE");
    return;
  }
  if (!isAbsolute(configuredRoot)) throw new Error("VALKYRIE_OCI_LIVE_ROOT must be absolute");
  const rootStat = lstatSync(configuredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("VALKYRIE_OCI_LIVE_ROOT must be a non-symlink directory");
  }
  const liveRoot = realpathSync(configuredRoot);
  if (liveRoot !== resolve(configuredRoot)) {
    throw new Error("VALKYRIE_OCI_LIVE_ROOT must not traverse symbolic links");
  }
  if (process.platform !== "win32" && (rootStat.mode & 0o077) !== 0) {
    throw new Error("VALKYRIE_OCI_LIVE_ROOT must grant no group or other access");
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
  }, liveRoot);
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
      ].join("; "),
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
