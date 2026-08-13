import type { M7ConnectorConfig } from "./config.ts";
import type { ControlPlaneStore } from "./store.ts";
import { GitAuthorityProvider } from "./git-authority.ts";
import {
  createGithubDraftPrPolicy,
  createLiveGithubDraftPrGateway,
  type GithubDraftPrGateway,
} from "./github-draft-pr-gateway.ts";
import {
  createLiveLinearAuthorityGateway,
  type LinearAuthorityGateway,
} from "./linear-authority.ts";
import type { ConnectorProjectPolicy } from "./connector-policy.ts";

export interface ProductionConnectorStatus {
  enabled: boolean;
  policyDigest: string | null;
  linear: {
    mode: M7ConnectorConfig["linear"]["mode"];
    configuredProjects: string[];
    credentialLoaded: boolean;
  };
  github: {
    mode: M7ConnectorConfig["github"]["mode"];
    configuredProjects: string[];
    credentialLoaded: boolean;
  };
  git: { configuredProjects: string[] };
  externalEffects: {
    linearIssueCreation: boolean;
    linearEvidenceComment: boolean;
    githubDraftPr: boolean;
    branchPublication: false;
    merge: false;
    deployment: false;
  };
}

export class ProductionConnectorRegistry {
  private readonly config: M7ConnectorConfig;
  private readonly projectPolicies: ReadonlyMap<string, ConnectorProjectPolicy>;
  private readonly linear = new Map<string, LinearAuthorityGateway>();
  private readonly git = new Map<string, GitAuthorityProvider>();
  private readonly githubRead = new Map<string, GithubDraftPrGateway>();

  constructor(config: M7ConnectorConfig, store: ControlPlaneStore) {
    this.config = config;
    this.projectPolicies = config.policy?.projects ?? new Map();
    for (const [projectId, policy] of this.projectPolicies) {
      if (policy.git) this.git.set(projectId, new GitAuthorityProvider({ policy: policy.git }));
      if (policy.linear && config.linear.mode !== "disabled" && config.linear.token) {
        this.linear.set(projectId, createLiveLinearAuthorityGateway({
          policy: policy.linear,
          token: config.linear.token,
          authMode: config.linear.authMode,
        }));
      }
      if (policy.github && config.github.mode !== "disabled" && config.github.token) {
        this.githubRead.set(projectId, createLiveGithubDraftPrGateway({
          policy: createGithubDraftPrPolicy(policy.github),
          token: config.github.token,
        }));
      }
    }
    // Linear writes are deliberately not driven from ordinary task.created
    // events. They are dispatched only by ExternalFinalActionCoordinator after
    // an immutable plan, exact approval, and adjacent authority revalidation.
    void store;
  }

  policyForProject(projectId: string): ConnectorProjectPolicy | undefined {
    return this.projectPolicies.get(projectId);
  }

  linearForProject(projectId: string): LinearAuthorityGateway | undefined {
    return this.linear.get(projectId);
  }

  linearWriteForProject(projectId: string): LinearAuthorityGateway | undefined {
    return this.config.linear.mode === "read-write" ? this.linear.get(projectId) : undefined;
  }

  gitForProject(projectId: string): GitAuthorityProvider | undefined {
    return this.git.get(projectId);
  }

  githubReadForProject(projectId: string): GithubDraftPrGateway | undefined {
    return this.githubRead.get(projectId);
  }

  /**
   * A write gateway binds the exact remote OIDs observed immediately before
   * construction. The final-action coordinator rechecks them again before the
   * provider call; a drifted ref therefore fails closed.
   */
  async githubDraftPrForProject(projectId: string): Promise<GithubDraftPrGateway | undefined> {
    if (this.config.github.mode !== "draft-pr" || !this.config.github.token) return undefined;
    const mapping = this.projectPolicies.get(projectId)?.github;
    const reader = this.githubRead.get(projectId);
    if (!mapping || !reader) return undefined;
    const refs = await reader.inspectRefs();
    return createLiveGithubDraftPrGateway({
      policy: createGithubDraftPrPolicy({
        ...mapping,
        approvedBaseOid: refs.baseOid,
        approvedHeadOid: refs.headOid,
      }),
      token: this.config.github.token,
    });
  }

  status(): ProductionConnectorStatus {
    const configuredProjects = [...this.projectPolicies.keys()].sort();
    return {
      enabled: this.config.policy !== undefined,
      policyDigest: this.config.policy?.digest ?? null,
      linear: {
        mode: this.config.linear.mode,
        configuredProjects: configuredProjects.filter((id) => this.projectPolicies.get(id)?.linear !== undefined),
        credentialLoaded: this.config.linear.token !== undefined,
      },
      github: {
        mode: this.config.github.mode,
        configuredProjects: configuredProjects.filter((id) => this.projectPolicies.get(id)?.github !== undefined),
        credentialLoaded: this.config.github.token !== undefined,
      },
      git: { configuredProjects: configuredProjects.filter((id) => this.projectPolicies.get(id)?.git !== undefined) },
      externalEffects: {
        linearIssueCreation: this.config.linear.mode === "read-write",
        linearEvidenceComment: this.config.linear.mode === "read-write",
        githubDraftPr: this.config.github.mode === "draft-pr",
        branchPublication: false,
        merge: false,
        deployment: false,
      },
    };
  }
}
