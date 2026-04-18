/**
 * Tests for the project-level Railway tools that power the Bolt
 * tenant-deploy skill. Every test stubs `fetch` — no real API calls.
 *
 * Covers:
 *   - listProjects (deprecated me.projects avoidance)
 *   - createProject / deleteProject (correct mutation shape)
 *   - createServiceFromRepo
 *   - triggerDeploy auto-detect (initial vs redeploy)
 *   - triggerInitialDeploy (serviceInstanceDeployV2, not deploymentCreate)
 *   - pollDeploy
 *   - getLatestDeployments pagination (first at query level, not in input)
 *   - DEPLOYMENT_TERMINAL_STATES / DEPLOYMENT_BLOCKED_STATES
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOYMENT_BLOCKED_STATES,
  DEPLOYMENT_TERMINAL_STATES,
  RailwayClient,
} from '../client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = readFileSync(resolve(__dirname, '../client.ts'), 'utf8');

function mockFetch(responses: Array<Record<string, unknown>>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    return { ok: true, json: async () => r } as Response;
  });
}

function newClient() {
  return new RailwayClient({ token: 'test-token' });
}

describe('listProjects', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns projects from the top-level projects query', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            projects: {
              edges: [
                { node: { id: 'p1', name: 'bolt-heritage', createdAt: '2026-04-01T00:00:00Z' } },
                { node: { id: 'p2', name: 'bolt-throwaway', createdAt: '2026-04-02T00:00:00Z' } },
                { node: { id: 'p3', name: 'quarterbook', createdAt: '2026-04-03T00:00:00Z' } },
              ],
            },
          },
        },
      ]),
    );

    const projects = await newClient().listProjects();
    expect(projects).toHaveLength(3);
    expect(projects.map((p) => p.name)).toEqual(['bolt-heritage', 'bolt-throwaway', 'quarterbook']);
  });

  it('returns an empty array when no projects exist', async () => {
    vi.stubGlobal('fetch', mockFetch([{ data: { projects: { edges: [] } } }]));
    expect(await newClient().listProjects()).toEqual([]);
  });

  it('uses the top-level projects query — NOT me.projects or me.workspaces', async () => {
    const fetchMock = mockFetch([{ data: { projects: { edges: [] } } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().listProjects();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    // Must use top-level `projects` — workspace API tokens have no `me` context
    // and would fail with 401 on any query that starts with `me { ... }`.
    expect(body.query).toMatch(/\{\s*projects\s*\{/);
    expect(body.query).not.toMatch(/me\s*\{\s*projects/);
    expect(body.query).not.toMatch(/me\s*\{\s*workspaces/);
  });
});

describe('createProject', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const projectCreateResponse = (id: string, name: string, envName = 'production') => ({
    data: {
      projectCreate: {
        id,
        name,
        environments: {
          edges: [{ node: { id: `env-${id}`, name: envName } }],
        },
      },
    },
  });

  it('returns {id, name, environments[]} from projectCreate mutation', async () => {
    vi.stubGlobal('fetch', mockFetch([projectCreateResponse('p-new', 'bolt-roth')]));
    const result = await newClient().createProject('bolt-roth');
    expect(result.id).toBe('p-new');
    expect(result.name).toBe('bolt-roth');
    expect(result.environments).toEqual([{ id: 'env-p-new', name: 'production' }]);
  });

  it('sends ProjectCreateInput with name + defaultEnvironmentName', async () => {
    const fetchMock = mockFetch([projectCreateResponse('p1', 'bolt-acme')]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().createProject('bolt-acme');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('projectCreate');
    expect(body.query).toContain('environments');
    expect(body.variables.input.name).toBe('bolt-acme');
    expect(body.variables.input.defaultEnvironmentName).toBe('production');
  });

  it('throws when the Railway API returns an error', async () => {
    vi.stubGlobal('fetch', mockFetch([{ errors: [{ message: 'Name already taken' }] }]));
    await expect(newClient().createProject('bolt-heritage')).rejects.toThrow(/Name already taken/i);
  });
});

describe('upsertVariables (bulk)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns {set, failed: []} when every variable succeeds', async () => {
    // upsertVariables loops per variable — one mutation per entry
    vi.stubGlobal(
      'fetch',
      mockFetch([
        { data: { variableUpsert: true } },
        { data: { variableUpsert: true } },
        { data: { variableUpsert: true } },
      ]),
    );
    const client = new RailwayClient({ token: 'test-token', projectId: 'p' });
    const result = await client.upsertVariables('svc', 'env', {
      JWT_SECRET: 'abc123',
      BRAND_NAME: 'Roth',
      BRAND_COLOR: '#1B2B4A',
    });
    expect(result).toEqual({ set: 3, failed: [] });
  });

  it('surfaces failed variable names so the skill can retry', async () => {
    // First call succeeds, second returns errors array → upsertVariable throws →
    // caught and pushed to failed[]
    vi.stubGlobal(
      'fetch',
      mockFetch([
        { data: { variableUpsert: true } },
        { errors: [{ message: 'rate-limited' }] },
        { data: { variableUpsert: true } },
      ]),
    );
    const client = new RailwayClient({ token: 'test-token', projectId: 'p' });
    const result = await client.upsertVariables('svc', 'env', {
      ONE: 'v1',
      TWO: 'v2',
      THREE: 'v3',
    });
    expect(result.set).toBe(2);
    expect(result.failed).toEqual(['TWO']);
  });
});

describe('deleteProject', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns true on successful delete', async () => {
    vi.stubGlobal('fetch', mockFetch([{ data: { projectDelete: true } }]));
    expect(await newClient().deleteProject('p-to-delete')).toBe(true);
  });

  it('passes the projectId as the id variable (direct arg, not input-wrapped)', async () => {
    const fetchMock = mockFetch([{ data: { projectDelete: true } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().deleteProject('p-roth-123');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    // Railway schema: projectDelete(id: String!) — direct arg
    expect(body.query).toContain('projectDelete(id: $id)');
    expect(body.variables).toEqual({ id: 'p-roth-123' });
  });

  it('throws when the API returns an error (e.g. not authorized)', async () => {
    vi.stubGlobal('fetch', mockFetch([{ errors: [{ message: 'Not authorized' }] }]));
    await expect(newClient().deleteProject('p-forbidden')).rejects.toThrow(/Not authorized/i);
  });
});

describe('createServiceFromRepo', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns {id, name} from serviceCreate', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ data: { serviceCreate: { id: 's-abc', name: 'bolt-wms' } } }]),
    );
    const result = await newClient().createServiceFromRepo({
      projectId: 'p1',
      name: 'bolt-wms',
      repo: 'studio-b-ai/bolt-wms',
      branch: 'main',
    });
    expect(result).toEqual({ id: 's-abc', name: 'bolt-wms' });
  });

  it('passes projectId + name + source.repo + branch to the mutation', async () => {
    const fetchMock = mockFetch([{ data: { serviceCreate: { id: 's1', name: 'bolt-wms' } } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().createServiceFromRepo({
      projectId: 'p-roth',
      name: 'bolt-wms',
      repo: 'studio-b-ai/bolt-wms',
      branch: 'main',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.input.projectId).toBe('p-roth');
    expect(body.variables.input.name).toBe('bolt-wms');
    expect(body.variables.input.source.repo).toBe('studio-b-ai/bolt-wms');
    expect(body.variables.input.branch).toBe('main');
  });

  it('defaults branch to main when not provided', async () => {
    const fetchMock = mockFetch([{ data: { serviceCreate: { id: 's', name: 'svc' } } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().createServiceFromRepo({
      projectId: 'p',
      name: 'svc',
      repo: 'owner/repo',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.input.branch).toBe('main');
  });
});

describe('triggerDeploy auto-detect', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('takes the INITIAL path when the service has no prior deployments', async () => {
    const fetchMock = mockFetch([
      { data: { deployments: { edges: [] } } }, // preflight
      { data: { serviceInstanceDeployV2: 'd-initial-1' } }, // mutation
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await newClient().triggerDeploy('svc-1', 'env-1');
    expect(result).toEqual({ deploymentId: 'd-initial-1', path: 'initial' });

    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.query).toContain('serviceInstanceDeployV2');
    // Make sure we are NOT hitting the non-existent deploymentCreate
    expect(body.query).not.toContain('deploymentCreate');
  });

  it('takes the REDEPLOY path and returns the fresh deploymentId (not empty)', async () => {
    // Rehearsal 2026-04-17 caught: the old code returned deploymentId=''
    // forcing the skill to do a redundant railway_get_deployments call.
    // Now the client does that fetch internally after the redeploy
    // mutation succeeds, so callers always get a usable deploymentId.
    const fetchMock = mockFetch([
      {
        data: {
          deployments: {
            edges: [
              { node: { id: 'd-prev', status: 'SUCCESS', createdAt: '2026-04-15T00:00:00Z' } },
            ],
          },
        },
      },
      { data: { serviceInstanceRedeploy: true } },
      {
        data: {
          deployments: {
            edges: [
              { node: { id: 'd-fresh-redeploy', status: 'BUILDING', createdAt: '2026-04-17T00:00:00Z' } },
            ],
          },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await newClient().triggerDeploy('svc-2', 'env-2');
    expect(result).toEqual({ deploymentId: 'd-fresh-redeploy', path: 'redeploy' });

    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.query).toContain('serviceInstanceRedeploy');
  });

  it('throws when redeploy mutation returns false', async () => {
    const fetchMock = mockFetch([
      {
        data: {
          deployments: {
            edges: [{ node: { id: 'd-prev', status: 'SUCCESS', createdAt: '2026-04-15T00:00:00Z' } }],
          },
        },
      },
      { data: { serviceInstanceRedeploy: false } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(newClient().triggerDeploy('svc-3', 'env-3')).rejects.toThrow(
      /serviceInstanceRedeploy returned false/i,
    );
  });
});

describe('triggerInitialDeploy', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('uses serviceInstanceDeployV2 and returns the deploymentId', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ data: { serviceInstanceDeployV2: 'd-abc-123' } }]),
    );
    const result = await newClient().triggerInitialDeploy('svc', 'env');
    expect(result).toEqual({ deploymentId: 'd-abc-123' });
  });
});

describe('pollDeploy', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns SUCCESS terminal state', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            deployment: {
              id: 'd-1',
              status: 'SUCCESS',
              createdAt: '2026-04-16T00:00:00Z',
              updatedAt: '2026-04-16T00:05:00Z',
            },
          },
        },
      ]),
    );
    const result = await newClient().pollDeploy('d-1');
    expect(result.status).toBe('SUCCESS');
  });

  it('returns in-flight BUILDING', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            deployment: {
              id: 'd-2',
              status: 'BUILDING',
              createdAt: '2026-04-16T00:00:00Z',
              updatedAt: '2026-04-16T00:01:00Z',
            },
          },
        },
      ]),
    );
    const result = await newClient().pollDeploy('d-2');
    expect(result.status).toBe('BUILDING');
  });

  it('surfaces FAILED so the caller stops polling', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            deployment: {
              id: 'd-3',
              status: 'FAILED',
              createdAt: '2026-04-16T00:00:00Z',
              updatedAt: '2026-04-16T00:02:00Z',
            },
          },
        },
      ]),
    );
    const result = await newClient().pollDeploy('d-3');
    expect(result.status).toBe('FAILED');
  });
});

describe('getLatestDeployments pagination', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('passes `first` at the query level, NOT inside DeploymentListInput', async () => {
    const fetchMock = mockFetch([{ data: { deployments: { edges: [] } } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().getLatestDeployments('svc-page', 'env-page', 7);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);

    // `first` is a top-level variable, not inside `input`
    expect(body.variables.first).toBe(7);
    expect(body.variables.input).toEqual({ serviceId: 'svc-page', environmentId: 'env-page' });
    expect(body.query).toContain('deployments(input: $input, first: $first)');
  });
});

describe('DEPLOYMENT_TERMINAL_STATES', () => {
  it('includes every Railway terminal state (introspected 2026-04-16)', () => {
    expect(DEPLOYMENT_TERMINAL_STATES.has('SUCCESS')).toBe(true);
    expect(DEPLOYMENT_TERMINAL_STATES.has('FAILED')).toBe(true);
    expect(DEPLOYMENT_TERMINAL_STATES.has('CRASHED')).toBe(true);
    expect(DEPLOYMENT_TERMINAL_STATES.has('SKIPPED')).toBe(true);
    expect(DEPLOYMENT_TERMINAL_STATES.has('REMOVED')).toBe(true);
  });

  it('does NOT include in-flight or blocked states', () => {
    for (const s of ['INITIALIZING', 'QUEUED', 'WAITING', 'BUILDING', 'DEPLOYING', 'SLEEPING', 'REMOVING']) {
      expect(DEPLOYMENT_TERMINAL_STATES.has(s as never)).toBe(false);
    }
    expect(DEPLOYMENT_TERMINAL_STATES.has('NEEDS_APPROVAL')).toBe(false);
    expect(DEPLOYMENT_BLOCKED_STATES.has('NEEDS_APPROVAL')).toBe(true);
  });
});

describe('attachCustomDomain', () => {
  beforeEach(() => vi.unstubAllGlobals());

  // Railway returns `status` as the CustomDomainStatus OBJECT type
  // (not a scalar). `syncStatus` is an enum. The prior query selected
  // `status` as a bare field and 400'd. Fixed as of PR #28.
  const statusObj = {
    certificateStatus: 'ISSUING',
    verified: false,
    verificationDnsHost: 'verify.railway.app',
    verificationToken: 'tok-123',
    certificateErrorMessage: null,
  };

  it('returns the CustomDomain object from customDomainCreate (status is an object, syncStatus is an enum)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            customDomainCreate: {
              id: 'cd-1',
              domain: 'roth.bolt.b.studio',
              status: statusObj,
              syncStatus: 'CREATING',
              projectId: 'p-roth',
              serviceId: 'svc-bolt-wms',
              environmentId: 'env-prod',
              targetPort: null,
              createdAt: '2026-04-16T00:00:00Z',
            },
          },
        },
      ]),
    );

    const result = await newClient().attachCustomDomain({
      projectId: 'p-roth',
      serviceId: 'svc-bolt-wms',
      environmentId: 'env-prod',
      domain: 'roth.bolt.b.studio',
    });

    expect(result.domain).toBe('roth.bolt.b.studio');
    expect(result.status.certificateStatus).toBe('ISSUING');
    expect(result.status.verified).toBe(false);
    expect(result.syncStatus).toBe('CREATING');
  });

  it('selects status subfields (not as a bare scalar)', async () => {
    const fetchMock = mockFetch([
      {
        data: {
          customDomainCreate: {
            id: 'cd-1',
            domain: 'x.b.studio',
            status: statusObj,
            syncStatus: 'CREATING',
            projectId: 'p',
            serviceId: 's',
            environmentId: 'e',
            targetPort: null,
            createdAt: '2026-04-16T00:00:00Z',
          },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().attachCustomDomain({
      projectId: 'p',
      serviceId: 's',
      environmentId: 'e',
      domain: 'x.b.studio',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    // Must select subfields of `status { ... }` — Railway changed the type.
    expect(body.query).toMatch(/status\s*\{/);
    expect(body.query).toContain('certificateStatus');
    expect(body.query).toContain('verified');
    // syncStatus is an enum — should NOT have a subselection
    expect(body.query).not.toMatch(/syncStatus\s*\{/);
  });

  it('sends all four required inputs (domain + projectId + serviceId + environmentId)', async () => {
    const fetchMock = mockFetch([
      {
        data: {
          customDomainCreate: {
            id: 'cd-1',
            domain: 'roth.bolt.b.studio',
            status: statusObj,
            syncStatus: 'CREATING',
            projectId: 'p',
            serviceId: 's',
            environmentId: 'e',
            targetPort: null,
            createdAt: '2026-04-16T00:00:00Z',
          },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().attachCustomDomain({
      projectId: 'p-roth',
      serviceId: 'svc-bolt-wms',
      environmentId: 'env-prod',
      domain: 'roth.bolt.b.studio',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('customDomainCreate');
    expect(body.variables.input).toEqual({
      projectId: 'p-roth',
      serviceId: 'svc-bolt-wms',
      environmentId: 'env-prod',
      domain: 'roth.bolt.b.studio',
    });
  });

  it('includes targetPort when provided', async () => {
    const fetchMock = mockFetch([
      {
        data: {
          customDomainCreate: {
            id: 'cd-1',
            domain: 'foo.b.studio',
            status: statusObj,
            syncStatus: 'CREATING',
            projectId: 'p',
            serviceId: 's',
            environmentId: 'e',
            targetPort: 8080,
            createdAt: '2026-04-16T00:00:00Z',
          },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().attachCustomDomain({
      projectId: 'p',
      serviceId: 's',
      environmentId: 'e',
      domain: 'foo.b.studio',
      targetPort: 8080,
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.input.targetPort).toBe(8080);
  });

  it('omits targetPort from the mutation input when not provided', async () => {
    const fetchMock = mockFetch([
      {
        data: {
          customDomainCreate: {
            id: 'cd-1',
            domain: 'foo.b.studio',
            status: statusObj,
            syncStatus: 'CREATING',
            projectId: 'p',
            serviceId: 's',
            environmentId: 'e',
            targetPort: null,
            createdAt: '2026-04-16T00:00:00Z',
          },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().attachCustomDomain({
      projectId: 'p',
      serviceId: 's',
      environmentId: 'e',
      domain: 'foo.b.studio',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.input).not.toHaveProperty('targetPort');
  });
});

describe('createServiceDomain defensive check (rehearsal bug 2)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('throws when Railway returns a domain attached to a different serviceId', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            serviceDomainCreate: {
              id: 'sd-1',
              domain: 'bolt-wms-production.up.railway.app',
              environmentId: 'env-prod',
              serviceId: 'HERITAGE_SERVICE_ID', // mismatch with requested
            },
          },
        },
      ]),
    );

    await expect(
      newClient().createServiceDomain('THROWAWAY_SERVICE_ID', 'env-prod'),
    ).rejects.toThrow(/serviceId=HERITAGE_SERVICE_ID/i);
  });

  it('throws when Railway returns a domain in a different environment', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            serviceDomainCreate: {
              id: 'sd-1',
              domain: 'ok.up.railway.app',
              environmentId: 'wrong-env',
              serviceId: 'svc',
            },
          },
        },
      ]),
    );

    await expect(
      newClient().createServiceDomain('svc', 'expected-env'),
    ).rejects.toThrow(/environmentId=wrong-env/i);
  });

  it('returns the domain when serviceId + environmentId both match', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            serviceDomainCreate: {
              id: 'sd-1',
              domain: 'bolt-wms-production-7a3e.up.railway.app',
              environmentId: 'env-prod',
              serviceId: 'svc',
            },
          },
        },
      ]),
    );

    const result = await newClient().createServiceDomain('svc', 'env-prod');
    expect(result.domain).toBe('bolt-wms-production-7a3e.up.railway.app');
  });
});

describe('restartService', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('calls serviceInstanceRedeploy directly (does NOT depend on triggerDeploy shape)', async () => {
    const fetchMock = mockFetch([{ data: { serviceInstanceRedeploy: true } }]);
    vi.stubGlobal('fetch', fetchMock);

    const ok = await newClient().restartService('svc', 'env');
    expect(ok).toBe(true);
    // Only one call — restartService should NOT issue the triggerDeploy preflight
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('serviceInstanceRedeploy');
  });
});

// ──────────────────────────────────────────────────────────────
// projectId override on read-side project-scoped queries.
//
// Regression for bolt-deploy-tenant rehearsal 3 (2026-04-17): the
// skill passed `project_id` to `railway_list_services` expecting it
// to scope the query to the tenant project, but the MCP tool
// silently forwarded to `client.listServices()` which uses the
// constructor's default projectId. The caller got 24 services from
// studiob-platform instead of the 2 services in the tenant project,
// and the mismatch looked plausible because studiob-platform happens
// to also have Postgres + Redis. Same pattern as PR #27 for the
// write-side methods (upsert/delete/listDomains).
// ──────────────────────────────────────────────────────────────

describe('listServices (projectId override)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const servicesResponse = { data: { project: { services: { edges: [] } } } };

  it('uses the passed-in projectId, not the client default', async () => {
    const fetchMock = mockFetch([servicesResponse]);
    vi.stubGlobal('fetch', fetchMock);

    const client = new RailwayClient({ token: 'test-token', projectId: 'studiob-platform' });
    await client.listServices('bolt-throwaway');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.projectId).toBe('bolt-throwaway');
    expect(body.variables.projectId).not.toBe('studiob-platform');
  });

  it('falls back to the client default when no projectId is passed', async () => {
    const fetchMock = mockFetch([servicesResponse]);
    vi.stubGlobal('fetch', fetchMock);

    const client = new RailwayClient({ token: 'test-token', projectId: 'studiob-platform' });
    await client.listServices();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.projectId).toBe('studiob-platform');
  });

  it('throws when neither the client nor the caller provides a projectId', async () => {
    vi.stubGlobal('fetch', mockFetch([servicesResponse]));
    const client = new RailwayClient({ token: 'test-token' });
    await expect(client.listServices()).rejects.toThrow(/projectId is required/i);
  });
});

describe('listEnvironments (projectId override)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const environmentsResponse = { data: { project: { environments: { edges: [] } } } };

  it('uses the passed-in projectId, not the client default', async () => {
    const fetchMock = mockFetch([environmentsResponse]);
    vi.stubGlobal('fetch', fetchMock);

    const client = new RailwayClient({ token: 'test-token', projectId: 'studiob-platform' });
    await client.listEnvironments('bolt-throwaway');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.projectId).toBe('bolt-throwaway');
  });

  it('throws when neither the client nor the caller provides a projectId', async () => {
    vi.stubGlobal('fetch', mockFetch([environmentsResponse]));
    const client = new RailwayClient({ token: 'test-token' });
    await expect(client.listEnvironments()).rejects.toThrow(/projectId is required/i);
  });
});

describe('getProjectUsage (projectId override)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const usageResponse = {
    data: {
      project: {
        estimatedCost: 12.34,
        subscription: {
          currentPeriodStart: '2026-04-01T00:00:00Z',
          currentPeriodEnd: '2026-05-01T00:00:00Z',
        },
      },
    },
  };

  it('uses the passed-in projectId, not the client default', async () => {
    const fetchMock = mockFetch([usageResponse]);
    vi.stubGlobal('fetch', fetchMock);

    const client = new RailwayClient({ token: 'test-token', projectId: 'studiob-platform' });
    await client.getProjectUsage('bolt-throwaway');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.projectId).toBe('bolt-throwaway');
  });

  it('throws when neither the client nor the caller provides a projectId', async () => {
    vi.stubGlobal('fetch', mockFetch([usageResponse]));
    const client = new RailwayClient({ token: 'test-token' });
    await expect(client.getProjectUsage()).rejects.toThrow(/projectId is required/i);
  });
});

// ──────────────────────────────────────────────────────────────
// Guard against the `requireProjectId()` anti-pattern coming back.
//
// The helper made it trivial to write a method that silently used
// the client's default projectId and ignored any override. PRs #27
// and #32 replaced every call site with the
// `projectId ?? this.projectId` pattern. If a future method needs
// to scope by projectId it MUST accept it as an optional argument
// and resolve via the override-or-default pattern, not resurrect
// requireProjectId.
//
// This is a source-scan test rather than a behavioural one —
// behavioural coverage only catches the methods we happen to test,
// and the whole point of the anti-pattern is that missing coverage
// for a new method looks identical to success.
// ──────────────────────────────────────────────────────────────
describe('requireProjectId anti-pattern guard', () => {
  it('does not define or call requireProjectId anywhere in client.ts', () => {
    expect(CLIENT_SOURCE).not.toContain('requireProjectId');
  });

  it('resolves projectId via the override-or-default pattern (projectId ?? this.projectId)', () => {
    // Every method that consumes projectId should route through the
    // `?? this.projectId` coalesce. If someone adds a new method that
    // uses `this.projectId` directly without an override arg, the
    // direct-use count rises while the coalesce count stays flat —
    // the delta trips this assertion.
    //
    // Strip comments first so doc-comment references don't count.
    const code = CLIENT_SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');
    const directUses = code.match(/this\.projectId/g)?.length ?? 0;
    const coalesceUses = code.match(/\?\?\s*this\.projectId/g)?.length ?? 0;
    // The constructor assignment (`this.projectId = config.projectId`)
    // is the only sanctioned non-coalesce use. Every other reference
    // must be on the right-hand side of a `??`.
    expect(directUses - coalesceUses).toBeLessThanOrEqual(1);
  });
});
