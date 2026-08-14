import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AtomicRpcClient } from "../apps/control-plane/src/atomic-rpc-client.ts";
import {
  ATOMIC_FIXTURE_APPROVAL_ACTION,
  ATOMIC_FIXTURE_PROJECT_ID,
  ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS,
  ATOMIC_FIXTURE_RUNTIME_VERSION,
  ATOMIC_FIXTURE_TASK_ID,
  AtomicFixturePilotCoordinator,
} from "../apps/control-plane/src/atomic-fixture-pilot.ts";
import { LocalProjectBrain } from "../apps/control-plane/src/project-brain.ts";
import { ControlPlaneService } from "../apps/control-plane/src/service.ts";
import { SqliteStore } from "../apps/control-plane/src/sqlite-store.ts";
import { WorkspaceManager } from "../apps/control-plane/src/workspace.ts";
import { WriterSandboxBoundary, type WriterSandboxProvider } from "../apps/control-plane/src/writer-sandbox-boundary.ts";
import { WriterWorkspaceManager } from "../apps/control-plane/src/writer-workspace.ts";
import type {
  OciCleanupResult,
  OciReconciliationExpectation,
  OciReconciliationResult,
  OciRunResult,
  OciSandboxHandle,
  OciSandboxStartInput,
} from "../apps/control-plane/src/oci-sandbox-provider.ts";
import { createMockAdapters } from "../apps/control-plane/src/mock-runtimes.ts";
import type { Approval, StartRunInput } from "../apps/control-plane/src/types.ts";
import { setupAtomicFixtureRepository } from "../scripts/setup-atomic-fixture.ts";
import {
  ATOMIC_FIXTURE_BOUNDS,
  ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
  ATOMIC_FIXTURE_IMPLEMENTATION,
  ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
  ATOMIC_FIXTURE_PACKAGE_NAME,
  ATOMIC_FIXTURE_PACKAGE_VERSION,
  ATOMIC_FIXTURE_REQUEST,
  ATOMIC_FIXTURE_TEST_SHA256,
  ATOMIC_FIXTURE_WORKFLOW_VERSION,
} from "../packages/atomic-workflow-architect/lib/atomic-fixture-pilot-core.mjs";

