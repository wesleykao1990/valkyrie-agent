import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalProjectBrainProvider,
  OpenVikingProjectBrainProvider,
  ProjectBrainProviderError,
  type OpenVikingHit,
  type OpenVikingSearchRequest,
  type OpenVikingTransport,
} from "../apps/control-plane/src/project-brain-provider.ts";
import { createProjectBrainEvaluationFixture } from "../apps/control-plane/src/project-brain-evaluation.ts";

function hash(suffix: string): string {
  return `hash-${suffix}`;
}

function remoteHit(overrides: Partial<OpenVikingHit> = {}): OpenVikingHit {
  return {
    id: "brain-current",
    projectId: "brain-evaluation",
    namespace: "projects/brain-evaluation",
    source: "Projects/BrainEvaluation/Decisions/current.md",
    title: "Current deterministic decision",
    excerpt: "DELETION_SENTINEL_CURRENT_DECISION Use deterministic evidence and a read-only provider boundary.",
    authority: "canonical",
    status: "accepted",
    contentHash: hash("current"),
    type: "decision",
    supersedes: ["brain-old"],
    ...overrides,
  };
}

function remoteResponse(hits: readonly OpenVikingHit[]) {
  return {
    hits,
    revision: "ova-fixture-r1",
    usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, costUsd: 0.0012 },
  };
}

test("local provider preserves exact Project Brain reads and reports zero usage", async () => {
  const fixture = createProjectBrainEvaluationFixture();
  try {
    const provider = new LocalProjectBrainProvider(fixture.brain);
    assert.deepEqual(await provider.search(fixture.project, "deterministic evidence"), fixture.brain.search(fixture.project, "deterministic evidence"));
    assert.deepEqual(await provider.acceptedDecisions(fixture.project), fixture.brain.acceptedDecisions(fixture.project));
    const expected = fixture.brain.buildContextPack(fixture.project, "deterministic evidence", { runId: "run-local", taskId: "task-local" });
    const actual = await provider.buildContextPack(fixture.project, "deterministic evidence", { runId: "run-local", taskId: "task-local" });
    assert.deepEqual(actual, expected);
    assert.equal(provider.providerId, "local-markdown");
    assert.equal(provider.mode, "local-markdown-readonly");
    assert.equal(provider.metadata.revision, provider.revision);
    assert.deepEqual(provider.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 });
    const before = fixture.snapshot();
    await provider.search(fixture.project, "read-only");
    await provider.buildContextPack(fixture.project, "read-only", { runId: "run-read-only" });
    assert.equal(fixture.snapshot(), before, "provider reads must not mutate Markdown");
    fixture.deleteCurrentDecision();
    const afterDeletion = await provider.search(fixture.project, "DELETION_SENTINEL_CURRENT_DECISION");
    assert.equal(afterDeletion.some((result) => result.source === fixture.currentDecisionSource), false);
  } finally {
    fixture.dispose();
  }
});

test("OpenViking candidate is disabled by default and cannot widen a namespace", async () => {
  const fixture = createProjectBrainEvaluationFixture();
  const requests: OpenVikingSearchRequest[] = [];
  const transport: OpenVikingTransport = {
    async search(request) {
      requests.push(request);
      return remoteResponse([remoteHit()]);
    },
  };
  const provider = new OpenVikingProjectBrainProvider({
    transport,
    namespaces: {
      "brain-evaluation": "projects/brain-evaluation",
      shared: "shared",
    },
  });
  try {
    await assert.rejects(
      provider.search({ ...fixture.project, memoryNamespace: "attacker/namespace" }, "anything"),
      (error: unknown) => error instanceof ProjectBrainProviderError && error.code === "disabled",
    );
    assert.equal(requests.length, 0);
  } finally {
    fixture.dispose();
  }
});

