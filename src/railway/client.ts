/**
 * Railway GraphQL API client
 * https://docs.railway.com/reference/public-api
 *
 * Adapted from devops-mcp/src/railway/client.ts
 * Converted from module-level functions to class-based client.
 */

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// ── Types ──────────────────────────────────────────────

export interface RailwayClientConfig {
  token: string;
  projectId?: string;
}

export interface ServiceSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDetail {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentSummary {
  id: string;
  status: string;
  createdAt: string;
  meta?: {
    commitMessage?: string;
    branch?: string;
  };
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  isEphemeral: boolean;
}

export interface VariablePair {
  name: string;
  // value intentionally omitted for security
}

export interface LogEntry {
  timestamp: string;
  message: string;
  severity: string;
}

export interface ServiceDomain {
  id: string;
  domain: string;
  environmentId: string;
  serviceId: string;
}

export interface ProjectUsage {
  estimatedCost: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

// ── Project-level (list / create / delete / service) ─────

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface NewProjectEnvironment {
  id: string;
  name: string;
}

export interface NewProject {
  id: string;
  name: string;
  /**
   * Environments that exist on the newly-created project (typically just
   * `production`). Returned inline so the caller doesn't need a second
   * query — the tenant-deploy skill needs the production `environmentId`
   * for every subsequent call.
   */
  environments: NewProjectEnvironment[];
}

export interface NewService {
  id: string;
  name: string;
}

export interface CreateServiceFromRepoInput {
  projectId: string;
  name: string;
  /** owner/repo (e.g. `studio-b-ai/bolt-wms`) */
  repo: string;
  /** Git branch to deploy from. Defaults to `main`. */
  branch?: string;
}

/**
 * Every value in Railway's DeploymentStatus enum (introspected 2026-04-16).
 */
export type DeploymentStatus =
  | 'INITIALIZING'
  | 'QUEUED'
  | 'WAITING'
  | 'BUILDING'
  | 'DEPLOYING'
  | 'NEEDS_APPROVAL'
  | 'SLEEPING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CRASHED'
  | 'SKIPPED'
  | 'REMOVING'
  | 'REMOVED';

/**
 * Terminal deployment states — polling loops stop here. Non-`SUCCESS`
 * terminals mean the deploy is dead; rollback.
 */
export const DEPLOYMENT_TERMINAL_STATES: ReadonlySet<DeploymentStatus> = new Set([
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'SKIPPED',
  'REMOVED',
]);

/**
 * `NEEDS_APPROVAL` is NOT terminal — a deploy can sit here indefinitely.
 * Treating it as in-flight would hang the poller. Callers treat it as an
 * operator-intervention state: stop polling and surface to the human.
 */
export const DEPLOYMENT_BLOCKED_STATES: ReadonlySet<DeploymentStatus> = new Set([
  'NEEDS_APPROVAL',
]);

export interface DeploymentStatusResult {
  id: string;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CustomDomainStatus {
  /**
   * SSL cert lifecycle. Typical: `WAITING` → `ISSUING` → `ISSUED`, or
   * `FAILED` on verification error (see certificateErrorMessage).
   */
  certificateStatus: string;
  /**
   * Whether DNS verification has completed. When false, the operator
   * must ensure the CNAME/A record points at verificationDnsHost and
   * optionally the TXT record is set per verificationToken.
   */
  verified: boolean;
  /** Railway's expected DNS target (CNAME value). */
  verificationDnsHost?: string | null;
  /** Optional TXT-record token for verification. */
  verificationToken?: string | null;
  certificateErrorMessage?: string | null;
}

export type CustomDomainSyncStatus =
  | 'ACTIVE'
  | 'CREATING'
  | 'UPDATING'
  | 'DELETING'
  | 'DELETED'
  | 'UNSPECIFIED';

export interface CustomDomainResult {
  id: string;
  domain: string;
  /** Cert + verification state — object, NOT a scalar. */
  status: CustomDomainStatus;
  /** Railway-side sync state, enum. Wait for `ACTIVE`. */
  syncStatus: CustomDomainSyncStatus;
  projectId: string;
  serviceId: string;
  environmentId: string;
  targetPort?: number | null;
  createdAt: string;
}

// ── Client ─────────────────────────────────────────────

export class RailwayClient {
  private readonly token: string;
  private readonly projectId: string | undefined;