const fakeAtomicRpc = resolve("scripts/fake-atomic-rpc.ts");
const packageDir = resolve("packages/atomic-workflow-architect");
const policyHash = "b".repeat(64);
const imageRef = `fixture.invalid/atomic-pilot@sha256:${"a".repeat(64)}`;
const nativeWorkflowRunId = "11111111-2222-4333-8444-555555555555";

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(repository: string, args: string[]): string {
  const result = spawnSync("/usr/bin/git", [
    "-C", repository,
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "user.name=Valkyrie Test",
    "-c", "user.email=fixture@example.invalid",
    ...args,
  ], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git command failed"));
  return result.stdout.trim();
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface ProviderOptions {
  tamperEvidence?: boolean;
  tamperChecks?: boolean;
  mutateAfterValidation?: boolean;
  tamperContextMarkerOnCleanup?: boolean;
  failWorkflowListPrompt?: boolean;
  readDelayMs?: number;
  runningPolls?: number;
  quarantineCleanup?: boolean;
}

class AtomicFixtureIntegrationProvider implements WriterSandboxProvider {
  readonly options: ProviderOptions;
  readonly clients = new Map<string, AtomicRpcClient>();
  preflightCount = 0;
  startCount = 0;
  openRpcCount = 0;
  runnerFailureReason: "image-digest-mismatch" | null = null;
  private postValidationMutationApplied = false;
  private resolveRpcOpened!: () => void;
  readonly rpcOpened = new Promise<void>((resolvePromise) => { this.resolveRpcOpened = resolvePromise; });

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  contract() {
    return { provider: "docker-compatible" as const, imageRef, policyHash };
  }

  async preflight() {
    this.preflightCount += 1;
    return { enabled: true, available: true, engine: "docker-compatible" as const, version: "fixture" };
  }

  async preflightAtomicRunner() {
    const provider = await this.preflight();
    if (this.runnerFailureReason) {
      return {
        enabled: true,
        available: false,
        provider,
        imageRef,
        reason: this.runnerFailureReason,
      } as const;
    }
    return {
      enabled: true,
      available: true,
      provider,
      imageRef,
      imageDigest: `sha256:${"a".repeat(64)}`,
      atomicVersion: ATOMIC_FIXTURE_RUNTIME_VERSION,
      provenanceLabels: ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS,
      provenanceDigest: sha(JSON.stringify(Object.fromEntries(
        Object.entries(ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS)
          .sort(([left], [right]) => left.localeCompare(right)),
      ))),
    };
  }

  async start(input: OciSandboxStartInput): Promise<OciSandboxHandle> {
    this.startCount += 1;
    const handle: OciSandboxHandle = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      leaseOwnerId: input.leaseOwnerId,
      fencingToken: input.fencingToken,
      containerId: sha(`container:${input.runId}`),
      containerName: `valkyrie-atomic-fixture-${this.startCount}`,
      workspacePath: input.workspacePath,
      contextPath: input.contextPath,
      workspaceDigest: sha(input.workspacePath),
      contextDigest: sha(input.contextPath),
      workingDirectoryRelativePath: input.workingDirectoryRelativePath ?? "worktree",
      workingDirectoryDigest: sha(input.workingDirectoryRelativePath ?? "worktree"),
      status: "running",
    };
    this.writeWorkflowArtifacts(handle);
    return handle;
  }

  async openAtomicRpc(handle: OciSandboxHandle): Promise<AtomicRpcClient> {
    this.openRpcCount += 1;
    const client = new AtomicRpcClient({
      command: process.execPath,
      commandArgs: ["--experimental-strip-types", fakeAtomicRpc],
      requestTimeoutMs: 10_000,
      stopTimeoutMs: 1_000,
      singleUse: true,
      allowVersionProbe: false,
    });
    client.start({
      cwd: join(handle.workspacePath, handle.workingDirectoryRelativePath),
      env: {
        FAKE_ATOMIC_WORKFLOW_OUTCOME: "completed",
        FAKE_ATOMIC_WORKFLOW_RUNNING_POLLS: String(this.options.runningPolls ?? 0),
        FAKE_ATOMIC_ZERO_USAGE: "1",
        ...(this.options.failWorkflowListPrompt ? { FAKE_ATOMIC_FAIL_WORKFLOW_LIST: "1" } : {}),
        ...(this.options.readDelayMs ? { FAKE_ATOMIC_READ_DELAY_MS: String(this.options.readDelayMs) } : {}),
      },
      inheritConfiguredEnvAllowlist: false,
    });
    this.clients.set(handle.runId, client);
    this.resolveRpcOpened();
    return client;
  }

  async execute(_handle: OciSandboxHandle, _command: readonly string[]): Promise<OciRunResult> {
    throw new Error("The Atomic pilot uses provider-owned RPC, not the generic execute boundary");
  }

  async stop(handle: OciSandboxHandle): Promise<{ status: "stopped" }> {
    await this.clients.get(handle.runId)?.stop();
    if (this.options.mutateAfterValidation && !this.postValidationMutationApplied) {
      this.postValidationMutationApplied = true;
      writeFileSync(
        join(handle.workspacePath, handle.workingDirectoryRelativePath, ".valkyrie-output", "checks.json"),
        json({ schema_version: "1.0.0", passed: false, mutation: "after-native-validation" }),
        "utf8",
      );
    }
    handle.status = "stopped";
    return { status: "stopped" };
  }

  async cleanup(handle: OciSandboxHandle): Promise<OciCleanupResult> {
    await this.clients.get(handle.runId)?.stop();
    this.clients.delete(handle.runId);
    if (this.options.quarantineCleanup) {
      handle.status = "quarantined";
      return { status: "quarantined", reason: "REMOVE_FAILED", quarantineRecord: join(handle.workspacePath, "cleanup-uncertain.json") };
    }
    if (this.options.tamperContextMarkerOnCleanup) {
      writeFileSync(
        join(handle.contextPath, ".valkyrie-context.json"),
        JSON.stringify({ schemaVersion: 1, runId: `${handle.runId}_tampered` }),
        "utf8",
      );
    }
    handle.status = "cleaned";
    return { status: "cleaned" };
  }

  async reconcileOrphans(expectations: readonly OciReconciliationExpectation[]): Promise<OciReconciliationResult[]> {
    return expectations.map((expectation) => ({
      runId: expectation.runId,
      workspaceId: expectation.workspaceId,
      containerId: expectation.engineId,
      outcome: "absent",
      reason: "fixture engine object is absent",
      cleanupAttempted: false,
    }));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }

  private writeWorkflowArtifacts(handle: OciSandboxHandle): void {
    const worktree = join(handle.workspacePath, handle.workingDirectoryRelativePath);
    const output = join(worktree, ".valkyrie-output");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(worktree, "src", "normalize-project-slug.js"), ATOMIC_FIXTURE_IMPLEMENTATION, "utf8");
    const patch = spawnSync("/usr/bin/git", ["-C", worktree, "diff", "--", "src/normalize-project-slug.js"], {
      encoding: "utf8",
    });
    if (patch.status !== 0 || !patch.stdout) throw new Error(String(patch.stderr || "fixture patch generation failed"));

    const runContract = readFileSync(join(handle.contextPath, "run-contract.json"));
    const contextPack = readFileSync(join(handle.contextPath, "context-pack.json"));
    const launchManifest = readFileSync(join(handle.contextPath, "atomic-launch-manifest.json"));
    const workflowBody = readFileSync(join(handle.contextPath, "atomic-package", "workflows", "atomic-fixture-pilot.ts"));
    const coreBody = readFileSync(join(handle.contextPath, "atomic-package", "lib", "atomic-fixture-pilot-core.mjs"));
    const packageJsonBody = readFileSync(join(handle.contextPath, "atomic-package", "package.json"));
    const patchBody = patch.stdout;
    const checksBody = json({
      schema_version: "1.0.0",
      passed: this.options.tamperChecks ? false : true,
      source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      changed_paths: ["src/normalize-project-slug.js"],
      commands: [
        { argv: ["/usr/local/bin/node", "--test"], exit_code: 0, passed: true },
        { argv: ["/usr/bin/git", "diff", "--check"], exit_code: 0, passed: true },
      ],
      change_gate: { exact_allowlist: ["src/normalize-project-slug.js"], passed: true },
    });
    const verifierBody = json({
      schema_version: "1.0.0",
      context_mode: "fresh-deterministic-process",
      passed: true,
      inputs: {
        contract_sha256: sha(runContract),
        checks_sha256: sha(checksBody),
        source_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
        tests_sha256: ATOMIC_FIXTURE_TEST_SHA256,
      },
      acceptance: {
        trim_and_lowercase: true,
        collapse_non_alphanumeric_runs: true,
        trim_hyphens: true,
        reject_empty_after_normalization: true,
        reject_non_string: true,
      },
      model_execution_attempted: false,
    });
    const memoryProposalBody = json({
      schema_version: "1.0.0",
      status: "proposed",
      namespace: "projects/atomic-pilot",
      proposition: "The disposable Atomic pilot candidate satisfied its fixed normalization contract and deterministic verifier.",
      evidence_ref: ".valkyrie-output/evidence.json",
      evidence_binding: {
        control_plane_run_id: handle.runId,
        contract_sha256: sha(runContract),
        source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      },
      automatic_capture: false,
      canonical_promotion: false,
      promotion_requires_separate_human_action: true,
    });
    const draftPrMockBody = json({
      schema_version: "1.0.0",
      mock: true,
      title: "Implement normalizeProjectSlug in disposable Atomic pilot fixture",
      body: "Deterministic integration evidence only. No GitHub request was made.",
      changed_paths: ["src/normalize-project-slug.js"],
      external_request_performed: false,
      requires_separate_control_plane_approval: true,
    });
    writeFileSync(join(output, "candidate.patch"), patchBody, "utf8");
    writeFileSync(join(output, "checks.json"), checksBody, "utf8");
    writeFileSync(join(output, "verifier.json"), verifierBody, "utf8");
    writeFileSync(join(output, "memory-proposal.json"), memoryProposalBody, "utf8");
    writeFileSync(join(output, "draft-pr-mock.json"), draftPrMockBody, "utf8");
    writeFileSync(join(output, "context-pack.json"), contextPack);
    writeFileSync(join(output, "run-contract.json"), runContract);
    writeFileSync(join(output, "atomic-launch-manifest.json"), launchManifest);
    const artifactBinding = (path: string, body: string | Buffer) => ({
      path,
      sha256: sha(body),
      size_bytes: Buffer.byteLength(body),
    });
    writeFileSync(join(output, "evidence.json"), json({
      schema_version: "1.0.0",
      workflow: {
        name: "atomic-fixture-pilot",
        version: ATOMIC_FIXTURE_WORKFLOW_VERSION,
        content_sha256: sha(workflowBody),
        native_run_id: nativeWorkflowRunId,
        root_runtime: "atomic",
        model_execution_attempted: false,
        network_required: "none",
      },
      atomic_package: {
        name: ATOMIC_FIXTURE_PACKAGE_NAME,
        version: ATOMIC_FIXTURE_PACKAGE_VERSION,
        workflow_sha256: sha(workflowBody),
        core_sha256: sha(coreBody),
        package_json_sha256: sha(packageJsonBody),
      },
      control_plane_run_id: this.options.tamperEvidence ? `${handle.runId}_tampered` : handle.runId,
      contract_sha256: sha(runContract),
      source_before_sha256: ATOMIC_FIXTURE_EXPECTED_BEFORE_SHA256,
      source_after_sha256: ATOMIC_FIXTURE_IMPLEMENTATION_SHA256,
      test_sha256: ATOMIC_FIXTURE_TEST_SHA256,
      changed_paths: ["src/normalize-project-slug.js"],
      checks_passed: true,
      verifier_passed: true,
      repair_count: 0,
      final_action: "stop_before_external_action",
      bounds: ATOMIC_FIXTURE_BOUNDS,
      artifacts: {
        patch: artifactBinding(".valkyrie-output/candidate.patch", patchBody),
        checks: artifactBinding(".valkyrie-output/checks.json", checksBody),
        verifier: artifactBinding(".valkyrie-output/verifier.json", verifierBody),
        memory_proposal: artifactBinding(".valkyrie-output/memory-proposal.json", memoryProposalBody),
        draft_pr_mock: artifactBinding(".valkyrie-output/draft-pr-mock.json", draftPrMockBody),
        context_pack: artifactBinding(".valkyrie-output/context-pack.json", contextPack),
        run_contract: artifactBinding(".valkyrie-output/run-contract.json", runContract),
        atomic_launch_manifest: artifactBinding(".valkyrie-output/atomic-launch-manifest.json", launchManifest),
      },
      context_copies: {
        context_pack: {
          path: ".valkyrie-output/context-pack.json",
          source_sha256: sha(contextPack),
          copied_sha256: sha(contextPack),
          checksum_equal: true,
        },
        run_contract: {
          path: ".valkyrie-output/run-contract.json",
          source_sha256: sha(runContract),
          copied_sha256: sha(runContract),
          checksum_equal: true,
        },
        atomic_launch_manifest: {
          path: ".valkyrie-output/atomic-launch-manifest.json",
          source_sha256: sha(launchManifest),
          copied_sha256: sha(launchManifest),
          checksum_equal: true,
        },
      },
      external_actions: {
        github_request_performed: false,
        memory_promoted: false,
        deployment_performed: false,
      },
    }), "utf8");
  }
}

