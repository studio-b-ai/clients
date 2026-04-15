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

    if (opts.query !== undefined) body.query = opts.query;
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
    const body = this.buildSearchBody(opts, []);

    // Debug logging: always log outbound body so filter passthrough can be verified
    console.debug(
      `[HubSpot] POST /crm/v3/objects/${objectType}/search`,
      JSON.stringify(body, null, 2)
    );

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
}
