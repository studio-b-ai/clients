export interface MicrosoftClientConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  defaultUserEmail?: string;
}

export class MicrosoftClient {
  private config: MicrosoftClientConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private graphBase = 'https://graph.microsoft.com/v1.0';

  constructor(config: MicrosoftClientConfig) {
    this.config = config;
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await fetch(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph OAuth failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = await res.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private async fetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const url = path.startsWith('http') ? path : `${this.graphBase}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
    });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this.fetch<T>(path, opts);
    }
    if (!res.ok) {
      let errMsg: string;
      try {
        const err = await res.json() as { error: { code: string; message: string } };
        errMsg = `Graph ${res.status} [${err.error.code}]: ${err.error.message}`;
      } catch { errMsg = `Graph ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`; }
      throw new Error(errMsg);
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private userPath(userEmail?: string): string {
    const user = userEmail || this.config.defaultUserEmail || 'me';
    return `/users/${encodeURIComponent(user)}`;
  }

  async checkHealth(): Promise<boolean> {
    try { await this.getToken(); return true; } catch { return false; }
  }

  // Mail
  async listMessages(opts?: { userEmail?: string; folderId?: string; filter?: string; search?: string; top?: number; select?: string; orderBy?: string }) {
    const base = opts?.folderId
      ? `${this.userPath(opts?.userEmail)}/mailFolders/${encodeURIComponent(opts.folderId)}/messages`
      : `${this.userPath(opts?.userEmail)}/messages`;
    const params = new URLSearchParams();
    params.set('$top', String(opts?.top ?? 10));
    params.set('$select', opts?.select ?? 'id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments');
    if (opts?.filter) params.set('$filter', opts.filter);
    if (opts?.search) params.set('$search', `"${opts.search}"`);
    if (opts?.orderBy) params.set('$orderby', opts.orderBy);
    return this.fetch<any>(`${base}?${params.toString()}`);
  }

  async getMessage(messageId: string, opts?: { userEmail?: string; preferText?: boolean }) {
    const params = opts?.preferText ? '?$select=id,subject,from,toRecipients,body,receivedDateTime&$expand=' : '';
    return this.fetch<any>(`${this.userPath(opts?.userEmail)}/messages/${messageId}${params}`);
  }

  async sendMessage(opts: { to: string[]; subject: string; body: string; cc?: string[]; userEmail?: string }) {
    const message = {
      subject: opts.subject,
      body: { contentType: 'HTML', content: opts.body },
      toRecipients: opts.to.map(e => ({ emailAddress: { address: e } })),
      ccRecipients: opts.cc?.map(e => ({ emailAddress: { address: e } })),
    };
    await this.fetch<void>(`${this.userPath(opts.userEmail)}/sendMail`, {
      method: 'POST', body: JSON.stringify({ message, saveToSentItems: true }),
    });
  }

  // Calendar
  async listEvents(opts?: { userEmail?: string; startDateTime?: string; endDateTime?: string; top?: number; filter?: string }) {
    const user = this.userPath(opts?.userEmail);
    const params = new URLSearchParams();
    params.set('$top', String(opts?.top ?? 10));
    params.set('$select', 'id,subject,start,end,location,organizer,attendees,isAllDay,webLink');
    let path: string;
    if (opts?.startDateTime && opts?.endDateTime) {
      params.set('startDateTime', opts.startDateTime);
      params.set('endDateTime', opts.endDateTime);
      path = `${user}/calendarView`;
    } else {
      if (opts?.filter) params.set('$filter', opts.filter);
      params.set('$orderby', 'start/dateTime');
      path = `${user}/events`;
    }
    return this.fetch<any>(`${path}?${params.toString()}`);
  }

  async createEvent(opts: { subject: string; startDateTime: string; endDateTime: string; attendees?: Array<{ email: string }>; body?: string; location?: string; isOnlineMeeting?: boolean; userEmail?: string; startTimeZone?: string; endTimeZone?: string }) {
    const event: any = {
      subject: opts.subject,
      start: { dateTime: opts.startDateTime, timeZone: opts.startTimeZone ?? 'UTC' },
      end: { dateTime: opts.endDateTime, timeZone: opts.endTimeZone ?? 'UTC' },
    };
    if (opts.attendees) event.attendees = opts.attendees.map(a => ({ emailAddress: { address: a.email }, type: 'required' }));
    if (opts.body) event.body = { contentType: 'HTML', content: opts.body };
    if (opts.location) event.location = { displayName: opts.location };
    if (opts.isOnlineMeeting) event.isOnlineMeeting = true;
    return this.fetch<any>(`${this.userPath(opts.userEmail)}/events`, { method: 'POST', body: JSON.stringify(event) });
  }

  // Files (OneDrive)
  async listFiles(opts?: { userEmail?: string; folderId?: string; folderPath?: string; top?: number }) {
    let path: string;
    if (opts?.folderId) path = `${this.userPath(opts?.userEmail)}/drive/items/${opts.folderId}/children`;
    else if (opts?.folderPath) path = `${this.userPath(opts?.userEmail)}/drive/root:/${opts.folderPath}:/children`;
    else path = `${this.userPath(opts?.userEmail)}/drive/root/children`;
    const params = new URLSearchParams();
    params.set('$top', String(opts?.top ?? 25));
    params.set('$select', 'id,name,size,file,folder,lastModifiedDateTime,webUrl');
    return this.fetch<any>(`${path}?${params.toString()}`);
  }

  async searchFiles(query: string, opts?: { userEmail?: string; top?: number }) {
    return this.fetch<any>(`${this.userPath(opts?.userEmail)}/drive/root/search(q='${encodeURIComponent(query)}')?$top=${opts?.top ?? 10}`);
  }

  async getFile(opts: { itemId?: string; itemPath?: string; userEmail?: string }) {
    const path = opts.itemId
      ? `${this.userPath(opts.userEmail)}/drive/items/${opts.itemId}`
      : `${this.userPath(opts.userEmail)}/drive/root:/${opts.itemPath}`;
    return this.fetch<any>(path);
  }

  // Mail folders
  async listMailFolders(opts?: { userEmail?: string; top?: number }) {
    return this.fetch<any>(`${this.userPath(opts?.userEmail)}/mailFolders?$top=${opts?.top ?? 25}`);
  }
}
