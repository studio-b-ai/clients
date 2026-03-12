export interface HubSpotClientConfig {
  accessToken: string;
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

  // Contacts
  async searchContacts(opts: { query?: string; filterGroups?: any[]; properties?: string[]; limit?: number }) {
    return this.fetch<any>('POST', '/crm/v3/objects/contacts/search', {
      query: opts.query, filterGroups: opts.filterGroups,
      properties: opts.properties ?? ['email', 'firstname', 'lastname', 'phone', 'company'],
      limit: opts.limit ?? 10,
    });
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
  async searchCompanies(opts: { query?: string; filterGroups?: any[]; properties?: string[]; limit?: number }) {
    return this.fetch<any>('POST', '/crm/v3/objects/companies/search', {
      query: opts.query, filterGroups: opts.filterGroups,
      properties: opts.properties ?? ['name', 'domain', 'industry', 'numberofemployees'],
      limit: opts.limit ?? 10,
    });
  }

  async getCompany(companyId: string, properties?: string[]) {
    const props = (properties ?? ['name', 'domain', 'industry', 'numberofemployees']).join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/companies/${companyId}?properties=${props}`);
  }

  // Deals
  async searchDeals(opts: { query?: string; filterGroups?: any[]; properties?: string[]; limit?: number }) {
    return this.fetch<any>('POST', '/crm/v3/objects/deals/search', {
      query: opts.query, filterGroups: opts.filterGroups,
      properties: opts.properties ?? ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate'],
      limit: opts.limit ?? 10,
    });
  }

  async getDeal(dealId: string, properties?: string[]) {
    const props = (properties ?? ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate']).join(',');
    return this.fetch<any>('GET', `/crm/v3/objects/deals/${dealId}?properties=${props}`);
  }

  // Tickets
  async searchTickets(opts: { query?: string; filterGroups?: any[]; properties?: string[]; limit?: number }) {
    return this.fetch<any>('POST', '/crm/v3/objects/tickets/search', {
      query: opts.query, filterGroups: opts.filterGroups,
      properties: opts.properties ?? ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority'],
      limit: opts.limit ?? 10,
    });
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

  // Generic CRM search
  async searchObjects(objectType: string, opts: { query?: string; filterGroups?: any[]; properties?: string[]; limit?: number; sorts?: any[] }) {
    return this.fetch<any>('POST', `/crm/v3/objects/${objectType}/search`, {
      query: opts.query, filterGroups: opts.filterGroups,
      properties: opts.properties, limit: opts.limit ?? 10, sorts: opts.sorts,
    });
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
