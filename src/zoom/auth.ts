export interface ZoomAuthConfig {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

export class ZoomAuth {
  private config: ZoomAuthConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: ZoomAuthConfig) {
    this.config = config;
  }

  async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const res = await fetch('https://zoom.us/oauth/token?' + new URLSearchParams({
      grant_type: 'account_credentials',
      account_id: this.config.accountId,
    }).toString(), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Zoom OAuth failed: ${res.status} ${text.slice(0, 300)}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }
}
