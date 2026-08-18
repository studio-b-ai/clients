/**
 * Wire-format tests for outgoing-email CRM logging (Rule #223 — import and CALL
 * the real methods/recipes; capture what `fetch` was actually sent; never
 * hand-assemble the payload in the test).
 *
 * Covers HubSpotClient.{findContactByEmail, ensureContactByEmail,
 * getPrimaryCompanyIdForContact, getOwnerIdByEmail, logOutgoingEmail} and the
 * recipes.ts composite (resolveOutgoingEmailRecipients / recordOutgoingEmail /
 * logOutgoingEmailToCrm).
 *
 * Part of chip-hubspot-email-log PR-A — Kevin 8/18, via the CTO seat.
 *
 * Run: npx vitest run src/hubspot/__tests__/outgoing-email-log
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubSpotClient, EMAIL_TO_CONTACT_TYPE_ID, EMAIL_TO_COMPANY_TYPE_ID, DEFAULT_INTERNAL_EMAIL_DOMAINS } from '../client.js';
import {
  resolveOutgoingEmailRecipients,
  recordOutgoingEmail,
  logOutgoingEmailToCrm,
  HubSpotEmailLogError,
  type ResolvedOutgoingEmailRecipients,
} from '../recipes.js';

// ─── Routed fetch spy ───────────────────────────────────────────────────────
//
// A single test can touch several distinct HubSpot endpoints in one call
// (search -> create -> associations -> owners -> emails), so this spy routes
// by URL/method to a per-test list of handlers rather than a single canned
// response. Every call is still captured verbatim for wire-format assertions.

interface Captured {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

type RouteHandler = (url: string, method: string, body: unknown) => { status: number; body: unknown } | undefined;

let captured: Captured[] = [];
let routes: RouteHandler[] = [];

function stubRoutedFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      captured.push({ method, url, body });
      for (const route of routes) {
        const result = route(url, method, body);
        if (result) {
          return new Response(JSON.stringify(result.body), {
            status: result.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      throw new Error(`No route stubbed for ${method} ${url}`);
    }),
  );
}

function addRoute(handler: RouteHandler) {
  routes.push(handler);
}

function lastCall(): Captured {
  return captured[captured.length - 1];
}

beforeEach(() => {
  captured = [];
  routes = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeClient(token = 'test-token') {
  return new HubSpotClient({ accessToken: token });
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT_INTERNAL_EMAIL_DOMAINS
// ═══════════════════════════════════════════════════════════════════════════

describe('DEFAULT_INTERNAL_EMAIL_DOMAINS', () => {
  it('is exactly the four Studio B / Ästhetik / Heritage Fabrics domains', () => {
    expect(DEFAULT_INTERNAL_EMAIL_DOMAINS).toEqual([
      'heritagefabrics.com',
      'asthetik.com',
      'b.studio',
      'bibelhausen.com',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HubSpotClient.findContactByEmail
// ═══════════════════════════════════════════════════════════════════════════

describe('findContactByEmail', () => {
  it('searches with an EQ filter on email, limit 1, properties [email], and returns the first hit', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) {
        return { status: 200, body: { total: 1, results: [{ id: 'c-1', properties: { email: 'jane@example.com' } }] } };
      }
      return undefined;
    });

    const result = await makeClient().findContactByEmail('jane@example.com');

    expect(captured).toHaveLength(1);
    expect(lastCall().url).toContain('/crm/v3/objects/contacts/search');
    expect(lastCall().body).toEqual({
      limit: 1,
      properties: ['email'],
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'jane@example.com' }] }],
    });
    expect(result).toEqual({ id: 'c-1' });
  });

  it('returns null when no contact matches', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) {
        return { status: 200, body: { total: 0, results: [] } };
      }
      return undefined;
    });

    const result = await makeClient().findContactByEmail('nobody@example.com');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HubSpotClient.ensureContactByEmail
// ═══════════════════════════════════════════════════════════════════════════

describe('ensureContactByEmail', () => {
  it('creates a capture-class contact ({email} only) when the search returns 0', async () => {
    stubRoutedFetch();
    let createBody: unknown;
    addRoute((url, method, body) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) {
        return { status: 200, body: { total: 0, results: [] } };
      }
      if (method === 'POST' && url.endsWith('/crm/v3/objects/contacts')) {
        createBody = body;
        return { status: 201, body: { id: 'new-contact-1' } };
      }
      return undefined;
    });

    const result = await makeClient().ensureContactByEmail('new@example.com');

    expect(result).toEqual({ id: 'new-contact-1', created: true });
    expect(createBody).toEqual({ properties: { email: 'new@example.com' } });
  });

  it('does NOT create when a contact already exists (search returns 1)', async () => {
    stubRoutedFetch();
    let createCalled = false;
    addRoute((url, method) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) {
        return { status: 200, body: { total: 1, results: [{ id: 'existing-1' }] } };
      }
      if (method === 'POST' && url.endsWith('/crm/v3/objects/contacts')) {
        createCalled = true;
        return { status: 201, body: { id: 'should-not-happen' } };
      }
      return undefined;
    });

    const result = await makeClient().ensureContactByEmail('existing@example.com');

    expect(result).toEqual({ id: 'existing-1', created: false });
    expect(createCalled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HubSpotClient.getPrimaryCompanyIdForContact
// ═══════════════════════════════════════════════════════════════════════════

describe('getPrimaryCompanyIdForContact', () => {
  it('returns the first toObjectId (stringified) from the associations response', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/crm/v4/objects/contacts/c-1/associations/companies')) {
        return { status: 200, body: { results: [{ toObjectId: 999, associationTypes: [] }] } };
      }
      return undefined;
    });

    const result = await makeClient().getPrimaryCompanyIdForContact('c-1');
    expect(result).toBe('999');
  });

  it('returns null on a 404 (no associations) without throwing', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/crm/v4/objects/contacts/c-2/associations/companies')) {
        return { status: 404, body: { message: 'not found' } };
      }
      return undefined;
    });

    await expect(makeClient().getPrimaryCompanyIdForContact('c-2')).resolves.toBeNull();
  });

  it('returns null on an empty result list (never throws on an empty list)', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/crm/v4/objects/contacts/c-3/associations/companies')) {
        return { status: 200, body: { results: [] } };
      }
      return undefined;
    });

    await expect(makeClient().getPrimaryCompanyIdForContact('c-3')).resolves.toBeNull();
  });

  it('throws (naming the status) on a non-404 error', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/crm/v4/objects/contacts/c-4/associations/companies')) {
        return { status: 500, body: { message: 'server error' } };
      }
      return undefined;
    });

    await expect(makeClient().getPrimaryCompanyIdForContact('c-4')).rejects.toThrow(/500/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HubSpotClient.getOwnerIdByEmail
// ═══════════════════════════════════════════════════════════════════════════

describe('getOwnerIdByEmail', () => {
  it('returns the id of the first matching owner', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/crm/v3/owners')) {
        return { status: 200, body: { results: [{ id: 'owner-1', email: 'kevin@heritagefabrics.com' }] } };
      }
      return undefined;
    });

    const result = await makeClient().getOwnerIdByEmail('kevin@heritagefabrics.com');
    expect(result).toBe('owner-1');
    expect(lastCall().url).toContain('/crm/v3/owners?email=kevin%40heritagefabrics.com&limit=1');
  });

  it('returns null when no owner matches (never throws on a miss)', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/crm/v3/owners')) {
        return { status: 200, body: { results: [] } };
      }
      return undefined;
    });

    const result = await makeClient().getOwnerIdByEmail('nobody@example.com');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HubSpotClient.logOutgoingEmail
// ═══════════════════════════════════════════════════════════════════════════

describe('logOutgoingEmail', () => {
  it('throws before any fetch when contactIds is empty', async () => {
    stubRoutedFetch();
    const client = makeClient();

    await expect(
      client.logOutgoingEmail({
        fromEmail: 'agent@heritagefabrics.com',
        to: ['someone@example.com'],
        subject: 'Test',
        contactIds: [],
      }),
    ).rejects.toThrow(/contactIds must not be empty/);

    expect(captured).toHaveLength(0);
  });

  it('POSTs /crm/v3/objects/emails with direction EMAIL, status SENT, headers round-tripping from/to/cc, and inline associations carrying the pinned typeIds for every contactId + companyId', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/emails')) {
        return { status: 201, body: { id: 'email-engagement-1' } };
      }
      return undefined;
    });

    const sentAt = new Date('2026-08-18T12:00:00.000Z');
    const result = await makeClient().logOutgoingEmail({
      fromEmail: 'agent@heritagefabrics.com',
      to: ['jane@acme.com'],
      cc: ['bob@acme.com'],
      subject: "Let's talk",
      textBody: 'Thanks for your email',
      sentAt,
      ownerId: 'owner-42',
      contactIds: ['contact-1', 'contact-2'],
      companyIds: ['company-9'],
    });

    expect(result).toEqual({ id: 'email-engagement-1' });
    expect(captured).toHaveLength(1);
    expect(lastCall().url).toContain('/crm/v3/objects/emails');

    const body = lastCall().body as any;
    expect(body.properties.hs_timestamp).toBe('2026-08-18T12:00:00.000Z');
    expect(body.properties.hs_email_direction).toBe('EMAIL');
    expect(body.properties.hs_email_status).toBe('SENT');
    expect(body.properties.hs_email_subject).toBe("Let's talk");
    expect(body.properties.hs_email_text).toBe('Thanks for your email');
    expect(body.properties.hubspot_owner_id).toBe('owner-42');
    expect(JSON.parse(body.properties.hs_email_headers)).toEqual({
      from: { email: 'agent@heritagefabrics.com' },
      to: [{ email: 'jane@acme.com' }],
      cc: [{ email: 'bob@acme.com' }],
    });

    expect(body.associations).toEqual([
      { to: { id: 'contact-1' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: EMAIL_TO_CONTACT_TYPE_ID }] },
      { to: { id: 'contact-2' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: EMAIL_TO_CONTACT_TYPE_ID }] },
      { to: { id: 'company-9' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: EMAIL_TO_COMPANY_TYPE_ID }] },
    ]);
  });

  it('omits hubspot_owner_id when ownerId is not given', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/emails') ? { status: 201, body: { id: 'e-2' } } : undefined));

    await makeClient().logOutgoingEmail({
      fromEmail: 'agent@heritagefabrics.com',
      to: ['jane@acme.com'],
      subject: 'No owner',
      contactIds: ['contact-1'],
    });

    const body = lastCall().body as any;
    expect('hubspot_owner_id' in body.properties).toBe(false);
  });

  it('omits hubspot_owner_id when ownerId is explicitly null', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/emails') ? { status: 201, body: { id: 'e-3' } } : undefined));

    await makeClient().logOutgoingEmail({
      fromEmail: 'agent@heritagefabrics.com',
      to: ['jane@acme.com'],
      subject: 'Null owner',
      ownerId: null,
      contactIds: ['contact-1'],
    });

    const body = lastCall().body as any;
    expect('hubspot_owner_id' in body.properties).toBe(false);
  });

  it('includes hs_email_html only when htmlBody is given, deriving hs_email_text from a stripped fallback when textBody is absent', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/emails') ? { status: 201, body: { id: 'e-4' } } : undefined));

    await makeClient().logOutgoingEmail({
      fromEmail: 'agent@heritagefabrics.com',
      to: ['jane@acme.com'],
      subject: 'HTML only',
      htmlBody: '<p>Hello <strong>Jane</strong></p>',
      contactIds: ['contact-1'],
    });

    const body = lastCall().body as any;
    expect(body.properties.hs_email_html).toBe('<p>Hello <strong>Jane</strong></p>');
    expect(body.properties.hs_email_text).toBe('Hello Jane');
  });

  it('omits hs_email_html when no htmlBody is given', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/emails') ? { status: 201, body: { id: 'e-5' } } : undefined));

    await makeClient().logOutgoingEmail({
      fromEmail: 'agent@heritagefabrics.com',
      to: ['jane@acme.com'],
      subject: 'Text only',
      textBody: 'Plain text body',
      contactIds: ['contact-1'],
    });

    const body = lastCall().body as any;
    expect('hs_email_html' in body.properties).toBe(false);
  });

  it('associations array carries only contact entries when companyIds is omitted', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/emails') ? { status: 201, body: { id: 'e-6' } } : undefined));

    await makeClient().logOutgoingEmail({
      fromEmail: 'agent@heritagefabrics.com',
      to: ['jane@acme.com'],
      subject: 'No companies',
      contactIds: ['contact-1'],
    });

    const body = lastCall().body as any;
    expect(body.associations).toEqual([
      { to: { id: 'contact-1' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: EMAIL_TO_CONTACT_TYPE_ID }] },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveOutgoingEmailRecipients (Phase 1 — BEFORE send)
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveOutgoingEmailRecipients', () => {
  it('returns {skipped:"all-internal"} and makes ZERO fetch calls when every recipient is internal (mixed case, plus-address)', async () => {
    stubRoutedFetch();

    const result = await resolveOutgoingEmailRecipients(makeClient(), {
      to: ['Kevin@HeritageFabrics.com', 'kevin+test@asthetik.com'],
      cc: ['someone@B.Studio'],
    });

    expect(result).toEqual({ skipped: 'all-internal' });
    expect(captured).toHaveLength(0);
  });

  it('resolves only the external recipients from a mixed to/cc list, deduped + lowercased', async () => {
    stubRoutedFetch();
    const searchedEmails: string[] = [];
    addRoute((url, method, body) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) {
        const value = (body as any).filterGroups[0].filters[0].value as string;
        searchedEmails.push(value);
        return { status: 200, body: { total: 0, results: [] } };
      }
      if (method === 'POST' && url.endsWith('/crm/v3/objects/contacts')) {
        return { status: 201, body: { id: `contact-for-${(body as any).properties.email}` } };
      }
      return undefined;
    });

    const result = await resolveOutgoingEmailRecipients(makeClient(), {
      // 'External@Example.com' (to) and 'external@example.com' (cc) collapse to one
      // after lowercase-dedupe; 'kevin@heritagefabrics.com' is internal by default.
      to: ['External@Example.com', 'kevin@heritagefabrics.com'],
      cc: ['external@example.com'],
    });

    expect(result.skipped).toBeUndefined();
    expect((result as any).external).toEqual(['external@example.com']);
    expect((result as any).contacts).toEqual([{ email: 'external@example.com', id: 'contact-for-external@example.com', created: true }]);
    expect(searchedEmails).toEqual(['external@example.com']);
  });

  it('throws HubSpotEmailLogError{stage:"resolve"} and makes no /crm/v3/objects/emails POST when contact resolution fails', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/contacts/search') ? { status: 500, body: { message: 'server error' } } : undefined));

    let caught: unknown;
    try {
      await resolveOutgoingEmailRecipients(makeClient(), { to: ['external@example.com'] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HubSpotEmailLogError);
    expect((caught as HubSpotEmailLogError).stage).toBe('resolve');
    expect(captured.some((c) => c.url.includes('/crm/v3/objects/emails'))).toBe(false);
  });

  it('honors a caller-supplied internalDomains override (a normally-internal domain becomes external)', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/contacts/search') ? { status: 200, body: { total: 1, results: [{ id: 'contact-hf' }] } } : undefined));

    const result = await resolveOutgoingEmailRecipients(makeClient(), {
      to: ['someone@heritagefabrics.com'],
      internalDomains: ['onlythisdomain.com'],
    });

    expect((result as any).external).toEqual(['someone@heritagefabrics.com']);
  });

  it('honors a caller-supplied internalDomains override the other direction (a domain outside the default list is skipped)', async () => {
    stubRoutedFetch();

    const result = await resolveOutgoingEmailRecipients(makeClient(), {
      to: ['someone@onlythisdomain.com'],
      internalDomains: ['onlythisdomain.com'],
    });

    expect(result).toEqual({ skipped: 'all-internal' });
    expect(captured).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// recordOutgoingEmail (Phase 2 — AFTER send)
// ═══════════════════════════════════════════════════════════════════════════

describe('recordOutgoingEmail', () => {
  it('passes an {skipped:"all-internal"} resolved straight through with zero HubSpot calls', async () => {
    stubRoutedFetch();

    const result = await recordOutgoingEmail(makeClient(), { skipped: 'all-internal' }, { fromEmail: 'agent@heritagefabrics.com', subject: 'Should not be logged' });

    expect(result).toEqual({ skipped: 'all-internal' });
    expect(captured).toHaveLength(0);
  });

  it('creates the engagement with company/owner enrichment and returns the full result shape', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/associations/companies')) return { status: 200, body: { results: [{ toObjectId: 555 }] } };
      if (method === 'GET' && url.includes('/crm/v3/owners')) return { status: 200, body: { results: [{ id: 'owner-9' }] } };
      if (method === 'POST' && url.includes('/crm/v3/objects/emails')) return { status: 201, body: { id: 'engagement-77' } };
      return undefined;
    });

    const resolved: ResolvedOutgoingEmailRecipients = {
      external: ['ext@example.com'],
      contacts: [{ email: 'ext@example.com', id: 'contact-1', created: true }],
    };

    const result = await recordOutgoingEmail(makeClient(), resolved, {
      fromEmail: 'agent@heritagefabrics.com',
      subject: 'Hi',
      textBody: 'Body',
    });

    expect(result).toEqual({
      engagementId: 'engagement-77',
      contactIds: ['contact-1'],
      createdContactIds: ['contact-1'],
      companyIds: ['555'],
      ownerId: 'owner-9',
    });
  });

  it('is best-effort on company/owner lookup failures — the engagement is still created', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/associations/companies')) return { status: 500, body: { message: 'boom' } };
      if (method === 'GET' && url.includes('/crm/v3/owners')) return { status: 500, body: { message: 'boom' } };
      if (method === 'POST' && url.includes('/crm/v3/objects/emails')) return { status: 201, body: { id: 'engagement-88' } };
      return undefined;
    });

    const resolved: ResolvedOutgoingEmailRecipients = {
      external: ['ext@example.com'],
      contacts: [{ email: 'ext@example.com', id: 'contact-1', created: false }],
    };

    const result = await recordOutgoingEmail(makeClient(), resolved, { fromEmail: 'agent@heritagefabrics.com', subject: 'Hi', textBody: 'Body' });

    expect(result).toMatchObject({ engagementId: 'engagement-88', companyIds: [], ownerId: null });
  });

  it('throws HubSpotEmailLogError{stage:"record", contactIds} when the engagement POST fails (email already sent)', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'GET' && url.includes('/associations/companies')) return { status: 404, body: {} };
      if (method === 'GET' && url.includes('/crm/v3/owners')) return { status: 200, body: { results: [] } };
      if (method === 'POST' && url.includes('/crm/v3/objects/emails')) return { status: 400, body: { message: 'bad request' } };
      return undefined;
    });

    const resolved: ResolvedOutgoingEmailRecipients = {
      external: ['ext@example.com'],
      contacts: [{ email: 'ext@example.com', id: 'contact-1', created: true }],
    };

    let caught: unknown;
    try {
      await recordOutgoingEmail(makeClient(), resolved, { fromEmail: 'agent@heritagefabrics.com', subject: 'Hi' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HubSpotEmailLogError);
    const typed = caught as HubSpotEmailLogError;
    expect(typed.stage).toBe('record');
    expect(typed.contactIds).toEqual(['contact-1']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// logOutgoingEmailToCrm (composed)
// ═══════════════════════════════════════════════════════════════════════════

describe('logOutgoingEmailToCrm', () => {
  it('returns {skipped:"all-internal"} and makes ZERO fetch calls for an all-internal composed call (mixed case, plus-address)', async () => {
    stubRoutedFetch();

    const result = await logOutgoingEmailToCrm(makeClient(), {
      fromEmail: 'agent@heritagefabrics.com',
      to: ['Kevin@HeritageFabrics.com'],
      cc: ['kevin+ops@Asthetik.com'],
      subject: 'Internal only',
    });

    expect(result).toEqual({ skipped: 'all-internal' });
    expect(captured).toHaveLength(0);
  });

  it('composes resolve + record for a mixed internal/external recipient list — logs ONLY the external ones', async () => {
    stubRoutedFetch();
    addRoute((url, method) => {
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) return { status: 200, body: { total: 1, results: [{ id: 'contact-1' }] } };
      if (method === 'GET' && url.includes('/associations/companies')) return { status: 404, body: {} };
      if (method === 'GET' && url.includes('/crm/v3/owners')) return { status: 200, body: { results: [] } };
      if (method === 'POST' && url.includes('/crm/v3/objects/emails')) return { status: 201, body: { id: 'engagement-1' } };
      return undefined;
    });

    const result = await logOutgoingEmailToCrm(makeClient(), {
      fromEmail: 'agent@heritagefabrics.com',
      to: ['kevin@heritagefabrics.com', 'external@example.com'],
      subject: 'Hi',
      textBody: 'Body',
    });

    expect(result).toMatchObject({ engagementId: 'engagement-1', contactIds: ['contact-1'] });
    // The internal recipient never triggered a contact search/create for
    // itself — exactly one search call, for the one external recipient.
    const searchCalls = captured.filter((c) => c.url.includes('/contacts/search'));
    expect(searchCalls).toHaveLength(1);
  });

  it('(via the composed entrypoint) throws HubSpotEmailLogError{stage:"resolve"} and never POSTs /crm/v3/objects/emails when contact resolution fails', async () => {
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/contacts/search') ? { status: 500, body: { message: 'server error' } } : undefined));

    let caught: unknown;
    try {
      await logOutgoingEmailToCrm(makeClient(), { fromEmail: 'agent@heritagefabrics.com', to: ['external@example.com'], subject: 'Hi' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HubSpotEmailLogError);
    expect((caught as HubSpotEmailLogError).stage).toBe('resolve');
    expect(captured.some((c) => c.url.includes('/crm/v3/objects/emails'))).toBe(false);
  });

  it('never leaks the access token into a thrown error message', async () => {
    const distinctiveToken = 'pat-na1-DO-NOT-LEAK-THIS-TOKEN-VALUE-12345';
    stubRoutedFetch();
    addRoute((url, method) => (method === 'POST' && url.includes('/crm/v3/objects/contacts/search') ? { status: 500, body: { message: 'internal server error' } } : undefined));

    let caught: unknown;
    try {
      await logOutgoingEmailToCrm(makeClient(distinctiveToken), {
        fromEmail: 'agent@heritagefabrics.com',
        to: ['external@example.com'],
        subject: 'Hi',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HubSpotEmailLogError);
    const message = (caught as Error).message;
    expect(message).not.toContain(distinctiveToken);
    expect((caught as Error).stack ?? '').not.toContain(distinctiveToken);
  });
});
