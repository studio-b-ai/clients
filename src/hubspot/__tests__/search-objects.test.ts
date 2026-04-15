/**
 * Regression tests for HubSpotClient.searchObjects() — filterGroups passthrough.
 *
 * These tests guard against filter-dropping bugs where filterGroups passed by
 * a caller are silently dropped before the outbound HTTP POST to HubSpot's
 * CRM search API.
 *
 * Tests 1–3: Unit tests using vi.stubGlobal to mock the global fetch.
 * Test 4:    Integration test gated behind HUBSPOT_ACCESS_TOKEN env var.
 *
 * Run unit tests only:  npx vitest run src/hubspot/__tests__/search-objects
 * Run all (inc. integ): HUBSPOT_ACCESS_TOKEN=<tok> npx vitest run src/hubspot/__tests__/search-objects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubSpotClient } from '../client.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Captured request bodies from mocked fetch calls. */
let capturedBodies: unknown[] = [];

/**
 * Build a mock fetch that records every request body and returns a minimal
 * HubSpot search response: { total: 0, results: [] }.
 */
function mockFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    capturedBodies.push(body);
    return new Response(JSON.stringify({ total: 0, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/** Shorthand: last recorded request body. */
function lastBody(): Record<string, unknown> {
  return capturedBodies[capturedBodies.length - 1] as Record<string, unknown>;
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  capturedBodies = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Shared test client ─────────────────────────────────────────────────────

function makeClient() {
  return new HubSpotClient({ accessToken: 'test-token' });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — Single filter: hs_pipeline EQ
// ═══════════════════════════════════════════════════════════════════════════

describe('searchObjects — single filter passthrough', () => {
  it('sends the exact filterGroups in the outbound POST body', async () => {
    vi.stubGlobal('fetch', mockFetch());

    const client = makeClient();
    const filterGroups = [
      {
        filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' },
        ],
      },
    ];

    await client.searchObjects('tickets', { filterGroups });

    // Verify fetch was called (not just a local no-op)
    expect(capturedBodies).toHaveLength(1);

    const body = lastBody();

    // filterGroups must survive the round-trip into the outbound request body
    expect(body.filterGroups).toBeDefined();
    expect(body.filterGroups).toEqual(filterGroups);

    // Spot-check the individual filter is present and unmodified
    const groups = body.filterGroups as typeof filterGroups;
    expect(groups[0].filters).toHaveLength(1);
    expect(groups[0].filters[0]).toMatchObject({
      propertyName: 'hs_pipeline',
      operator: 'EQ',
      value: '880618530',
    });
  });

  it('targets the correct HubSpot search endpoint for tickets', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, _init?: RequestInit) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ total: 0, results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const client = makeClient();
    await client.searchObjects('tickets', {
      filterGroups: [
        { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' }] },
      ],
    });

    expect(capturedUrl).toContain('/crm/v3/objects/tickets/search');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — Multiple filters in one group (AND logic)
// ═══════════════════════════════════════════════════════════════════════════

describe('searchObjects — multiple filters in one group (AND)', () => {
  it('sends both filters in a single group without dropping any', async () => {
    vi.stubGlobal('fetch', mockFetch());

    const client = makeClient();
    const filterGroups = [
      {
        filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' },
          { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '12345' },
        ],
      },
    ];

    await client.searchObjects('tickets', { filterGroups });

    const body = lastBody();
    expect(body.filterGroups).toEqual(filterGroups);

    const groups = body.filterGroups as typeof filterGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0].filters).toHaveLength(2);

    // First filter intact
    expect(groups[0].filters[0]).toMatchObject({
      propertyName: 'hs_pipeline',
      operator: 'EQ',
      value: '880618530',
    });

    // Second filter intact
    expect(groups[0].filters[1]).toMatchObject({
      propertyName: 'hs_pipeline_stage',
      operator: 'EQ',
      value: '12345',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — Multiple filter groups (OR logic)
// ═══════════════════════════════════════════════════════════════════════════

describe('searchObjects — multiple filter groups (OR)', () => {
  it('sends all groups without collapsing or dropping any', async () => {
    vi.stubGlobal('fetch', mockFetch());

    const client = makeClient();
    const filterGroups = [
      { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' }] },
      { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: '876728330' }] },
    ];

    await client.searchObjects('tickets', { filterGroups });

    const body = lastBody();
    expect(body.filterGroups).toEqual(filterGroups);

    const groups = body.filterGroups as typeof filterGroups;
    expect(groups).toHaveLength(2);

    // Group 0 — first pipeline
    expect(groups[0].filters[0]).toMatchObject({
      propertyName: 'hs_pipeline',
      value: '880618530',
    });

    // Group 1 — second pipeline
    expect(groups[1].filters[0]).toMatchObject({
      propertyName: 'hs_pipeline',
      value: '876728330',
    });
  });

  it('does not conflate OR groups into a single group', async () => {
    vi.stubGlobal('fetch', mockFetch());

    const client = makeClient();
    await client.searchObjects('tickets', {
      filterGroups: [
        { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: 'AAA' }] },
        { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: 'BBB' }] },
        { filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: 'CCC' }] },
      ],
    });

    const groups = (lastBody().filterGroups as any[]);
    // Three separate OR groups — must NOT be merged into one
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((g: any) => g.filters).map((f: any) => f.value)).toEqual([
      'AAA',
      'BBB',
      'CCC',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4 — Integration test (gated behind HUBSPOT_ACCESS_TOKEN)
// ═══════════════════════════════════════════════════════════════════════════

describe('searchObjects — integration test (requires HUBSPOT_ACCESS_TOKEN)', () => {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;

  // Skip the entire suite when the token is not present.
  // This keeps the standard `vitest run` (no env var) green.
  if (!token) {
    it.skip('HUBSPOT_ACCESS_TOKEN not set — skipping integration tests', () => {});
    return;
  }

  it('returns fewer than 3,005 tickets for pipeline 880618530 (broken-count guard)', async () => {
    const client = new HubSpotClient({ accessToken: token });

    const result = await client.searchObjects('tickets', {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' },
          ],
        },
      ],
      properties: ['hs_pipeline', 'hs_pipeline_stage', 'subject'],
      limit: 100,
    });

    // If filterGroups are silently dropped, HubSpot returns ALL tickets across all
    // pipelines (~3,005 in the Heritage Fabrics portal), not just the filtered ones.
    // A real filtered count must be well below that threshold.
    expect(result.total).toBeLessThan(3_005);
  }, 30_000 /* 30 s — real API call */);

  it('every returned ticket belongs to pipeline 880618530', async () => {
    const client = new HubSpotClient({ accessToken: token });

    const result = await client.searchObjects('tickets', {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' },
          ],
        },
      ],
      properties: ['hs_pipeline'],
      limit: 50,
    });

    // If any ticket is in a different pipeline the filter was ignored
    for (const ticket of result.results as Array<{ properties: Record<string, string> }>) {
      expect(ticket.properties.hs_pipeline).toBe('880618530');
    }
  }, 30_000);
});
