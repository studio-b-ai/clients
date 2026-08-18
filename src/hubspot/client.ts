export interface HubSpotClientConfig {
  accessToken: string;
}

// Mirrors HubSpot CRM Search API filter structure
export interface HubSpotFilter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
  highValue?: string;
}

export interface HubSpotFilterGroup {
  filters: HubSpotFilter[];
}

export interface HubSpotSearchSort {
  propertyName: string;
  direction: 'ASCENDING' | 'DESCENDING';
}

export interface HubSpotSearchOpts {
  query?: string;
  filterGroups?: HubSpotFilterGroup[];
  properties?: string[];
  limit?: number;
  sorts?: HubSpotSearchSort[];
  after?: string;
}

// --- Outgoing email logging (Kevin 8/18, via the CTO seat — agent-sent business
// email is HubSpot-logged by construction) ---------------------------------
//
// Rule #438: association typeIds are DIRECTIONAL and in-code comments propagate
// inversions — these two are PINNED FROM A LIVE READ, never from memory or docs.
// Probed 2026-08-18 against the Studio B production HubSpot portal (49070660)
// via `railway run --service studiob-api -- node ...`:
//   GET /crm/v4/associations/emails/contacts/labels
//     -> [{ typeId: 198, label: null, category: "HUBSPOT_DEFINED" }]
//   GET /crm/v4/associations/emails/companies/labels
//     -> [{ typeId: 186, label: null, category: "HUBSPOT_DEFINED" }]
// The FROM side of a v4 association is the object carrying `associations` in
// its create body — here, the new email engagement (matches the endpoints
// above: emails -> contacts, emails -> companies, not the reverse).
/** HUBSPOT_DEFINED unlabeled association typeId: email (from) -> contact (to). Live-pinned 2026-08-18, portal 49070660. */
export const EMAIL_TO_CONTACT_TYPE_ID = 198;
/** HUBSPOT_DEFINED unlabeled association typeId: email (from) -> company (to). Live-pinned 2026-08-18, portal 49070660. */
export const EMAIL_TO_COMPANY_TYPE_ID = 186;

/**
 * Recipient domains that do NOT trigger outgoing-email CRM logging — Studio B /
 * Ästhetik / Heritage Fabrics internal mail. Callers may override via
 * `internalDomains` on the recipe functions. Matching is case-insensitive on
 * the address's domain part; plus-addresses (`kevin+test@asthetik.com`) count
 * by domain only — the local-part tag never affects classification.
 */
export const DEFAULT_INTERNAL_EMAIL_DOMAINS = [
  'heritagefabrics.com',
  'asthetik.com',
  'b.studio',
  'bibelhausen.com',
];

export interface LogOutgoingEmailInput {
  fromEmail: string;
  to: string[];
  cc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  sentAt?: Date;
  ownerId?: string | null;
  contactIds: string[];
  companyIds?: string[];
}

