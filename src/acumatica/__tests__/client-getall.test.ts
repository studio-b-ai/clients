/**
 * Tests for AcumaticaClient.getAll() pagination fix.
 *
 * Bug: the old `{ $top: top, $skip: skip, ...params }` spread meant a caller-supplied
 * `$top` in params was last and OVERRODE the loop's page size on every request, while
 * `skip` still advanced by 100 locally. A caller `$top=3000` against a 989-row result
 * set produced requests at $top=3000&$skip=0,100,...,900 — overlapping windows that
 * returned 5,390 rows (989 unique, duplicated 1×–10×). See the incident regression in
 * test (d) below.
 */
import { describe, it, expect, vi } from 'vitest';
import { AcumaticaClient } from '../client.js';

const BASE_CONFIG = {
  baseUrl: 'https://test.acumatica.com',
  username: 'api-bot',
  password: 'secret',
  tenant: 'TestCo',
  apiVersion: '24.200.001' as const,
};

/**
 * Build a client with `get` spied on. The spy simulates Acumatica's OData
 * `$top`/`$skip` semantics: slices the backing data and returns the requested
 * window exactly as a real endpoint would.
 *
 * @param data   The full backing row-set Acumatica would return.
 */
function makeClientWithData(data: Record<string, unknown>[]) {
  const client = new AcumaticaClient({ config: BASE_CONFIG });

  // vi.spyOn erases the generic return type — cast through unknown to Mock to
  // retain spy assertion methods while avoiding TS overlap errors.
  (vi.spyOn(client, 'get') as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_entity: string, params: Record<string, string | number> = {}) => {
      const top = typeof params.$top === 'number' ? params.$top : data.length;
      const skip = typeof params.$skip === 'number' ? params.$skip : 0;
      return data.slice(skip, skip + top);
    },
  );

  return client;
}

// ---------------------------------------------------------------------------
// (a) Default — no caller $top: requests carry $top=100 with $skip advancing
// ---------------------------------------------------------------------------
describe('getAll — (a) default no caller $top', () => {
  it('paginates with $top=100 and advancing $skip; stops on short page', async () => {
    // 250 rows → 3 pages: 100, 100, 50
    const data = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    const client = makeClientWithData(data);

    const result = await client.getAll('Entity');

    const calls = (client.get as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);

    // All requests must use $top=100
    for (const [, params] of calls) {
      expect((params as Record<string, number>).$top).toBe(100);
    }

    // $skip advances: 0, 100, 200
    expect((calls[0][1] as Record<string, number>).$skip).toBe(0);
    expect((calls[1][1] as Record<string, number>).$skip).toBe(100);
    expect((calls[2][1] as Record<string, number>).$skip).toBe(200);

    // All 250 rows returned, zero duplicates
    expect(result).toHaveLength(250);
    const ids = (result as { id: number }[]).map((r) => r.id);
    expect(new Set(ids).size).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// (b) Caller $top=250 — per-request $top never exceeds remaining; exact cap
// ---------------------------------------------------------------------------
describe('getAll — (b) caller $top=250', () => {
  it('returns exactly 250 rows with per-request $top capped at remaining', async () => {
    // 500 rows available — caller only wants 250
    const data = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const client = makeClientWithData(data);

    const result = await client.getAll('Entity', { $top: 250 });

    const calls = (client.get as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // 3 pages: 100, 100, 50 (to reach 250)
    expect(calls).toHaveLength(3);

    const requestTops = calls.map(([, p]) => (p as Record<string, number>).$top);
    expect(requestTops).toEqual([100, 100, 50]);

    expect(result).toHaveLength(250);
    const ids = (result as { id: number }[]).map((r) => r.id);
    expect(new Set(ids).size).toBe(250); // no duplicates
  });
});

// ---------------------------------------------------------------------------
// (c) Caller $skip=50 — first request carries $skip=50
// ---------------------------------------------------------------------------
describe('getAll — (c) caller $skip=50', () => {
  it('starts pagination at the caller-supplied offset', async () => {
    const data = Array.from({ length: 120 }, (_, i) => ({ id: i }));
    const client = makeClientWithData(data);

    const result = await client.getAll('Entity', { $skip: 50 });

    const calls = (client.get as unknown as ReturnType<typeof vi.fn>).mock.calls;

    // First request starts at $skip=50
    expect((calls[0][1] as Record<string, number>).$skip).toBe(50);

    // Rows 50..119 = 70 rows
    expect(result).toHaveLength(70);
    const ids = (result as { id: number }[]).map((r) => r.id);
    expect(ids[0]).toBe(50);
    expect(new Set(ids).size).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// (d) THE INCIDENT REGRESSION: 989-row backing set, caller $top=3000
//
// Old code: per-request $top=3000, $skip advances 0/100/200/.../900
// → requests returned windows [0..2999], [100..3098], ... each clipped to
//   [skip..989], concatenating 989+889+...+89 = 5,390 rows (989 unique).
// Fixed code: per-request $top=100, stops at the short page — returns exactly 989.
// ---------------------------------------------------------------------------
describe('getAll — (d) incident regression: 989-row set, caller $top=3000', () => {
  it('returns exactly 989 unique rows (not 5,390 duplicated rows from the old code)', async () => {
    // Simulate the exact incident: 989 rows, caller passes $top=3000
    const BACKING_ROWS = 989;
    const data = Array.from({ length: BACKING_ROWS }, (_, i) => ({ seq: i }));
    const client = makeClientWithData(data);

    const result = await client.getAll('Entity', { $top: 3000 });

    // Fixed: exactly 989 unique rows
    expect(result).toHaveLength(BACKING_ROWS);

    // Zero duplicates — every seq value appears exactly once
    const seqs = (result as { seq: number }[]).map((r) => r.seq);
    expect(new Set(seqs).size).toBe(BACKING_ROWS);

    // Verify per-request $top never exceeded 100 (old code sent $top=3000)
    const calls = (client.get as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, params] of calls) {
      expect((params as Record<string, number>).$top).toBeLessThanOrEqual(100);
    }

    /* Incident reference: old code ($top=3000 override) produced:
     * $top=3000&$skip=0   → 989 rows (full set, clipped)
     * $top=3000&$skip=100 → 889 rows
     * $top=3000&$skip=200 → 789 rows
     * ...
     * $top=3000&$skip=900 →  89 rows
     * Total = 989+889+789+...+89 = 5,390 rows (989 unique, 1×–10× duplicates)
     */
  });
});

// ---------------------------------------------------------------------------
// (e) Non-array / error response passthrough — existing behaviour preserved
// ---------------------------------------------------------------------------
describe('getAll — (e) non-array and error responses unchanged', () => {
  it('wraps a non-array, non-error object in a single-element array', async () => {
    const client = new AcumaticaClient({ config: BASE_CONFIG });
    vi.spyOn(client, 'get').mockResolvedValue({ OrderNbr: { value: '000001' } } as any);

    const result = await client.getAll('SalesOrder/SO/000001');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ OrderNbr: { value: '000001' } });
  });

  it('returns an error-shaped object wrapped in an array', async () => {
    const client = new AcumaticaClient({ config: BASE_CONFIG });
    vi.spyOn(client, 'get').mockResolvedValue({ error: true, message: 'Not found' } as any);

    const result = await client.getAll('Entity');
    expect(result).toHaveLength(1);
    expect((result[0] as { error: boolean }).error).toBe(true);
  });
});