interface IntegrationFixture {
  root: string;
  store: SqliteStore;
  provider: AtomicFixtureIntegrationProvider;
  boundary: WriterSandboxBoundary;
  brain: LocalProjectBrain;
  repositoryPath: string;
  repositoryCommit: string;
  contextRoot: string;
  coordinator: AtomicFixturePilotCoordinator;
  service: ControlPlaneService;
  now: () => Date;
  setNow: (value: number) => void;
  coordinators: AtomicFixturePilotCoordinator[];
  close: () => Promise<void>;
}

async function fixture(
  providerOptions: ProviderOptions = {},
  pilotOptions: { workflowTimeoutMs?: number } = {},
): Promise<IntegrationFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "valkyrie-atomic-pilot-integration-")));
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const setNow = (value: number) => { nowMs = value; };
  const repositoryPath = join(root, "fixture-repository");
  const repositoryCommit = setupAtomicFixtureRepository(repositoryPath).commit;
  const brainRoot = join(root, "brain");
  mkdirSync(join(brainRoot, "Projects", "Atomic Pilot", "Decisions"), { recursive: true });
  writeFileSync(join(brainRoot, "Projects", "Atomic Pilot", "Decisions", "ADR.md"), [
    "---",
    "id: atomic-pilot-contract",
    "type: decision",
    "authority: canonical",
    "status: accepted",
    "project: atomic-pilot",
    "---",
    "# Atomic pilot contract",
    "The fixture remains disposable and stops before every external final action.",
    "",
  ].join("\n"), "utf8");
  const store = new SqliteStore(join(root, "control-plane.sqlite"), { now });
  const brain = new LocalProjectBrain(brainRoot);
  const provider = new AtomicFixtureIntegrationProvider(providerOptions);
  const contextRoot = join(root, "run-contexts");
  const writerWorkspaces = new WriterWorkspaceManager({
    store,
    root: join(root, "writer-workspaces"),
    gitCommand: "/usr/bin/git",
    now,
  });
  const boundary = new WriterSandboxBoundary({
    store,
    workspaces: writerWorkspaces,
    provider,
    artifactRoot: join(root, "governed-artifacts"),
    ownerId: "atomic_fixture_integration",
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 5_000,
    now,
  });
  const coordinatorOptions = {
    store,
    brain,
    boundary,
    provider,
    packageDir,
    repositoryPath,
    repositoryCommit,
    contextRoot,
    maxCostUsd: 0.5,
    now,
    workflowTimeoutMs: pilotOptions.workflowTimeoutMs ?? 5_000,
    statusPollMs: 10,
    approvalTtlMs: 60_000,
  };
  const coordinator = new AtomicFixturePilotCoordinator(coordinatorOptions);
  const coordinators = [coordinator];
  await coordinator.bootstrap();
  const compatibilityWorkspaces = new WorkspaceManager(store, join(root, "compatibility-workspaces"), { now });
  const service = new ControlPlaneService(
    store,
    brain,
    compatibilityWorkspaces,
    createMockAdapters(store, compatibilityWorkspaces, join(root, "mock-artifacts"), 0),
    { now, atomicFixturePilot: coordinator },
  );
  return {
    root,
    store,
    provider,
    boundary,
    brain,
    repositoryPath,
    repositoryCommit,
    contextRoot,
    coordinator,
    service,
    now,
    setNow,
    coordinators,
    close: async () => {
      await Promise.allSettled(coordinators.map((item) => item.shutdown()));
      await provider.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function startInput(idempotencyKey: string): StartRunInput {
  return {
    projectId: ATOMIC_FIXTURE_PROJECT_ID,
    taskId: ATOMIC_FIXTURE_TASK_ID,
    objective: ATOMIC_FIXTURE_REQUEST,
    runtime: "atomic",
    workflow: "atomic-fixture-pilot",
    maxCostUsd: 0.25,
    idempotencyKey,
    approvalPolicy: { preparePr: "human" },
  };
}

async function runToApproval(item: IntegrationFixture, key: string): Promise<{ runId: string; approval: Approval }> {
  const started = await item.service.startRun(startInput(key));
  const runId = started.run.run.id;
  await item.coordinator.wait(runId);
  const run = await item.store.getRun(runId);
  assert.equal(run?.status, "awaiting_approval");
  const approval = (await item.store.listApprovals("pending")).find((candidate) => candidate.runId === runId);
  assert.ok(approval);
  return { runId, approval };
}

test("M5 reports unavailable and persists no run when exact runner evidence fails", async () => {
  const item = await fixture();
  try {
    item.provider.runnerFailureReason = "image-digest-mismatch";
    let seedAttempted = false;
    const originalSeedProjects = item.store.seedProjects.bind(item.store);
    item.store.seedProjects = async (...args) => {
      seedAttempted = true;
      return originalSeedProjects(...args);
    };
    await assert.rejects(item.coordinator.bootstrap(), /bootstrap requires a verified runner.*image-digest-mismatch/);
    assert.equal(seedAttempted, false, "bootstrap must verify the exact runner before storage seeding");
    const statuses = await item.service.runtimeStatus();
    const pilot = statuses.find((status) => status.workflow === "atomic-fixture-pilot");
    assert.equal(pilot?.available, false);
    assert.equal(pilot?.version, undefined);
    assert.equal(pilot?.capabilities.approve, false, "native Atomic HIL approval is not exposed");
    assert.equal(pilot?.controlPlaneFinalAcceptance, true, "the safe-mock gate is control-plane-owned");
    assert.match(pilot?.reason ?? "", /image-digest-mismatch/);
    await assert.rejects(
      item.service.startRun(startInput("atomic-pilot-runner-digest-failure")),
      /image-digest-mismatch/,
    );
    assert.equal((await item.store.listRuns()).length, 0);
    assert.equal(item.provider.startCount, 0);
  } finally {
    await item.close();
  }
});

test("M5 start gate, idempotent replay, native evidence, and safe approval receipt compose through the service", async () => {
  const item = await fixture();
  try {
    const input = { ...startInput("atomic-pilot-success"), maxCostUsd: undefined };
    await assert.rejects(
      item.service.startRun({ ...input, idempotencyKey: undefined, objective: `${ATOMIC_FIXTURE_REQUEST} changed` }),
      /literal contract/,
    );
    await assert.rejects(
      item.service.startRun({ ...input, idempotencyKey: undefined, runtime: "codex" }),
      /requires runtime=atomic/,
    );
    await assert.rejects(
      item.service.startRun({ ...input, idempotencyKey: undefined, maxCostUsd: 0.75 }),
      /configured cap/,
    );
    await assert.rejects(
      item.service.startRun({ ...input, idempotencyKey: undefined, approvalPolicy: { preparePr: "automatic" } }),
      /human final-action boundary/,
    );
    assert.equal((await item.store.listRuns()).length, 0);

    const first = await item.service.startRun(input);
    const replay = await item.service.startRun(input);
    const runId = first.run.run.id;
    assert.equal(replay.run.run.id, runId);
    await assert.rejects(
      item.service.startRun({ ...input, maxCostUsd: 0.4 }),
      /Idempotency key was already used/,
    );
    await item.coordinator.wait(runId);
    assert.equal(item.provider.startCount, 1);
    assert.equal(item.provider.openRpcCount, 1);

    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "awaiting_approval");
    assert.equal(run?.stage, "approval");
    assert.equal(run?.nativeRunId, nativeWorkflowRunId);
    assert.equal(run?.budgetUsd, 0.5);
    assert.equal(run?.costUsd, 0);
    assert.equal(run?.metadata.atomicVersion, ATOMIC_FIXTURE_RUNTIME_VERSION);
    assert.equal(run?.metadata.atomicRunnerImageRef, imageRef);
    assert.equal(run?.metadata.atomicRunnerImageDigest, `sha256:${"a".repeat(64)}`);
    assert.deepEqual(run?.metadata.atomicRunnerProvenanceLabels, ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS);
    assert.equal(
      run?.metadata.atomicRunnerProvenanceDigest,
      sha(JSON.stringify(Object.fromEntries(
        Object.entries(ATOMIC_FIXTURE_RUNNER_PROVENANCE_LABELS)
          .sort(([left], [right]) => left.localeCompare(right)),
      ))),
    );
    assert.equal(run?.metadata.atomicRunnerPreflightNetwork, "none");
    assert.equal(run?.metadata.atomicFixtureModelExecutionAttempted, false);
    assert.equal(run?.metadata.atomicFixtureChecksPassed, true);
    assert.equal(run?.metadata.atomicFixtureVerifierPassed, true);
    assert.equal(run?.metadata.atomicFixtureFrozenExportsValidated, true);
    assert.equal(run?.metadata.externalActionPerformed, false);
    assert.equal((await item.store.getSandboxInstance(runId))?.state, "cleaned");
    assert.equal((await item.store.listLeases()).length, 0);
    assert.equal(existsSync(join(item.contextRoot, runId)), false);

    const events = await item.store.listEvents(runId);
    const raw = events.filter((event) => event.type === "runtime.native");
    assert.ok(raw.length >= 8);
    assert.ok(raw.every((event) => event.payload.runtime === "atomic" && event.payload.rawNative));
    assert.ok(events.some((event) => event.type === "atomic.workflow.running"));
    assert.ok(events.some((event) => event.type === "atomic.workflow.completed"
      && event.payload.nativeWorkflowRunId === nativeWorkflowRunId));

    const artifacts = await item.store.listArtifacts(runId);
    assert.equal(artifacts.length, 9);
    assert.deepEqual(artifacts.map((artifact) => artifact.kind).sort(), [
      "atomic-launch-manifest",
      "atomic-pilot-evidence",
      "candidate-patch",
      "deterministic-checks",
      "draft-pr-mock",
      "fresh-deterministic-verifier",
      "memory-proposal-draft",
      "project-brain-context-pack",
      "run-contract",
    ]);
    assert.ok(artifacts.every((artifact) => /^artifact:\/\/runs\//.test(artifact.uri)));
    assert.ok(artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.checksum)));
    const validatedWorkspaceArtifacts = run?.metadata.atomicFixtureValidatedWorkspaceArtifacts as Array<Record<string, unknown>>;
    const validatedFrozenArtifacts = run?.metadata.atomicFixtureFrozenExportArtifacts as Array<Record<string, unknown>>;
    assert.equal(validatedWorkspaceArtifacts.length, 9);
    assert.deepEqual(validatedFrozenArtifacts, [...validatedWorkspaceArtifacts].sort((left, right) =>
      String(left.relativePath).localeCompare(String(right.relativePath))));
    assert.deepEqual(
      artifacts.map((artifact) => artifact.checksum).sort(),
      validatedFrozenArtifacts.map((artifact) => String(artifact.checksum)).sort(),
    );
    const proposals = await item.store.listMemoryProposals("proposed");
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].runId, runId);
    assert.equal(proposals[0].state, "proposed");

    const approval = (await item.store.listApprovals("pending"))[0];
    assert.ok(approval);
    assert.equal(approval.action, ATOMIC_FIXTURE_APPROVAL_ACTION);
    assert.equal(approval.projectId, ATOMIC_FIXTURE_PROJECT_ID);
    assert.equal(approval.workflow, "atomic-fixture-pilot");
    assert.match(approval.evidenceDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(approval.policyHash, policyHash);
    assert.equal(approval.evidence.length, 9);

    const patchArtifact = artifacts.find((artifact) => artifact.kind === "candidate-patch");
    assert.ok(patchArtifact);
    const review = await item.service.readAtomicFixtureArtifact(runId, patchArtifact.id);
    assert.equal(review.approvalId, approval.id);
    assert.equal(review.checksum, patchArtifact.checksum);
    assert.equal(review.evidenceDigest, approval.evidenceDigest);
    assert.equal(review.mediaType, "text/x-diff");
    assert.match(review.content, /normalizeProjectSlug/);
    await assert.rejects(
      item.service.readAtomicFixtureArtifact(runId, "artifact_not_in_gate"),
      /not part of the approval-bound/i,
    );

    await assert.rejects(
      item.coordinator.resolveApproval({ ...approval, evidenceDigest: "f".repeat(64) }, "approve", "tamper"),
      /binding/i,
    );
    assert.equal((await item.store.getApproval(approval.id))?.state, "pending");
    await Promise.all([
      item.service.resolveAtomicFixtureApproval(approval.id, "approve", "wesley"),
      item.service.resolveAtomicFixtureApproval(approval.id, "approve", "wesley"),
    ]);
    await assert.rejects(item.service.resolveAtomicFixtureApproval(approval.id, "deny", "wesley"), /different decision/i);
    const accepted = await item.store.getRun(runId);
    assert.equal(accepted?.status, "completed");
    assert.equal(accepted?.stage, "accepted_mock_final_action");
    assert.equal(accepted?.metadata.approvalDecision, "approve");
    assert.equal(accepted?.metadata.humanDecision, undefined);
    assert.equal(accepted?.metadata.safeMockAcceptanceReceipt, true);
    assert.equal(accepted?.metadata.externalActionPerformed, false);
    assert.equal(accepted?.metadata.memoryPromoted, false);
    assert.equal((await item.store.getApproval(approval.id))?.state, "approved");
    assert.equal((await item.store.getMemoryProposal(proposals[0].id))?.state, "proposed");
    await assert.rejects(
      item.service.readAtomicFixtureArtifact(runId, patchArtifact.id),
      /exactly one pending final gate/i,
    );
    const acceptanceEvents = (await item.store.listEvents(runId)).filter((event) => event.type === "atomic.fixture.accepted");
    assert.equal(acceptanceEvents.length, 1);
    assert.doesNotMatch(acceptanceEvents[0].message, /human/i);
    assert.match(acceptanceEvents[0].message, /Authorized approval client/);
    assert.equal(acceptanceEvents[0].payload.resolvedBy, "wesley");
    assert.equal(acceptanceEvents[0].payload.externalActionPerformed, false);
    const terminalResidual = join(item.contextRoot, runId);
    mkdirSync(terminalResidual, { mode: 0o700 });
    writeFileSync(
      join(terminalResidual, ".valkyrie-context.json"),
      JSON.stringify({ schemaVersion: 1, runId }),
      { encoding: "utf8", mode: 0o600 },
    );
    await item.coordinator.reconcileStartup();
    assert.equal(existsSync(terminalResidual), false);
  } finally {
    await item.close();
  }
});