/**
 * Minimal HTML -> plain-text fallback for `hs_email_text` when a caller only
 * has an HTML body. Not a general-purpose renderer — good enough for a CRM
 * activity-feed preview, which is the only consumer.
 */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class HubSpotClient {
  private config: HubSpotClientConfig;
  private apiBase = 'https://api.hubapi.com';

  constructor(config: HubSpotClientConfig) {
    this.config = config;
  }

  private async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HubSpot ${method} ${path}: ${res.status} ${errText.slice(0, 300)}`);
    }
    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  /**
   * Build a clean search body for the HubSpot CRM Search API.
   * Only includes keys that have a defined value so that HubSpot doesn't
   * misinterpret an explicit `undefined` / `null` as an empty filter set.
   */
  private buildSearchBody(opts: HubSpotSearchOpts, defaultProperties: string[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      limit: opts.limit ?? 10,
      properties: opts.properties ?? defaultProperties,
    };

    // Include only when provided — a missing filterGroups key means "no filter"
    // (returns all results), which is the correct HubSpot default behaviour.
    if (opts.filterGroups !== undefined) {
      // Ensure all filter values are strings as required by the HubSpot API
      body.filterGroups = opts.filterGroups.map((group) => ({
        filters: group.filters.map((f) => ({
          ...f,
          ...(f.value !== undefined ? { value: String(f.value) } : {}),
          ...(f.values !== undefined ? { values: f.values.map(String) } : {}),
          ...(f.highValue !== undefined ? { highValue: String(f.highValue) } : {}),
        })),
      }));
    }

    // Only include query when it has a non-empty value.
    // HubSpot silently ignores filterGroups whenever query is present in the
    // body — even as an empty string.  Omitting the key is the safe default.
    if (opts.query !== undefined && opts.query.trim() !== '') body.query = opts.query;
    if (opts.sorts !== undefined) body.sorts = opts.sorts;
    if (opts.after !== undefined) body.after = opts.after;

    return body;
  }

  // Contacts
  async searchContacts(opts: HubSpotSearchOpts) {
    const body = this.buildSearchBody(opts, ['email', 'firstname', 'lastname', 'phone', 'company']);
    return this.fetch<any>('POST', '/crm/v3/objects/contacts/search', body);
  }

  async getContact(contactId: string, properties?: string[]) {
    const props = (properties ?? ['email', 'firstname', 'lastname', 'phone', 'company']).join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/contacts/${contactId}?properties=${props}`);
  }

  async createContact(properties: Record<string, string>) {
    return this.fetch<any>('POST', '/crm/v3/objects/contacts', { properties });
  }

  async updateContact(contactId: string, properties: Record<string, string>) {
    return this.fetch<any>('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties });
  }

  // Companies
  async searchCompanies(opts: HubSpotSearchOpts) {
    const body = this.buildSearchBody(opts, ['name', 'domain', 'industry', 'numberofemployees']);
    return this.fetch<any>('POST', '/crm/v3/objects/companies/search', body);
  }

  async getCompany(companyId: string, properties?: string[]) {
    const props = (properties ?? ['name', 'domain', 'industry', 'numberofemployees']).join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/companies/${companyId}?properties=${props}`);
  }

  // Deals
  async searchDeals(opts: HubSpotSearchOpts) {
    const body = this.buildSearchBody(opts, ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate']);
    return this.fetch<any>('POST', '/crm/v3/objects/deals/search', body);
  }

  async getDeal(dealId: string, properties?: string[]) {
    const props = (properties ?? ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate']).join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/deals/${dealId}?properties=${props}`);
  }

  // Tickets
  async searchTickets(opts: HubSpotSearchOpts) {
    const body = this.buildSearchBody(opts, ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority']);
    return this.fetch<any>('POST', '/crm/v3/objects/tickets/search', body);
  }

  async getTicket(ticketId: string, properties?: string[]) {
    const props = (properties ?? ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'createdate']).join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/tickets/${ticketId}?properties=${props}`);
  }

  async updateTicket(ticketId: string, properties: Record<string, string>) {
    return this.fetch<any>('PATCH', `/crm/v3/objects/tickets/${ticketId}`, { properties });
  }

  async addNote(objectType: string, objectId: string, body: string) {
    const note = await this.fetch<{ id: string }>('POST', '/crm/v3/objects/notes', {
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() },
    });
    await this.fetch<void>('PUT', `/crm/v4/objects/notes/${note.id}/associations/${objectType}/${objectId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: objectType === 'tickets' ? 18 : 202 }]
    );
    return note;
  }

  // Pipelines
  async listPipelines(objectType: string) {
    return this.fetch<any>('GET', `/crm/v3/pipelines/${objectType}`);
  }

  // Generic CRM search — the primary fix target
  async searchObjects(objectType: string, opts: HubSpotSearchOpts) {
    // Filter passthrough is guarded by __tests__/search-body-completeness.test.ts
    // (every HubSpotSearchOpts field survives buildSearchBody) — the former
    // always-on console.debug of the full body is gone: it bypassed consumers'
    // structured loggers and printed a multi-line JSON blob to stdout on EVERY
    // generic search (webhook-router runs one per upsert lookup).
    const body = this.buildSearchBody(opts, []);
    return this.fetch<any>('POST', `/crm/v3/objects/${objectType}/search`, body);
  }

  async getObject(objectType: string, objectId: string, properties?: string[]) {
    const props = properties?.join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/${objectType}/${objectId}${props ? `?properties=${props}` : ''}`);
  }

  async createObject(objectType: string, properties: Record<string, string>) {
    return this.fetch<any>('POST', `/crm/v3/objects/${objectType}`, { properties });
  }

  async updateObject(objectType: string, objectId: string, properties: Record<string, string>) {
    return this.fetch<any>('PATCH', `/crm/v3/objects/${objectType}/${objectId}`, { properties });
  }

  // --- Outgoing email logging --------------------------------------------

  /** Find a contact by exact email match. Returns the first hit or null. */
  async findContactByEmail(email: string): Promise<{ id: string } | null> {
    const result = await this.searchContacts({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'],
      limit: 1,
    });
    const hit = result.results?.[0];
    return hit ? { id: hit.id } : null;
  }

  /**
   * Find a contact by email, or create a capture-class contact — email ONLY,
   * no guessed names (per the 8/04 CRM-write-plane ratification).
   */
  async ensureContactByEmail(email: string): Promise<{ id: string; created: boolean }> {
    const existing = await this.findContactByEmail(email);
    if (existing) return { id: existing.id, created: false };
    const created = await this.createContact({ email });
    return { id: created.id, created: true };
  }

  /**
   * The first company associated with a contact, if any. A 404 (no
   * associations for this contact) resolves to null rather than throwing —
   * this bypasses the private `fetch()` wrapper to read the real HTTP status
   * directly instead of pattern-matching it out of a stringified error.
   */
  async getPrimaryCompanyIdForContact(contactId: string): Promise<string | null> {
    const path = `/crm/v4/objects/contacts/${contactId}/associations/companies`;
    const res = await fetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HubSpot GET ${path}: ${res.status} ${errText.slice(0, 300)}`);
    }
    const body = (await res.json()) as { results?: Array<{ toObjectId: string | number }> };
    const first = body.results?.[0];
    return first ? String(first.toObjectId) : null;
  }

  /** Look up an owner by email. Returns null on no match (never throws on a miss). */
  async getOwnerIdByEmail(email: string): Promise<string | null> {
    const result = await this.fetch<{ results?: Array<{ id: string }> }>(
      'GET',
      `/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`,
    );
    return result.results?.[0]?.id ?? null;
  }

  /**
   * Log an outgoing email as a `emails` CRM engagement, associated to the
   * given contacts (required) and companies (optional) in one atomic create —
   * the inline `associations` array on the CREATE body, not a follow-up PUT
   * (contrast `addNote()` above, which associates via a second call because
   * notes were added before this pattern existed).
   *
   * Property values (`hs_email_direction: 'EMAIL'`, `hs_email_status: 'SENT'`)
   * and the `hs_email_headers` JSON shape are pinned from HubSpot's canonical
   * developer docs (Rule #50 fallback) — the live schema read
   * (`GET /crm/v3/properties/emails`) 403s for the studiob-api token with
   * `requires one of [connected-email-data-access]` (portal 49070660, probed
   * 2026-08-18); see the PR body for the full probe transcript. The
   * association typeIds above ARE live-pinned — this method's directional
   * risk (Rule #438) is fully covered even though the property-schema probe
   * was permission-gated.
   */
  async logOutgoingEmail(input: LogOutgoingEmailInput): Promise<{ id: string }> {
    if (input.contactIds.length === 0) {
      throw new Error(
        'HubSpotClient.logOutgoingEmail: contactIds must not be empty — resolve the recipient ' +
          'contact(s) before logging (an engagement with no contact is unfindable).',
      );
    }

    const timestamp = (input.sentAt ?? new Date()).toISOString();
    const text = input.textBody ?? (input.htmlBody ? stripHtmlToText(input.htmlBody) : '');

    const properties: Record<string, string> = {
      hs_timestamp: timestamp,
      hs_email_direction: 'EMAIL',
      hs_email_status: 'SENT',
      hs_email_subject: input.subject,
      hs_email_text: text,
      hs_email_headers: JSON.stringify({
        from: { email: input.fromEmail },
        to: input.to.map((email) => ({ email })),
        cc: (input.cc ?? []).map((email) => ({ email })),
      }),
    };
    if (input.htmlBody !== undefined) properties.hs_email_html = input.htmlBody;
    if (input.ownerId) properties.hubspot_owner_id = input.ownerId;

    const companyIds = input.companyIds ?? [];
    const associations = [
      ...input.contactIds.map((id) => ({
        to: { id },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: EMAIL_TO_CONTACT_TYPE_ID }],
      })),
      ...companyIds.map((id) => ({
        to: { id },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: EMAIL_TO_COMPANY_TYPE_ID }],
      })),
    ];

    return this.fetch<{ id: string }>('POST', '/crm/v3/objects/emails', { properties, associations });
  }
}
