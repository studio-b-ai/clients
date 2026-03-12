import { ZoomAuth, type ZoomAuthConfig } from './auth.js';

export interface ZoomClientConfig extends ZoomAuthConfig {}

export class ZoomClient {
  private auth: ZoomAuth;
  private baseUrl = 'https://api.zoom.us/v2';

  constructor(config: ZoomClientConfig) {
    this.auth = new ZoomAuth(config);
  }

  private async fetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const token = await this.auth.getToken();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this.fetch<T>(path, opts);
    }

    if (!res.ok) {
      let errMsg: string;
      try {
        const err = await res.json() as { code?: number; message?: string };
        errMsg = `Zoom ${res.status}: ${err.message ?? JSON.stringify(err)}`;
      } catch { errMsg = `Zoom ${res.status}: ${await res.text()}`; }
      throw new Error(errMsg);
    }

    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // Users
  async listUsers(opts?: { status?: string; page_size?: number; page_number?: number }) {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.page_size) params.set('page_size', String(opts.page_size));
    if (opts?.page_number) params.set('page_number', String(opts.page_number));
    const q = params.toString();
    return this.fetch<any>(`/users${q ? `?${q}` : ''}`);
  }

  async getUser(userId: string) {
    return this.fetch<any>(`/users/${encodeURIComponent(userId)}`);
  }

  async createUser(action: string, userInfo: { email: string; type: number; first_name?: string; last_name?: string }) {
    return this.fetch<any>('/users', { method: 'POST', body: JSON.stringify({ action, user_info: userInfo }) });
  }

  async updateUser(userId: string, data: Record<string, unknown>) {
    await this.fetch<void>(`/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteUser(userId: string, action: string = 'disassociate') {
    await this.fetch<void>(`/users/${encodeURIComponent(userId)}?action=${action}`, { method: 'DELETE' });
  }

  // Meetings
  async listMeetings(userId: string, opts?: { type?: string; page_size?: number }) {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    if (opts?.page_size) params.set('page_size', String(opts.page_size));
    const q = params.toString();
    return this.fetch<any>(`/users/${encodeURIComponent(userId)}/meetings${q ? `?${q}` : ''}`);
  }

  async createMeeting(userId: string, data: { topic: string; type: number; start_time?: string; duration?: number; timezone?: string; agenda?: string; settings?: Record<string, unknown> }) {
    return this.fetch<any>(`/users/${encodeURIComponent(userId)}/meetings`, { method: 'POST', body: JSON.stringify(data) });
  }

  async getMeeting(meetingId: string) {
    return this.fetch<any>(`/meetings/${meetingId}`);
  }

  async updateMeeting(meetingId: string, data: Record<string, unknown>) {
    await this.fetch<void>(`/meetings/${meetingId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteMeeting(meetingId: string) {
    await this.fetch<void>(`/meetings/${meetingId}`, { method: 'DELETE' });
  }

  // Phone
  async listPhoneUsers(opts?: { page_size?: number; next_page_token?: string }) {
    const params = new URLSearchParams();
    if (opts?.page_size) params.set('page_size', String(opts.page_size));
    if (opts?.next_page_token) params.set('next_page_token', opts.next_page_token);
    const q = params.toString();
    return this.fetch<any>(`/phone/users${q ? `?${q}` : ''}`);
  }

  async getPhoneUser(userId: string) {
    return this.fetch<any>(`/phone/users/${encodeURIComponent(userId)}`);
  }

  // Recordings
  async listRecordings(userId: string, opts?: { from?: string; to?: string; page_size?: number }) {
    const params = new URLSearchParams();
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    if (opts?.page_size) params.set('page_size', String(opts.page_size));
    const q = params.toString();
    return this.fetch<any>(`/users/${encodeURIComponent(userId)}/recordings${q ? `?${q}` : ''}`);
  }

  // Account
  async getAccountInfo() {
    return this.fetch<any>('/accounts/me');
  }

  async getAccountSettings() {
    return this.fetch<any>('/accounts/me/settings');
  }

  // Generic passthrough for any Zoom API path
  async request(method: string, path: string, body?: unknown) {
    return this.fetch<any>(path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