test("each run remains pinned to the reviewed fixture commit after mutable HEAD changes", async () => {
  const item = await fixture();
  try {
    mkdirSync(join(item.repositoryPath, "test"), { recursive: true });
    writeFileSync(
      join(item.repositoryPath, "test", "unreviewed-extra.test.js"),
      "throw new Error('unreviewed HEAD content must never enter the pilot worktree');\n",
      "utf8",
    );
    git(item.repositoryPath, ["add", "--all"]);
    git(item.repositoryPath, ["commit", "-m", "Add unreviewed clean committed content"]);
    assert.notEqual(git(item.repositoryPath, ["rev-parse", "HEAD"]), item.repositoryCommit);

    const { runId } = await runToApproval(item, "atomic-pilot-reviewed-base-commit");
    const run = await item.store.getRun(runId);
    assert.equal(run?.metadata.workspaceBaseCommit, item.repositoryCommit);
    assert.equal(run?.metadata.atomicFixtureChecksPassed, true);
  } finally {
    await item.close();
  }
});

for (const decision of ["deny", "request_changes"] as const) {
  test(`M5 ${decision} decision fails closed without promoting memory`, async () => {
    const item = await fixture();
    try {
      const { runId, approval } = await runToApproval(item, `atomic-pilot-${decision}`);
      await item.service.resolveAtomicFixtureApproval(approval.id, decision, "wesley");
      const run = await item.store.getRun(runId);
      assert.equal(run?.status, "failed");
      assert.equal(run?.stage, decision === "deny" ? "approval_denied" : "changes_requested");
      assert.equal(run?.metadata.approvalDecision, decision);
      assert.equal(run?.metadata.humanDecision, undefined);
      assert.equal(run?.metadata.safeMockAcceptanceReceipt, false);
      assert.equal(run?.metadata.externalActionPerformed, false);
      assert.equal(run?.metadata.memoryPromoted, false);
      assert.equal(
        (await item.store.getApproval(approval.id))?.state,
        decision === "deny" ? "denied" : "changes_requested",
      );
      assert.ok((await item.store.listMemoryProposals("proposed")).every((proposal) => proposal.runId === runId));
      const rejected = (await item.store.listEvents(runId)).find((event) => event.type === "atomic.fixture.rejected");
      assert.ok(rejected);
      assert.doesNotMatch(rejected.message, /human/i);
    } finally {
      await item.close();
    }
  });
}

