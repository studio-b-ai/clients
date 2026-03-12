export interface GoDaddyClientConfig {
  apiKey: string;
  apiSecret: string;
  env?: 'production' | 'ote';
}

export class GoDaddyClient {
  private config: GoDaddyClientConfig;

  constructor(config: GoDaddyClientConfig) {
    this.config = config;
  }

  private baseUrl(): string {
    return this.config.env === 'ote'
      ? 'https://api.ote-godaddy.com'
      : 'https://api.godaddy.com';
  }

  private async fetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl()}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `sso-key ${this.config.apiKey}:${this.config.apiSecret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...opts.headers,
      },
    });
    if (!res.ok) {
      let errMsg: string;
      try {
        const err = await res.json() as { code: string; message: string; fields?: Array<{ path: string; message: string }> };
        errMsg = `GoDaddy ${res.status} [${err.code}]: ${err.message}`;
        if (err.fields?.length) errMsg += '\nField errors: ' + err.fields.map(f => `${f.path}: ${f.message}`).join(', ');
      } catch { errMsg = `GoDaddy ${res.status}: ${await res.text()}`; }
      throw new Error(errMsg);
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // Domains
  async listDomains(opts?: { statuses?: string[]; limit?: number; marker?: string }) {
    const params = new URLSearchParams();
    if (opts?.statuses?.length) params.set('statuses', opts.statuses.join(','));
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.marker) params.set('marker', opts.marker);
    const q = params.toString();
    return this.fetch<any[]>(`/v1/domains${q ? `?${q}` : ''}`);
  }

  async getDomain(domain: string) {
    return this.fetch<any>(`/v1/domains/${encodeURIComponent(domain)}`);
  }

  async updateDomain(domain: string, settings: { locked?: boolean; nameServers?: string[]; renewAuto?: boolean }) {
    await this.fetch<void>(`/v1/domains/${encodeURIComponent(domain)}`, { method: 'PATCH', body: JSON.stringify(settings) });
  }

  async purchaseDomain(body: { domain: string; consent: { agreedAt: string; agreedBy: string; agreementKeys: string[] }; nameServers?: string[]; period?: number; privacy?: boolean; renewAuto?: boolean }) {
    return this.fetch<any>(`/v1/domains/purchase`, { method: 'POST', body: JSON.stringify(body) });
  }

  async renewDomain(domain: string, period?: number) {
    return this.fetch<any>(`/v1/domains/${encodeURIComponent(domain)}/renew`, { method: 'POST', body: JSON.stringify({ period: period ?? 1 }) });
  }

  async cancelDomain(domain: string) {
    await this.fetch<void>(`/v1/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' });
  }

  // DNS
  async listDnsRecords(domain: string, opts?: { type?: string; name?: string; offset?: number; limit?: number }) {
    let path = `/v1/domains/${encodeURIComponent(domain)}/records`;
    if (opts?.type) { path += `/${encodeURIComponent(opts.type)}`; if (opts?.name) path += `/${encodeURIComponent(opts.name)}`; }
    const params = new URLSearchParams();
    if (opts?.offset) params.set('offset', String(opts.offset));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const q = params.toString();
    return this.fetch<any[]>(`${path}${q ? `?${q}` : ''}`);
  }

  async addDnsRecords(domain: string, records: Array<{ type: string; name: string; data: string; ttl: number; priority?: number }>) {
    await this.fetch<void>(`/v1/domains/${encodeURIComponent(domain)}/records`, { method: 'PATCH', body: JSON.stringify(records) });
  }

  async replaceDnsRecords(domain: string, type: string, name: string, records: Array<{ data: string; ttl: number; priority?: number }>) {
    await this.fetch<void>(`/v1/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(type)}/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(records) });
  }

  async deleteDnsRecords(domain: string, type: string, name: string) {
    await this.fetch<void>(`/v1/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(type)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  // Availability
  async checkAvailability(domain: string) {
    return this.fetch<any>(`/v1/domains/available?domain=${encodeURIComponent(domain)}`);
  }

  async suggestDomains(query: string, opts?: { limit?: number; tlds?: string[] }) {
    const params = new URLSearchParams({ query });
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.tlds?.length) params.set('tlds', opts.tlds.join(','));
    return this.fetch<any[]>(`/v1/domains/suggest?${params.toString()}`);
  }

  async getAgreements(tlds: string[], privacy?: boolean) {
    const params = new URLSearchParams({ tlds: tlds.join(',') });
    if (privacy !== undefined) params.set('privacy', String(privacy));
    return this.fetch<any[]>(`/v1/domains/agreements?${params.toString()}`);
  }
}
