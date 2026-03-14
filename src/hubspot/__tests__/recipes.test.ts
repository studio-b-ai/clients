import { describe, it, expect, vi } from 'vitest';
import { upsertByProperty, associateObjects, pipelineStageMap } from '../recipes.js';

// --- Mock factory ---

function mockClient() {
  return {
    searchObjects: vi.fn(),
    createObject: vi.fn(),
    updateObject: vi.fn(),
    listPipelines: vi.fn(),
    // Private fetch accessed via (client as any).fetch for associateObjects
    fetch: vi.fn(),
  };
}

// --- Tests ---

describe('upsertByProperty', () => {
  it('creates a new object when none found', async () => {
    const client = mockClient();
    client.searchObjects.mockResolvedValue({ total: 0, results: [] });
    client.createObject.mockResolvedValue({ id: 'new-123' });

    const result = await upsertByProperty(
      client as any,
      'contacts',
      'email',
      'jane@example.com',
      { email: 'jane@example.com', firstname: 'Jane' },
    );

    expect(client.searchObjects).toHaveBeenCalledWith('contacts', {
      filterGroups: [
        {
          filters: [
            { propertyName: 'email', operator: 'EQ', value: 'jane@example.com' },
          ],
        },
      ],
      limit: 1,
    });
    expect(client.createObject).toHaveBeenCalledWith('contacts', {
      email: 'jane@example.com',
      firstname: 'Jane',
    });
    expect(result).toEqual({ id: 'new-123', created: true });
  });

  it('updates an existing object when found', async () => {
    const client = mockClient();
    client.searchObjects.mockResolvedValue({
      total: 1,
      results: [{ id: 'existing-456' }],
    });
    client.updateObject.mockResolvedValue({ id: 'existing-456' });

    const result = await upsertByProperty(
      client as any,
      'companies',
      'acumatica_customer_id',
      'C001',
      { name: 'Acme Corp', acumatica_customer_id: 'C001' },
    );

    expect(client.updateObject).toHaveBeenCalledWith('companies', 'existing-456', {
      name: 'Acme Corp',
      acumatica_customer_id: 'C001',
    });
    expect(result).toEqual({ id: 'existing-456', created: false });
  });
});

describe('associateObjects', () => {
  it('calls v4 association API via client.fetch', async () => {
    const client = mockClient();
    client.fetch.mockResolvedValue({});

    await associateObjects(client as any, 'deals', 'deal-1', 'companies', 'co-2', 509);

    expect(client.fetch).toHaveBeenCalledWith(
      'PUT',
      '/crm/v4/objects/deals/deal-1/associations/companies/co-2',
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 509 }],
    );
  });
});

describe('pipelineStageMap', () => {
  it('returns a Map of label to stage ID for the matching pipeline', async () => {
    const client = mockClient();
    client.listPipelines.mockResolvedValue({
      results: [
        {
          pipelineId: 'pipe-1',
          label: 'Support',
          stages: [
            { stageId: 's1', label: 'New' },
            { stageId: 's2', label: 'In Progress' },
            { stageId: 's3', label: 'Closed' },
          ],
        },
        {
          pipelineId: 'pipe-2',
          label: 'Other',
          stages: [{ stageId: 's4', label: 'Open' }],
        },
      ],
    });

    const map = await pipelineStageMap(client as any, 'tickets', 'pipe-1');

    expect(map).toBeInstanceOf(Map);
    expect(map.get('New')).toBe('s1');
    expect(map.get('In Progress')).toBe('s2');
    expect(map.get('Closed')).toBe('s3');
    expect(map.size).toBe(3);
  });

  it('throws when pipeline not found', async () => {
    const client = mockClient();
    client.listPipelines.mockResolvedValue({
      results: [{ pipelineId: 'pipe-1', label: 'Support', stages: [] }],
    });

    await expect(pipelineStageMap(client as any, 'tickets', 'nonexistent')).rejects.toThrow(
      'Pipeline nonexistent not found',
    );
  });
});