test("tampered native workflow evidence is rejected before governed export or approval", async () => {
  const item = await fixture({ tamperEvidence: true });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-tampered-evidence"));
    const runId = started.run.run.id;
    await assert.rejects(item.coordinator.wait(runId), /Atomic fixture evidence does not match/);
    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.match(String(run?.metadata.atomicFixtureFailure ?? run?.metadata.sandboxFailureCode), /identity|WRITER_SANDBOX_FAILED/i);
    assert.equal(run?.metadata.externalActionPerformed, false);
    assert.equal((await item.store.listArtifacts(runId)).length, 0);
    assert.equal((await item.store.listApprovals()).length, 0);
    assert.equal((await item.store.listMemoryProposals()).length, 0);
    assert.equal((await item.store.getSandboxInstance(runId))?.state, "quarantined");
  } finally {
    await item.close();
  }
});

test("tampered deterministic check artifact is rejected even when top-level evidence claims success", async () => {
  const item = await fixture({ tamperChecks: true });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-tampered-checks"));
    const runId = started.run.run.id;
    await assert.rejects(item.coordinator.wait(runId), /checks does not match the reviewed deterministic contract/i);
    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.equal(run?.metadata.externalActionPerformed, false);
    assert.equal((await item.store.listArtifacts(runId)).length, 0);
    assert.equal((await item.store.listApprovals()).length, 0);
    assert.equal((await item.store.listMemoryProposals()).length, 0);
  } finally {
    await item.close();
  }
});