  constructor(config: RailwayClientConfig) {
    this.token = config.token;
    this.projectId = config.projectId;
  }

  /** Require projectId to be set — throws if constructor didn't receive one. */
  private requireProjectId(): string {
    if (!this.projectId) {
      throw new Error('RailwayClient: projectId is required for this operation. Pass { projectId } in constructor.');
    }
    return this.projectId;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Railway ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(`Railway GraphQL: ${json.errors.map((e) => e.message).join(', ')}`);
    }
    if (!json.data) {
      throw new Error('Railway GraphQL: empty response');
    }
    return json.data;
  }

  // ── Services ─────────────────────────────────────────

  /**
   * List services in a Railway project.
   *
   * **projectId resolution:** the optional `projectId` argument takes
   * precedence over the client's constructor default. Without this
   * override, tenant-deploy callers (bolt-deploy-tenant skill) that
   * target a brand-new project would silently get the MCP client's
   * default project's services instead — seen in rehearsal 3
   * (2026-04-17) where a throwaway project appeared to have all 24
   * studiob-platform services. If neither is set the call throws.
   */
  async listServices(projectId?: string): Promise<ServiceSummary[]> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.listServices: projectId is required — pass it or set it on the client.',
      );
    }
    const query = `
      query($projectId: String!) {
        project(id: $projectId) {
          services {
            edges {
              node {
                id
                name
                createdAt
                updatedAt
              }
            }
          }
        }
      }
    `;
    const data = await this.gql<{
      project: { services: { edges: Array<{ node: ServiceSummary }> } };
    }>(query, { projectId: effectiveProjectId });