test("OpenViking candidate revalidates ownership, authority, status, supersession, and deterministic ordering", async () => {
  const fixture = createProjectBrainEvaluationFixture();
  try {
    const requests: OpenVikingSearchRequest[] = [];
    const hits: OpenVikingHit[] = [
      remoteHit(),
      remoteHit({
        id: "brain-old",
        source: "Projects/BrainEvaluation/Decisions/old.md",
        title: "Old decision",
        excerpt: "DELETION_SENTINEL_OLD_DECISION Superseded evidence.",
        contentHash: hash("old"),
        supersedes: [],
      }),
      remoteHit({
        id: "brain-stale",
        source: "Projects/BrainEvaluation/Decisions/stale.md",
        title: "Stale decision",
        excerpt: "STALE_SUPPRESSED_SENTINEL stale evidence.",
        contentHash: hash("stale"),
        status: "stale",
        supersedes: [],
      }),
      remoteHit({
        id: "brain-advisory",
        source: "Projects/BrainEvaluation/Notes/advisory.md",
        title: "Advisory note",
        excerpt: "An advisory observation, never canonical context.",
        contentHash: hash("advisory"),
        authority: "advisory",
        status: "open",
        type: "note",
        supersedes: [],
      }),
      remoteHit({
        id: "shared-policy",
        projectId: "shared",
        namespace: "shared",
        source: "Shared/Policy.md",
        title: "Shared policy",
        excerpt: "Never silently promote memory.",
        contentHash: hash("shared"),
        authority: "canonical",
        status: "accepted",
        type: "policy",
        supersedes: [],
      }),
      remoteHit({
        id: "cross-project",
        projectId: "other-project",
        namespace: "projects/brain-evaluation",
        source: "Projects/Other/Decisions/other.md",
        title: "Other project",
        excerpt: "CROSS_PROJECT_MEMORY_SENTINEL",
        contentHash: hash("other"),
        supersedes: [],
      }),
      remoteHit({
        id: "wrong-namespace",
        projectId: "brain-evaluation",
        namespace: "shared",
        source: "Projects/BrainEvaluation/Decisions/wrong.md",
        title: "Wrong namespace",
        excerpt: "CROSS_PROJECT_MEMORY_SENTINEL",
        contentHash: hash("wrong-namespace"),
        supersedes: [],
      }),
    ];
    const transport: OpenVikingTransport = {
      async search(request) {
        requests.push(request);
        return remoteResponse(hits);
      },
    };
    const provider = new OpenVikingProjectBrainProvider({
      enabled: true,
      transport,
      namespaces: {
        "brain-evaluation": "projects/brain-evaluation",
        shared: "shared",
      },
    });
    const results = await provider.search({ ...fixture.project, memoryNamespace: "caller/must-be-ignored" }, "deterministic evidence", 10);
    assert.equal(results[0]?.source, fixture.currentDecisionSource);
    assert.equal(results.some((result) => result.source === fixture.supersededDecisionSource), false);
    assert.equal(results.some((result) => result.source === fixture.staleDecisionSource), false);
    assert.equal(results.some((result) => result.source === "Projects/Other/Decisions/other.md"), false);
    const pack = await provider.buildContextPack(fixture.project, "deterministic evidence", { runId: "remote-run" });
    assert.ok(pack.entries.some((entry) => entry.source === fixture.currentDecisionSource));
    assert.ok(pack.entries.some((entry) => entry.source === "Shared/Policy.md"));
    assert.ok(pack.entries.every((entry) => entry.authority === "canonical" && entry.status === "accepted"));
    assert.equal(pack.entries.some((entry) => entry.source === "Projects/BrainEvaluation/Notes/advisory.md"), false);
    assert.equal(provider.usage.inputTokens, 22);
    assert.equal(provider.usage.outputTokens, 6);
    assert.equal(provider.usage.totalTokens, 28);
    assert.equal(provider.usage.costUsd, 0.0024);
    assert.ok(requests.every((request) => request.namespace === "projects/brain-evaluation"));
    assert.ok(requests.every((request) => request.projectId === fixture.project.id));
  } finally {
    fixture.dispose();
  }
});

test("OpenViking rejects unbounded response batches and inconsistent usage", async () => {
  const fixture = createProjectBrainEvaluationFixture();
  try {
    const provider = new OpenVikingProjectBrainProvider({
      enabled: true,
      maxHits: 2,
      namespaces: { "brain-evaluation": "projects/brain-evaluation" },
      transport: {
        async search() {
          return {
            hits: [remoteHit(), remoteHit({ id: "second", supersedes: [] }), remoteHit({ id: "third", supersedes: [] })],
            revision: "r1",
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 99, costUsd: 0 },
          };
        },
      },
    });
    await assert.rejects(provider.search(fixture.project, "anything"), /bounded Project Brain contract/);

    const usageProvider = new OpenVikingProjectBrainProvider({
      enabled: true,
      namespaces: { "brain-evaluation": "projects/brain-evaluation" },
      transport: {
        async search() {
          return { hits: [], revision: "r1", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 99, costUsd: 0 } };
        },
      },
    });
    await assert.rejects(usageProvider.search(fixture.project, "anything"), (error: unknown) => error instanceof ProjectBrainProviderError && error.code === "invalid_usage");
  } finally {
    fixture.dispose();
  }
});