test("mutation after native validation is rejected against the stopped governed export snapshot", async () => {
  const item = await fixture({ mutateAfterValidation: true });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-post-validation-mutation"));
    const runId = started.run.run.id;
    await assert.rejects(item.coordinator.wait(runId), /quarantined: export_validation_failed/i);
    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.equal(run?.metadata.externalActionPerformed, false);
    assert.equal(run?.metadata.atomicFixtureFrozenExportsValidated, undefined);
    assert.equal((run?.metadata.atomicFixtureValidatedWorkspaceArtifacts as unknown[])?.length, 9);
    assert.equal((await item.store.listArtifacts(runId)).length, 0);
    assert.equal((await item.store.listApprovals()).length, 0);
    assert.equal((await item.store.listMemoryProposals()).length, 0);
    assert.equal((await item.store.getWorkspaceLease(String(run?.workspaceId)))?.state, "quarantined");
  } finally {
    await item.close();
  }
});

test("staged-context marker corruption after sandbox cleanup blocks every approval", async () => {
  const item = await fixture({ tamperContextMarkerOnCleanup: true });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-context-cleanup-marker"));
    const runId = started.run.run.id;
    await assert.rejects(item.coordinator.wait(runId), /context marker does not match cleanup target/i);
    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.equal((await item.store.getSandboxInstance(runId))?.state, "cleaned");
    assert.equal(existsSync(join(item.contextRoot, runId)), true);
    assert.equal((await item.store.listArtifacts(runId)).length, 9);
    assert.equal((await item.store.listApprovals("pending")).length, 0);
    assert.equal((await item.store.listMemoryProposals()).length, 0);
  } finally {
    await item.close();
  }
});

test("approval fails closed when a governed artifact is changed after export", async () => {
  const item = await fixture();
  try {
    const { runId, approval } = await runToApproval(item, "atomic-pilot-export-tamper");
    const path = join(item.root, "governed-artifacts", runId, ".valkyrie-output", "checks.json");
    const checksArtifact = (await item.store.listArtifacts(runId)).find((artifact) =>
      artifact.kind === "deterministic-checks");
    assert.ok(checksArtifact);
    writeFileSync(path, json({ schema_version: "1.0.0", passed: false, tampered_after_export: true }), "utf8");
    await assert.rejects(
      item.service.readAtomicFixtureArtifact(runId, checksArtifact.id),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unavailable|no longer matches/i);
        assert.equal(error.message.includes(item.root), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    await assert.rejects(
      item.service.resolveAtomicFixtureApproval(approval.id, "approve", "wesley"),
      /governed artifact bytes|reviewed checksum/i,
    );
    assert.equal((await item.store.getApproval(approval.id))?.state, "pending");
    assert.equal((await item.store.getRun(runId))?.status, "awaiting_approval");
    assert.equal((await item.store.listEvents(runId)).some((event) => event.type === "atomic.fixture.accepted"), false);
  } finally {
    await item.close();
  }
});

test("restart fails closed when a governed artifact was deleted while approval was pending", async () => {
  const item = await fixture();
  try {
    const { runId, approval } = await runToApproval(item, "atomic-pilot-export-delete");
    rmSync(join(item.root, "governed-artifacts", runId, ".valkyrie-output", "verifier.json"));
    await assert.rejects(
      item.coordinator.reconcileStartup(),
      /contents no longer match|artifact verification/i,
    );
    assert.equal((await item.store.getApproval(approval.id))?.state, "pending");
    assert.equal((await item.store.getRun(runId))?.status, "awaiting_approval");
  } finally {
    await item.close();
  }
});

test("native prompt failure settles its lifecycle waiter without an unhandled rejection", async () => {
  const item = await fixture({ failWorkflowListPrompt: true });
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-prompt-failure"));
    await assert.rejects(item.coordinator.wait(started.run.run.id), /workflow-list failure/i);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.deepEqual(unhandled, []);
    assert.equal((await item.store.getRun(started.run.run.id))?.status, "failed");
    assert.equal((await item.store.listApprovals()).length, 0);
  } finally {
    process.off("unhandledRejection", listener);
    await item.close();
  }
});

test("one wall-clock deadline bounds early Atomic RPC commands", async () => {
  const item = await fixture({ readDelayMs: 2_000 }, { workflowTimeoutMs: 1_000 });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-rpc-deadline"));
    await item.provider.rpcOpened;
    const startedAt = Date.now();
    await assert.rejects(
      item.coordinator.wait(started.run.run.id),
      /timed out|elapsed-time bound/i,
    );
    assert.ok(Date.now() - startedAt < 1_900, "the first RPC command must not outlive the workflow deadline");
    assert.equal((await item.store.getRun(started.run.run.id))?.status, "failed");
    assert.equal((await item.store.listApprovals()).length, 0);
  } finally {
    await item.close();
  }
});

test("expired M5 approval is atomically denied by the normal service tick", async () => {
  const item = await fixture();
  try {
    const { runId, approval } = await runToApproval(item, "atomic-pilot-expiry");
    assert.ok(approval.expiresAt);
    const approvalResidual = join(item.contextRoot, runId);
    mkdirSync(approvalResidual, { mode: 0o700 });
    writeFileSync(
      join(approvalResidual, ".valkyrie-context.json"),
      JSON.stringify({ schemaVersion: 1, runId }),
      { encoding: "utf8", mode: 0o600 },
    );
    await item.coordinator.reconcileStartup();
    assert.equal(existsSync(approvalResidual), false);
    item.setNow(Date.parse(approval.expiresAt) + 1);
    await item.service.tick();
    const expired = await item.store.getApproval(approval.id);
    assert.equal(expired?.state, "denied");
    assert.equal(expired?.decision, "expired");
    assert.equal(expired?.resolvedBy, "control-plane");
    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.equal(run?.stage, "approval_expired");
    assert.equal(run?.metadata.approvalExpired, true);
    assert.equal(run?.metadata.externalActionPerformed, false);
    await assert.rejects(item.service.resolveAtomicFixtureApproval(approval.id, "approve", "wesley"), /expired|different decision|already/i);
    assert.equal((await item.store.listEvents(runId)).some((event) => event.type === "approval.expired"), true);
  } finally {
    await item.close();
  }
});