    return data.project.services.edges.map((e) => e.node);
  }

  async getService(serviceId: string): Promise<ServiceDetail> {
    const query = `
      query($id: String!) {
        service(id: $id) {
          id
          name
          createdAt
          updatedAt
        }
      }
    `;
    const data = await this.gql<{ service: ServiceDetail }>(query, { id: serviceId });
    return data.service;
  }

  // ── Deployments ──────────────────────────────────────

  async getLatestDeployments(
    serviceId: string,
    environmentId: string,
    limit: number = 5
  ): Promise<DeploymentSummary[]> {
    // Railway schema: deployments(first: Int, input: DeploymentListInput).
    // `first` is a query-level pagination arg, NOT a field of
    // DeploymentListInput. Passing it inside the input silently returns
    // the default page size and would fail strict-typed callers.
    const query = `
      query($input: DeploymentListInput!, $first: Int!) {
        deployments(input: $input, first: $first) {
          edges {
            node {
              id
              status
              createdAt
              meta
            }
          }
        }
      }
    `;
    const data = await this.gql<{
      deployments: { edges: Array<{ node: DeploymentSummary }> };
    }>(query, {
      input: { serviceId, environmentId },
      first: limit,
    });

    return data.deployments.edges.map((e) => e.node);
  }

  /**
   * Trigger a service deploy. Auto-detects path:
   *
   * - **Initial deploy** (service has zero deployments): uses
   *   `serviceInstanceDeployV2(commitSha?, environmentId, serviceId): String!`
   *   which builds from the service's linked repo + branch and returns the
   *   new deploymentId directly.
   * - **Redeploy** (service has ≥1 prior deployment): uses
   *   `serviceInstanceRedeploy`, which redeploys the most recent
   *   deployment. Returns `deploymentId: ''` (the mutation returns a
   *   Boolean; caller queries `getLatestDeployments` to find the new
   *   deploymentId if they need it).
   *
   * Path selection via a preflight `getLatestDeployments(..., 1)`.
   */
  async triggerDeploy(
    serviceId: string,
    environmentId: string
  ): Promise<{ deploymentId: string; path: 'initial' | 'redeploy' }> {
    const recent = await this.getLatestDeployments(serviceId, environmentId, 1);
    if (recent.length === 0) {
      const { deploymentId } = await this.triggerInitialDeploy(serviceId, environmentId);
      return { deploymentId, path: 'initial' };
    }

    const query = `
      mutation($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    const data = await this.gql<{ serviceInstanceRedeploy: boolean }>(query, {
      serviceId,
      environmentId,
    });
    if (!data.serviceInstanceRedeploy) {
      throw new Error('[railway] serviceInstanceRedeploy returned false');
    }
    // After the redeploy mutation succeeds, Railway has created a new
    // deployment but `serviceInstanceRedeploy` returns only a Boolean.
    // Fetch the freshest deploymentId so the caller can poll it.
    // Without this, the skill (bolt-deploy-tenant) has to do a second
    // `railway_get_deployments` call just to find the id.
    const fresh = await this.getLatestDeployments(serviceId, environmentId, 1);
    const newDeploymentId = fresh[0]?.id ?? '';
    return { deploymentId: newDeploymentId, path: 'redeploy' };
  }

  /**
   * Trigger an initial deploy for a service that has no deployments yet.
   * Lower-level primitive used by `triggerDeploy`'s auto-detect — also
   * available directly for callers that know the service is fresh.
   *
   * Schema note: `deploymentCreate` does NOT exist in Railway's API.
   * The correct mutation is
   * `serviceInstanceDeployV2(commitSha?, environmentId, serviceId): String!`
   * which returns the deploymentId as a String (not an object with an id).
   */
  async triggerInitialDeploy(
    serviceId: string,
    environmentId: string
  ): Promise<{ deploymentId: string }> {
    const query = `
      mutation($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    const data = await this.gql<{ serviceInstanceDeployV2: string }>(query, {
      serviceId,
      environmentId,
    });
    return { deploymentId: data.serviceInstanceDeployV2 };
  }

  /**
   * Single-call status probe for a deployment. Callers run the polling
   * loop themselves (every Nsec up to a budget) and stop on any terminal
   * state — see `DEPLOYMENT_TERMINAL_STATES`.
   */
  async pollDeploy(deploymentId: string): Promise<DeploymentStatusResult> {
    const query = `
      query($id: String!) {
        deployment(id: $id) {
          id
          status
          createdAt
          updatedAt
        }
      }
    `;
    const data = await this.gql<{ deployment: DeploymentStatusResult }>(query, {
      id: deploymentId,
    });
    return data.deployment;
  }

  // ── Environments ─────────────────────────────────────

  /**
   * List environments in a Railway project.
   *
   * **projectId resolution:** same rules as `listServices`. Optional
   * `projectId` arg overrides the client default for tenant-deploy
   * callers.
   */
  async listEnvironments(projectId?: string): Promise<EnvironmentSummary[]> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.listEnvironments: projectId is required — pass it or set it on the client.',
      );
    }
    const query = `
      query($projectId: String!) {
        project(id: $projectId) {
          environments {
            edges {
              node {
                id
                name
                isEphemeral
              }
            }
          }
        }
      }
    `;
    const data = await this.gql<{
      project: { environments: { edges: Array<{ node: EnvironmentSummary }> } };
    }>(query, { projectId: effectiveProjectId });

    return data.project.environments.edges.map((e) => e.node);
  }

  // ── Variables (names only — never expose values) ─────

  async listVariableNames(
    serviceId: string,
    environmentId: string,
    projectId?: string,
  ): Promise<string[]> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.listVariableNames: projectId is required — pass it or set it on the client.',
      );
    }
    const query = `
      query($projectId: String!, $serviceId: String!, $environmentId: String!) {
        variables(
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        )
      }
    `;
    const data = await this.gql<{ variables: Record<string, string> }>(query, {
      projectId: effectiveProjectId,
      serviceId,
      environmentId,
    });

    // Return only keys — never values
    return Object.keys(data.variables);
  }

  // ── Logs ─────────────────────────────────────────────

  async getDeployLogs(deploymentId: string, limit: number = 50): Promise<LogEntry[]> {
    const query = `
      query($deploymentId: String!, $limit: Int) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          message
          severity
        }
      }
    `;

    try {
      const data = await this.gql<{ deploymentLogs: LogEntry[] }>(query, {
        deploymentId,
        limit,
      });
      return data.deploymentLogs;
    } catch {
      // Some Railway plans limit log access — degrade gracefully
      return [{ timestamp: new Date().toISOString(), message: 'Log access unavailable for this deployment', severity: 'WARN' }];
    }
  }

  // ── Environment Variable Upsert ──────────────────────

  /**
   * Upsert a single environment variable for a service.
   * WRITE-ONLY: values are set but never read back.
   * After setting, the service needs a deploy to pick up the change.
   *
   * **projectId resolution:** Railway's VariableUpsertInput requires
   * `projectId` (NON_NULL). Tenant-deploy callers (bolt-deploy-tenant
   * skill) operate on brand-new projects that aren't the client's
   * configured default, so `projectId` is accepted as an optional
   * parameter and takes precedence over `this.projectId`. If neither
   * is set the call throws.
   */
  async upsertVariable(
    serviceId: string,
    environmentId: string,
    name: string,
    value: string,
    projectId?: string,
  ): Promise<boolean> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.upsertVariable: projectId is required — either pass it as the 5th argument or set projectId on the client constructor.',
      );
    }
    const query = `
      mutation($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `;

    const data = await this.gql<{ variableUpsert: boolean }>(query, {
      input: {
        projectId: effectiveProjectId,
        serviceId,
        environmentId,
        name,
        value,
      },
    });

    return data.variableUpsert;
  }

  /**
   * Bulk upsert multiple environment variables. See `upsertVariable` for
   * the projectId resolution rules.
   */
  async upsertVariables(
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>,
    projectId?: string,
  ): Promise<{ set: number; failed: string[] }> {
    const failed: string[] = [];
    let set = 0;

    for (const [name, value] of Object.entries(variables)) {
      try {
        await this.upsertVariable(serviceId, environmentId, name, value, projectId);
        set++;
      } catch {
        failed.push(name);
      }
    }

    return { set, failed };
  }

  /**
   * Delete an environment variable. See `upsertVariable` for the
   * projectId resolution rules.
   */
  async deleteVariable(
    serviceId: string,
    environmentId: string,
    name: string,
    projectId?: string,
  ): Promise<boolean> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.deleteVariable: projectId is required — either pass it or set projectId on the client constructor.',
      );
    }
    const query = `
      mutation($input: VariableDeleteInput!) {
        variableDelete(input: $input)
      }
    `;

    const data = await this.gql<{ variableDelete: boolean }>(query, {
      input: {
        projectId: effectiveProjectId,
        serviceId,
        environmentId,
        name,
      },
    });

    return data.variableDelete;
  }

  // ── Service Domains ──────────────────────────────────

  /**
   * List all domains assigned to a service in an environment.
   */
  async listServiceDomains(
    serviceId: string,
    environmentId: string,
    projectId?: string,
  ): Promise<ServiceDomain[]> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.listServiceDomains: projectId is required — pass it or set it on the client.',
      );
    }
    const query = `
      query($projectId: String!, $serviceId: String!, $environmentId: String!) {
        domains(
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        ) {
          serviceDomains {
            id
            domain
            environmentId
            serviceId
          }
          customDomains {
            id
            domain
            environmentId
            serviceId
          }
        }
      }
    `;

    const data = await this.gql<{
      domains: {
        serviceDomains: ServiceDomain[];
        customDomains: ServiceDomain[];
      };
    }>(query, {
      projectId: effectiveProjectId,
      serviceId,
      environmentId,
    });

    return [...data.domains.serviceDomains, ...data.domains.customDomains];
  }

  /**
   * Generate a Railway service domain (*.up.railway.app). Defensive:
   * validates Railway returned a domain attached to the requested
   * serviceId. Rehearsal (2026-04-17) saw a cross-tenant leak where a
   * first call returned a DIFFERENT service's domain — root cause
   * unclear (operator-error or Railway edge case), but verifying the
   * response matches the request prevents a tenant deploy from ever
   * pointing its CNAME at another tenant's host.
   */
  async createServiceDomain(
    serviceId: string,
    environmentId: string
  ): Promise<ServiceDomain> {
    const query = `
      mutation($serviceId: String!, $environmentId: String!) {
        serviceDomainCreate(
          input: { serviceId: $serviceId, environmentId: $environmentId }
        ) {
          id
          domain
          environmentId
          serviceId
        }
      }
    `;

    const data = await this.gql<{ serviceDomainCreate: ServiceDomain }>(query, {
      serviceId,
      environmentId,
    });

    const result = data.serviceDomainCreate;
    if (result.serviceId !== serviceId) {
      throw new Error(
        `[railway] serviceDomainCreate returned a domain attached to serviceId=${result.serviceId} ` +
          `but the request targeted serviceId=${serviceId}. Refusing to return it. ` +
          `This could indicate operator error (wrong serviceId passed) or a Railway-side match. ` +
          `Do NOT point DNS at ${result.domain} for the requested service.`,
      );
    }
    if (result.environmentId !== environmentId) {
      throw new Error(
        `[railway] serviceDomainCreate returned a domain in environmentId=${result.environmentId} ` +
          `but the request targeted environmentId=${environmentId}. Refusing to return it.`,
      );
    }

    return result;
  }

  /**
   * Attach a CUSTOM domain to a service (e.g. `roth.bolt.b.studio`).
   *
   * Different from `createServiceDomain` (which generates the
   * `*.up.railway.app` auto-domain). Requires the operator to have
   * already configured a CNAME / A record pointing the custom hostname
   * at Railway — Railway verifies via `status` / `syncStatus` before
   * issuing SSL.
   *
   * Schema: `customDomainCreate(input: CustomDomainCreateInput!): CustomDomain!`
   * where CustomDomainCreateInput requires `domain`, `projectId`,
   * `serviceId`, `environmentId` (all NON_NULL) plus optional `targetPort`.
   *
   * Returns the full CustomDomain with `status` + `syncStatus` so the
   * caller can poll/surface cert-issuance progress.
   */
  async attachCustomDomain(params: {
    projectId: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    targetPort?: number;
  }): Promise<CustomDomainResult> {
    // CustomDomain.status is the CustomDomainStatus OBJECT type (fields:
    // certificateStatus, dnsRecords, verified, verificationDnsHost,
    // verificationToken, etc.) — not a scalar. Selecting `status` as a
    // bare field 400s. syncStatus is an enum (ACTIVE/CREATING/UPDATING/
    // DELETING/DELETED/UNSPECIFIED) — scalar selection is fine.
    const query = `
      mutation($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) {
          id
          domain
          status {
            certificateStatus
            verified
            verificationDnsHost
            verificationToken
            certificateErrorMessage
          }
          syncStatus
          projectId
          serviceId
          environmentId
          targetPort
          createdAt
        }
      }
    `;
    const input: Record<string, unknown> = {
      projectId: params.projectId,
      serviceId: params.serviceId,
      environmentId: params.environmentId,
      domain: params.domain,
    };
    if (params.targetPort !== undefined) input.targetPort = params.targetPort;
    const data = await this.gql<{ customDomainCreate: CustomDomainResult }>(query, { input });
    return data.customDomainCreate;
  }

  // ── Service Restart ──────────────────────────────────

  /**
   * Restart a service without a full redeploy. Uses the
   * `serviceInstanceRedeploy` mutation directly — a service with zero
   * deployments cannot be "restarted"; use `triggerDeploy`'s initial path
   * for that instead.
   */
  async restartService(
    serviceId: string,
    environmentId: string
  ): Promise<boolean> {
    const query = `
      mutation($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    const data = await this.gql<{ serviceInstanceRedeploy: boolean }>(query, {
      serviceId,
      environmentId,
    });
    return data.serviceInstanceRedeploy;
  }

  // ── Project Usage ────────────────────────────────────

  /**
   * Get estimated cost for current billing period.
   *
   * **projectId resolution:** same rules as `listServices`. Optional
   * `projectId` arg overrides the client default for tenant-deploy
   * callers.
   */
  async getProjectUsage(projectId?: string): Promise<ProjectUsage> {
    const effectiveProjectId = projectId ?? this.projectId;
    if (!effectiveProjectId) {
      throw new Error(
        'RailwayClient.getProjectUsage: projectId is required — pass it or set it on the client.',
      );
    }
    const query = `
      query($projectId: String!) {
        project(id: $projectId) {
          estimatedCost
          subscription {
            currentPeriodStart
            currentPeriodEnd
          }
        }
      }
    `;

    const data = await this.gql<{
      project: {
        estimatedCost: number;
        subscription: { currentPeriodStart: string; currentPeriodEnd: string };
      };
    }>(query, { projectId: effectiveProjectId });

    return {
      estimatedCost: data.project.estimatedCost,
      currentPeriodStart: data.project.subscription.currentPeriodStart,
      currentPeriodEnd: data.project.subscription.currentPeriodEnd,
    };
  }

  // ── Project-level (list / create / delete / service) ────

  /**
   * List every Railway project the configured token can see.
   *
   * Schema notes (introspected + live-tested 2026-04-17):
   * - `me.projects` is DEPRECATED (Railway removed it; returns empty).
   * - `me.workspaces[].projects` works for **personal/user tokens** but
   *   fails with "Not Authorized" for **workspace API tokens** because
   *   an API token has no `me` context (it's not a logged-in user).
   * - The top-level `projects { edges { node } }` query works for both
   *   personal tokens AND workspace API tokens — the token's implicit
   *   scope determines which projects are returned.
   *
   * Use the top-level query so both token types work. Prior versions of
   * this method used `me.workspaces[]` and failed under the production
   * studiob-api service's workspace-scoped API token.
   */
  async listProjects(): Promise<ProjectSummary[]> {
    const query = `
      query {
        projects {
          edges {
            node {
              id
              name
              createdAt
            }
          }
        }
      }
    `;
    const data = await this.gql<{
      projects: { edges: Array<{ node: ProjectSummary }> };
    }>(query);
    return data.projects.edges.map((e) => e.node);
  }

  /**
   * Create a new Railway project with a `production` default environment.
   * Returns `{id, name}`. Railway `ProjectCreateInput` does NOT accept a
   * project-level region; regions are configured per-service.
   */
  async createProject(name: string): Promise<NewProject> {
    const query = `
      mutation($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          id
          name
          environments {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;
    const data = await this.gql<{
      projectCreate: {
        id: string;
        name: string;
        environments: { edges: Array<{ node: NewProjectEnvironment }> };
      };
    }>(query, {
      input: { name, defaultEnvironmentName: 'production' },
    });
    const p = data.projectCreate;
    return {
      id: p.id,
      name: p.name,
      environments: p.environments.edges.map((e) => e.node),
    };
  }

  /**
   * Delete a Railway project. Cascades: every service, database, env
   * var, and custom domain under the project is destroyed. IRREVERSIBLE.
   *
   * Schema note: `projectDelete(id: String!)` takes the id as a direct
   * mutation arg, not wrapped in an input object.
   */
  async deleteProject(projectId: string): Promise<boolean> {
    const query = `
      mutation($id: String!) {
        projectDelete(id: $id)
      }
    `;
    const data = await this.gql<{ projectDelete: boolean }>(query, { id: projectId });
    return data.projectDelete;
  }

  /**
   * Create a Railway service sourced from a GitHub repo. Railway fetches
   * the latest `branch` commit on creation. A subsequent `triggerDeploy`
   * (which auto-detects the initial path) is required to actually build
   * and run the service.
   */
  async createServiceFromRepo(params: CreateServiceFromRepoInput): Promise<NewService> {
    const branch = params.branch ?? 'main';
    const query = `
      mutation($input: ServiceCreateInput!) {
        serviceCreate(input: $input) {
          id
          name
        }
      }
    `;
    const data = await this.gql<{ serviceCreate: NewService }>(query, {
      input: {
        projectId: params.projectId,
        name: params.name,
        source: { repo: params.repo },
        branch,
      },
    });
    return data.serviceCreate;
  }
}
