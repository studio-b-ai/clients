/**
 * Wire-format COMPLETENESS guard for HubSpotClient search bodies (Rule #252 at the source).
 *
 * `buildSearchBody()` assembles the outbound POST body from an ENUMERATED list of
 * `HubSpotSearchOpts` fields. That shape has one failure mode: a documented field that
 * is accepted by the type but never copied into the body is dropped SILENTLY — the call
 * still 200s, the caller sees a plausible response, and only the end-to-end behaviour is
 * wrong.
 *
 * Live incident 2026-08-16 (webhook-router#608/#609/#610): a consumer pinned to a client
 * version whose search body omitted `after` re-fetched page 1 ten times (`paging.next.after`
 * came back identical every call because the cursor never reached the wire), walked 1,000
 * phantom "twins" and blew the Acumatica hourly call budget (742/500). The existing
 * search-objects tests only pinned `filterGroups`, so nothing here would have caught it.
 *
 * This file is the guard:
 *   1. `FULL_OPTS` is typed `Required<HubSpotSearchOpts>` — adding a NEW field to the
 *      interface fails typecheck until this literal names it, and the runtime assertion
 *      then requires it to land in the body. An enumerated-return drop is caught where it
 *      is written, not in a downstream consumer's incident.
 *   2. Every public search method (`searchObjects` + the four typed searches) is exercised
 *      through the REAL function with a fetch spy capturing what production emitted
 *      (Rules #46/#223 — never a hand-assembled body).
 *   3. `after` gets a named regression: a two-page walk asserts the cursor ADVANCES on the
 *      wire (page 2's body carries page 1's `paging.next.after`).
 *   4. Negative controls (Rule #322): the two DOCUMENTED omissions stay omissions
 *      (`query: ''` is dropped on purpose; undocumented keys are not passed through), so
 *      the guard proves it can tell "field dropped" from "field intentionally absent".
 *
 * Run: npx vitest run src/hubspot/__tests__/search-body-completeness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubSpotClient, type HubSpotSearchOpts } from '../client.js';

// ─── Fetch spy ──────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

let captured: Captured[] = [];

/** Mock fetch that records every outbound search body and answers with `response`. */
function stubFetch(response: unknown = { total: 0, results: [] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function lastBody(): Record<string, unknown> {
  return captured[captured.length - 1].body;
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeClient() {
  return new HubSpotClient({ accessToken: 'test-token' });
}

// ─── The completeness fixture ───────────────────────────────────────────────
//
// `Required<HubSpotSearchOpts>`: if a field is ever added to the interface, this literal
// no longer typechecks until the new field is named here — which is the point. Filter
// values are strings on purpose so the builder's String() coercion is an identity and the
// body can be compared with toEqual.

const FULL_OPTS: Required<HubSpotSearchOpts> = {
  query: 'acme',
  filterGroups: [
    {
      filters: [
        { propertyName: 'hs_pipeline', operator: 'EQ', value: '880618530' },
        { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: '1723680000000' },
      ],
    },
  ],
  properties: ['hs_object_id', 'subject'],
  limit: 7,
  sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
  after: '12345',
};

const DOCUMENTED_FIELDS = Object.keys(FULL_OPTS) as Array<keyof HubSpotSearchOpts>;

/** Every documented field must be present in `body` with the value the caller supplied. */
function expectEveryDocumentedFieldOnTheWire(body: Record<string, unknown>) {
  const missing = DOCUMENTED_FIELDS.filter((k) => !(k in body));
  expect(missing, `documented HubSpotSearchOpts fields dropped from the wire body: ${missing.join(', ')}`).toEqual([]);
  for (const k of DOCUMENTED_FIELDS) {
    expect(body[k], `field "${k}" mutated on the wire`).toEqual(FULL_OPTS[k]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Every public search method carries EVERY documented field
// ═══════════════════════════════════════════════════════════════════════════

describe('search body completeness — every documented HubSpotSearchOpts field survives serialization', () => {
  it('searchObjects(objectType, opts) puts every documented field on the wire', async () => {
    stubFetch();
    await makeClient().searchObjects('tickets', FULL_OPTS);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/crm/v3/objects/tickets/search');
    expectEveryDocumentedFieldOnTheWire(lastBody());
  });

  it.each([
    ['searchContacts', 'contacts'],
    ['searchCompanies', 'companies'],
    ['searchDeals', 'deals'],
    ['searchTickets', 'tickets'],
  ] as const)('%s(opts) puts every documented field on the wire', async (method, objectType) => {
    stubFetch();
    const client = makeClient();
    await client[method](FULL_OPTS);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain(`/crm/v3/objects/${objectType}/search`);
    expectEveryDocumentedFieldOnTheWire(lastBody());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Named regression — the paging cursor ADVANCES on the wire
// ═══════════════════════════════════════════════════════════════════════════

describe('paging `after` reaches the wire (2026-08-16 webhook-router#608 regression)', () => {
  it('a two-page walk sends page 1\'s paging.next.after in page 2\'s body', async () => {
    // Page 1 answers with a cursor; the walker feeds it back as `after`.
    stubFetch({ total: 250, results: [{ id: '1' }], paging: { next: { after: '100' } } });
    const client = makeClient();

    const page1 = await client.searchObjects('tasks', { filterGroups: FULL_OPTS.filterGroups, limit: 100 });
    const cursor = (page1 as { paging?: { next?: { after?: string } } }).paging?.next?.after;
    expect(cursor).toBe('100');

    await client.searchObjects('tasks', { filterGroups: FULL_OPTS.filterGroups, limit: 100, after: cursor });

    expect(captured).toHaveLength(2);
    // Page 1 must NOT carry a cursor; page 2 MUST carry exactly the one HubSpot returned.
    expect('after' in captured[0].body).toBe(false);
    expect(captured[1].body.after).toBe('100');
    // The two outbound bodies differ — a re-fetch of page 1 would make them identical,
    // which is precisely how the incident looked from the caller's side.
    expect(captured[1].body).not.toEqual(captured[0].body);
  });

  it('after: "0" and other falsy-looking cursors are still sent (only undefined is omitted)', async () => {
    stubFetch();
    await makeClient().searchObjects('tasks', { after: '0' });
    expect(lastBody().after).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Negative controls — the guard can tell "dropped" from "intentionally absent"
// ═══════════════════════════════════════════════════════════════════════════

describe('negative controls (Rule #322) — documented omissions stay omissions', () => {
  it('query: "" is intentionally omitted (HubSpot ignores filterGroups when query is present)', async () => {
    stubFetch();
    await makeClient().searchObjects('tickets', { ...FULL_OPTS, query: '' });
    const body = lastBody();
    expect('query' in body).toBe(false);
    // …and nothing else went missing with it.
    const rest = DOCUMENTED_FIELDS.filter((k) => k !== 'query');
    expect(rest.filter((k) => !(k in body))).toEqual([]);
  });

  it('undocumented keys are NOT passed through (the builder is enumerated by design)', async () => {
    stubFetch();
    const withBogus = { ...FULL_OPTS, bogus: 'nope' } as HubSpotSearchOpts & { bogus: string };
    await makeClient().searchObjects('tickets', withBogus);
    expect('bogus' in lastBody()).toBe(false);
  });

  it('omitting a field omits it on the wire (except limit/properties, which have documented defaults)', async () => {
    stubFetch();
    await makeClient().searchObjects('tickets', {});
    const body = lastBody();
    expect(body.limit).toBe(10);
    expect(Array.isArray(body.properties)).toBe(true);
    for (const k of ['query', 'filterGroups', 'sorts', 'after']) {
      expect(k in body, `"${k}" should be absent when the caller did not supply it`).toBe(false);
    }
  });
});