test("cancelling an approval-ready M5 run atomically closes its evidence-bound approval", async () => {
  const item = await fixture();
  try {
    const { runId, approval } = await runToApproval(item, "atomic-pilot-cancel-approval");
    const cancelled = await item.service.cancelRun(runId);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.stage, "cancelled");
    assert.equal(cancelled.run.metadata.approvalDecision, "cancelled");
    assert.equal(cancelled.run.metadata.humanDecision, undefined);
    assert.equal(cancelled.run.metadata.safeMockAcceptanceReceipt, false);
    assert.equal(cancelled.run.metadata.externalActionPerformed, false);
    assert.equal(cancelled.run.metadata.memoryPromoted, false);
    const closed = await item.store.getApproval(approval.id);
    assert.equal(closed?.state, "denied");
    assert.equal(closed?.decision, "cancelled");
    assert.equal(closed?.resolvedBy, "authenticated-control-plane-client");
    assert.equal(closed?.evidenceDigest, approval.evidenceDigest);
    assert.equal(closed?.policyHash, approval.policyHash);
    await assert.rejects(
      item.service.resolveAtomicFixtureApproval(approval.id, "approve", "wesley"),
      /different decision/i,
    );
    assert.equal((await item.store.getRun(runId))?.status, "cancelled");
    const cancellation = (await item.store.listEvents(runId)).filter((event) => event.type === "run.cancelled");
    assert.equal(cancellation.length, 1);
    assert.equal(cancellation[0].payload.evidenceDigest, approval.evidenceDigest);
  } finally {
    await item.close();
  }
});

test("queued claim contention retries and wait does not finish before claim release", async () => {
  const item = await fixture();
  let allowRelease!: () => void;
  let markReleaseEntered!: () => void;
  const releaseGate = new Promise<void>((resolvePromise) => { allowRelease = resolvePromise; });
  const releaseEntered = new Promise<void>((resolvePromise) => { markReleaseEntered = resolvePromise; });
  const originalClaim = item.store.claimQueuedRunForStart.bind(item.store);
  const originalRelease = item.store.releaseRunClaim.bind(item.store);
  let claimAttempts = 0;
  item.store.claimQueuedRunForStart = async (...args) => {
    claimAttempts += 1;
    if (claimAttempts === 1) {
      const stalePath = join(item.contextRoot, args[0]);
      mkdirSync(stalePath, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(stalePath, ".valkyrie-context.json"),
        JSON.stringify({ schemaVersion: 1, runId: args[0] }),
        { encoding: "utf8", mode: 0o600 },
      );
    }
    if (claimAttempts <= 2) return null;
    return originalClaim(...args);
  };
  item.store.releaseRunClaim = async (...args) => {
    markReleaseEntered();
    await releaseGate;
    return originalRelease(...args);
  };
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-claim-retry"));
    const runId = started.run.run.id;
    await releaseEntered;
    let waitSettled = false;
    const waiting = item.coordinator.wait(runId).then(() => { waitSettled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.equal(waitSettled, false);
    allowRelease();
    await waiting;
    assert.equal(claimAttempts, 3);
    assert.equal((await item.store.getRun(runId))?.status, "awaiting_approval");
    assert.equal(existsSync(join(item.contextRoot, runId)), false);
  } finally {
    allowRelease?.();
    await item.close();
  }
});

test("shutdown aborts only a queued claim wait without falsely failing the run", async () => {
  const item = await fixture();
  let markAttempted!: () => void;
  const attempted = new Promise<void>((resolvePromise) => { markAttempted = resolvePromise; });
  item.store.claimQueuedRunForStart = async () => {
    markAttempted();
    return null;
  };
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-claim-shutdown"));
    const runId = started.run.run.id;
    await attempted;
    await item.coordinator.shutdown();
    await item.coordinator.wait(runId);
    const run = await item.store.getRun(runId);
    assert.equal(run?.status, "queued");
    assert.equal(run?.metadata.atomicFixtureFailure, undefined);
    assert.equal((await item.store.listEvents(runId)).some((event) => event.type === "run.failed"), false);
  } finally {
    await item.close();
  }
});

test("startup reconciliation quarantines a queued run with a workspace but no sandbox", async () => {
  const item = await fixture();
  try {
    await item.coordinator.shutdown();
    const started = await item.service.startRun(startInput("atomic-pilot-queued-workspace"));
    const run = started.run.run;
    const workspaceId = `workspace_${sha(run.id).slice(0, 24)}`;
    const workspacePath = join(item.root, "stranded-queued-workspace");
    mkdirSync(workspacePath, { mode: 0o700 });
    const ownedContextPath = join(item.contextRoot, run.id);
    mkdirSync(ownedContextPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(ownedContextPath, ".valkyrie-context.json"),
      JSON.stringify({ schemaVersion: 1, runId: run.id }),
      { encoding: "utf8", mode: 0o600 },
    );
    await item.store.createWorkspaceLease({
      id: workspaceId,
      runId: run.id,
      path: workspacePath,
      provider: "git-worktree",
      status: "leased",
      createdAt: item.now().toISOString(),
    }, {
      workspaceId,
      runId: run.id,
      ownerId: "stranded_atomic_writer",
      mode: "writer",
      heartbeatAt: item.now().toISOString(),
      expiresAt: new Date(item.now().getTime() + 30_000).toISOString(),
    });
    item.store.listRuns = async () => { throw new Error("pilot reconciliation must not use capped listRuns"); };

    const replacement = new AtomicFixturePilotCoordinator({
      store: item.store,
      brain: item.brain,
      boundary: item.boundary,
      provider: item.provider,
      packageDir,
      repositoryPath: item.repositoryPath,
      repositoryCommit: item.repositoryCommit,
      contextRoot: item.contextRoot,
      maxCostUsd: 0.5,
      now: item.now,
      workflowTimeoutMs: 5_000,
      statusPollMs: 10,
      approvalTtlMs: 60_000,
    });
    item.coordinators.push(replacement);
    const summary = await replacement.reconcileStartup();
    assert.equal(summary.queuedScheduled, 0);
    assert.equal(item.provider.startCount, 0);
    const failed = await item.store.getRun(run.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.stage, "workspace_quarantined");
    assert.equal(failed?.metadata.reconciliationReason, "queued_run_workspace_without_sandbox");
    assert.equal((await item.store.getWorkspaceLease(workspaceId))?.state, "quarantined");
    assert.equal(existsSync(ownedContextPath), false);
    assert.equal((await item.store.listApprovals("pending")).length, 0);
  } finally {
    await item.close();
  }
});

