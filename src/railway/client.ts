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

  async listServices(): Promise<ServiceSummary[]> {
    const projectId = this.requireProjectId();
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
    }>(query, { projectId });

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
    const query = `
      query($input: DeploymentListInput!) {
        deployments(input: $input) {
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
      input: { serviceId, environmentId, first: limit },
    });

    return data.deployments.edges.map((e) => e.node);
  }

  async triggerDeploy(
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

  // ── Environments ─────────────────────────────────────

  async listEnvironments(): Promise<EnvironmentSummary[]> {
    const projectId = this.requireProjectId();
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
    }>(query, { projectId });

    return data.project.environments.edges.map((e) => e.node);
  }

  // ── Variables (names only — never expose values) ─────

  async listVariableNames(
    serviceId: string,
    environmentId: string
  ): Promise<string[]> {
    const projectId = this.requireProjectId();
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
      projectId,
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
   */
  async upsertVariable(
    serviceId: string,
    environmentId: string,
    name: string,
    value: string
  ): Promise<boolean> {
    const projectId = this.requireProjectId();
    const query = `
      mutation($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `;

    const data = await this.gql<{ variableUpsert: boolean }>(query, {
      input: {
        projectId,
        serviceId,
        environmentId,
        name,
        value,
      },
    });

    return data.variableUpsert;
  }

  /**
   * Bulk upsert multiple environment variables.
   */
  async upsertVariables(
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>
  ): Promise<{ set: number; failed: string[] }> {
    const failed: string[] = [];
    let set = 0;

    for (const [name, value] of Object.entries(variables)) {
      try {
        await this.upsertVariable(serviceId, environmentId, name, value);
        set++;
      } catch {
        failed.push(name);
      }
    }

    return { set, failed };
  }

  /**
   * Delete an environment variable.
   */
  async deleteVariable(
    serviceId: string,
    environmentId: string,
    name: string
  ): Promise<boolean> {
    const projectId = this.requireProjectId();
    const query = `
      mutation($input: VariableDeleteInput!) {
        variableDelete(input: $input)
      }
    `;

    const data = await this.gql<{ variableDelete: boolean }>(query, {
      input: {
        projectId,
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
    environmentId: string
  ): Promise<ServiceDomain[]> {
    const projectId = this.requireProjectId();
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
      projectId,
      serviceId,
      environmentId,
    });

    return [...data.domains.serviceDomains, ...data.domains.customDomains];
  }

  /**
   * Generate a Railway service domain (*.up.railway.app).
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

    return data.serviceDomainCreate;
  }

  // ── Service Restart ──────────────────────────────────

  /**
   * Restart a service without a full redeploy.
   * Note: uses the same serviceInstanceRedeploy mutation as triggerDeploy,
   * but semantically distinct — this is for env var pickup / crash recovery.
   */
  async restartService(
    serviceId: string,
    environmentId: string
  ): Promise<boolean> {
    return this.triggerDeploy(serviceId, environmentId);
  }

  // ── Project Usage ────────────────────────────────────

  /**
   * Get estimated cost for current billing period.
   */
  async getProjectUsage(): Promise<ProjectUsage> {
    const projectId = this.requireProjectId();
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
    }>(query, { projectId });

    return {
      estimatedCost: data.project.estimatedCost,
      currentPeriodStart: data.project.subscription.currentPeriodStart,
      currentPeriodEnd: data.project.subscription.currentPeriodEnd,
    };
  }
}
