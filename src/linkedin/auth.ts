export interface LinkedInAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface LinkedInTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export class LinkedInAuth {
  private config: LinkedInAuthConfig;
  private oauthBase = 'https://www.linkedin.com/oauth/v2';

  constructor(config: LinkedInAuthConfig) {
    this.config = config;
  }

  /**
   * Build the LinkedIn OAuth authorization URL.
   */
  getAuthorizationUrl(scopes: string[], state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      scope: scopes.join(' '),
    });
    return `${this.oauthBase}/authorization?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for access + refresh tokens.
   */
  async exchangeCodeForTokens(code: string): Promise<LinkedInTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
    });

    const res = await fetch(`${this.oauthBase}/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LinkedIn OAuth token exchange failed: ${res.status} ${text.slice(0, 300)}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      refreshTokenExpiresIn: data.refresh_token_expires_in,
    };
  }

  /**
   * Refresh an access token using a refresh token.
   */
  async refreshAccessToken(refreshToken: string): Promise<LinkedInTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const res = await fetch(`${this.oauthBase}/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LinkedIn OAuth token refresh failed: ${res.status} ${text.slice(0, 300)}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      refreshTokenExpiresIn: data.refresh_token_expires_in,
    };
  }
}