test("restart reconciliation recovers an evidence-ready approval without duplicating governed state", async () => {
  const item = await fixture();
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolvePromise) => { markFirstEntered = resolvePromise; });
  const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
  const originalRequest = item.store.requestApprovalTransaction.bind(item.store);
  let blockFirst = true;
  item.store.requestApprovalTransaction = async (input) => {
    if (blockFirst) {
      blockFirst = false;
      markFirstEntered();
      await firstGate;
    }
    return originalRequest(input);
  };
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-restart"));
    const runId = started.run.run.id;
    await firstEntered;
    assert.equal((await item.store.getRun(runId))?.stage, "evidence_ready");
    assert.equal((await item.store.listApprovals()).length, 0);

    const beforeRecovery = await item.store.getRun(runId);
    assert.ok(beforeRecovery);
    await item.store.updateRun(runId, {
      status: "running",
      stage: "sandbox_cleaned_before_evidence_patch",
      metadata: { ...beforeRecovery.metadata, sandboxEvidenceReady: false },
    });
    const stagedPath = join(item.contextRoot, runId);
    mkdirSync(stagedPath, { mode: 0o700 });
    writeFileSync(
      join(stagedPath, ".valkyrie-context.json"),
      JSON.stringify({ schemaVersion: 1, runId }),
      { encoding: "utf8", mode: 0o600 },
    );

    const originalListArtifacts = item.store.listArtifacts.bind(item.store);
    item.store.listArtifacts = async (candidateRunId) => [...await originalListArtifacts(candidateRunId)].reverse();
    item.store.listRuns = async () => { throw new Error("pilot reconciliation must not use capped listRuns"); };
    const originalListApprovals = item.store.listApprovals.bind(item.store);
    let pendingListCalls = 0;
    item.store.listApprovals = async (state) => {
      if (state === "pending") pendingListCalls += 1;
      return originalListApprovals(state);
    };

    const replacement = new AtomicFixturePilotCoordinator({
      store: item.store,
      brain: item.brain,
      boundary: item.boundary,
      provider: item.provider,
      packageDir,
      repositoryPath: item.repositoryPath,
      repositoryCommit: item.repositoryCommit,
      contextRoot: item.contextRoot,
      maxCostUsd: 0.5,
      now: item.now,
      workflowTimeoutMs: 5_000,
      statusPollMs: 10,
      approvalTtlMs: 60_000,
    });
    item.coordinators.push(replacement);
    const summary = await replacement.reconcileStartup();
    assert.equal(summary.approvalsRecovered, 1);
    assert.equal(pendingListCalls, 1);
    assert.equal((await item.store.getRun(runId))?.status, "awaiting_approval");
    assert.equal((await item.store.getRun(runId))?.metadata.atomicFixtureCleanedRecovery, true);
    assert.equal(existsSync(stagedPath), false);
    assert.equal((await item.store.listApprovals("pending")).length, 1);
    const recoveredApproval = (await item.store.listApprovals("pending"))[0];
    assert.deepEqual(
      recoveredApproval.evidence.map((entry) => entry.slice(0, entry.indexOf(":"))),
      [
        "atomic-launch-manifest",
        "atomic-pilot-evidence",
        "candidate-patch",
        "deterministic-checks",
        "draft-pr-mock",
        "fresh-deterministic-verifier",
        "memory-proposal-draft",
        "project-brain-context-pack",
        "run-contract",
      ],
    );
    releaseFirst();
    await item.coordinator.wait(runId);
    assert.equal((await item.store.listApprovals("pending")).length, 1);
    assert.equal((await item.store.listMemoryProposals("proposed")).length, 1);
    assert.equal((await item.store.listArtifacts(runId)).length, 9);
  } finally {
    releaseFirst?.();
    await item.close();
  }
});

test("Atomic fixture coordinator cannot exceed the workflow contract elapsed-time bound", async () => {
  const item = await fixture();
  try {
    assert.throws(() => new AtomicFixturePilotCoordinator({
      store: item.store,
      brain: item.brain,
      boundary: item.boundary,
      provider: item.provider,
      packageDir,
      repositoryPath: item.repositoryPath,
      repositoryCommit: item.repositoryCommit,
      contextRoot: item.contextRoot,
      maxCostUsd: 0.5,
      now: item.now,
      workflowTimeoutMs: ATOMIC_FIXTURE_BOUNDS.max_elapsed_seconds * 1_000 + 1,
      statusPollMs: 10,
      approvalTtlMs: 60_000,
    }), /workflow timeout must be between 1000 and 120000 milliseconds/);
  } finally {
    await item.close();
  }
});

test("human cancellation aborts an active native workflow and performs no governed final action", async () => {
  const item = await fixture({ runningPolls: 1_000_000_000 });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-cancel"));
    const runId = started.run.run.id;
    await item.provider.rpcOpened;
    const cancelled = await item.service.cancelRun(runId);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.stage, "cancelled");
    assert.equal(cancelled.run.metadata.cancelledBy, "authenticated-control-plane-client");
    assert.equal(cancelled.run.metadata.externalActionPerformed, false);
    assert.equal((await item.store.listArtifacts(runId)).length, 0);
    assert.equal((await item.store.listApprovals()).length, 0);
    assert.equal((await item.store.listMemoryProposals()).length, 0);
    assert.equal((await item.store.listEvents(runId)).some((event) => event.type === "run.cancelled"), true);
  } finally {
    await item.close();
  }
});

test("transactional admission permits only one nonterminal Atomic fixture pilot", async () => {
  const item = await fixture({ runningPolls: 1_000_000_000 });
  try {
    const first = await item.service.startRun(startInput("atomic-pilot-admission-first"));
    await item.provider.rpcOpened;
    await assert.rejects(
      item.service.startRun(startInput("atomic-pilot-admission-second")),
      /admission limit reached/i,
    );
    assert.equal((await item.store.listRuns()).length, 1);
    await item.service.cancelRun(first.run.run.id);
  } finally {
    await item.close();
  }
});

test("human cancellation never masks container-cleanup quarantine as a clean cancellation", async () => {
  const item = await fixture({ runningPolls: 1_000_000_000, quarantineCleanup: true });
  try {
    const started = await item.service.startRun(startInput("atomic-pilot-cancel-quarantine"));
    const runId = started.run.run.id;
    await item.provider.rpcOpened;
    const result = await item.service.cancelRun(runId);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.stage, "workspace_quarantined");
    assert.notEqual(result.run.metadata.containerCleanupProven, true);
    assert.equal((await item.store.listEvents(runId)).some((event) => event.type === "run.cancelled"), false);
    const workspace = await item.store.getWorkspaceForRun(runId);
    assert.ok(workspace);
    assert.equal((await item.store.getWorkspaceLease(workspace.id))?.state, "quarantined");
  } finally {
    await item.close();
  }
});
