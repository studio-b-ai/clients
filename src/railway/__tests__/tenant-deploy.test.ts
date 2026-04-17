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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOYMENT_BLOCKED_STATES,
  DEPLOYMENT_TERMINAL_STATES,
  RailwayClient,
} from '../client.js';

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

  it('flattens projects across every workspace edge', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            me: {
              workspaces: [
                {
                  id: 'ws-a',
                  name: 'Personal',
                  projects: {
                    edges: [{ node: { id: 'p1', name: 'bolt-heritage', createdAt: '2026-04-01T00:00:00Z' } }],
                  },
                },
                {
                  id: 'ws-b',
                  name: 'Studio B',
                  projects: {
                    edges: [
                      { node: { id: 'p2', name: 'bolt-throwaway', createdAt: '2026-04-02T00:00:00Z' } },
                      { node: { id: 'p3', name: 'quarterbook', createdAt: '2026-04-03T00:00:00Z' } },
                    ],
                  },
                },
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

  it('returns an empty array when no workspaces exist', async () => {
    vi.stubGlobal('fetch', mockFetch([{ data: { me: { workspaces: [] } } }]));
    expect(await newClient().listProjects()).toEqual([]);
  });

  it('queries me.workspaces[].projects (non-deprecated path)', async () => {
    const fetchMock = mockFetch([{ data: { me: { workspaces: [] } } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().listProjects();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('workspaces');
    expect(body.query).toContain('projects');
    // Ensure we are NOT using the deprecated top-level me.projects shape
    expect(body.query).not.toMatch(/me\s*\{\s*projects\s*\{/);
  });
});

describe('createProject', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns {id, name} from projectCreate mutation', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ data: { projectCreate: { id: 'p-new', name: 'bolt-roth' } } }]),
    );
    expect(await newClient().createProject('bolt-roth')).toEqual({ id: 'p-new', name: 'bolt-roth' });
  });

  it('sends ProjectCreateInput with name + defaultEnvironmentName', async () => {
    const fetchMock = mockFetch([{ data: { projectCreate: { id: 'p1', name: 'bolt-acme' } } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newClient().createProject('bolt-acme');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain('projectCreate');
    expect(body.variables.input.name).toBe('bolt-acme');
    expect(body.variables.input.defaultEnvironmentName).toBe('production');
  });

  it('throws when the Railway API returns an error', async () => {
    vi.stubGlobal('fetch', mockFetch([{ errors: [{ message: 'Name already taken' }] }]));
    await expect(newClient().createProject('bolt-heritage')).rejects.toThrow(/Name already taken/i);
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

  it('takes the REDEPLOY path when the service has prior deployments', async () => {
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
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await newClient().triggerDeploy('svc-2', 'env-2');
    expect(result).toEqual({ deploymentId: '', path: 'redeploy' });

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

  it('returns the CustomDomain object from customDomainCreate', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          data: {
            customDomainCreate: {
              id: 'cd-1',
              domain: 'roth.bolt.b.studio',
              status: 'WAITING',
              syncStatus: 'WAITING',
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
    expect(result.status).toBe('WAITING');
    expect(result.syncStatus).toBe('WAITING');
  });

  it('sends all four required inputs (domain + projectId + serviceId + environmentId)', async () => {
    const fetchMock = mockFetch([
      {
        data: {
          customDomainCreate: {
            id: 'cd-1',
            domain: 'roth.bolt.b.studio',
            status: 'WAITING',
            syncStatus: 'WAITING',
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
            status: 'WAITING',
            syncStatus: 'WAITING',
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
            status: 'WAITING',
            syncStatus: 'WAITING',
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
