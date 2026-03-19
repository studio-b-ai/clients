export interface LinkedInClientConfig {
  accessToken: string;
  apiVersion?: string;
}

export interface CreatePostOptions {
  authorUrn: string;
  text: string;
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

export interface CreateCommentOptions {
  postUrn: string;
  actorUrn: string;
  text: string;
}

export interface AddReactionOptions {
  postUrn: string;
  actorUrn: string;
  reactionType?: 'LIKE' | 'CELEBRATE' | 'SUPPORT' | 'LOVE' | 'INSIGHTFUL' | 'FUNNY';
}

export interface ResharePostOptions {
  authorUrn: string;
  originalPostUrn: string;
  commentary: string;
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

export interface UserProfile {
  sub: string;
  name: string;
  email: string;
}

export class LinkedInClient {
  private accessToken: string;
  private apiVersion: string;
  private baseUrl = 'https://api.linkedin.com';

  constructor(config: LinkedInClientConfig) {
    this.accessToken = config.accessToken;
    this.apiVersion = config.apiVersion ?? '202602';
  }

  /**
   * Replace the current access token (e.g. after a refresh).
   */
  updateAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Create a new LinkedIn post.
   */
  async createPost(opts: CreatePostOptions): Promise<{ postUrn: string }> {
    const body = {
      author: opts.authorUrn,
      commentary: opts.text,
      visibility: opts.visibility ?? 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
    };

    const res = await this.request('/rest/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const postUrn = res.headers.get('x-restli-id');
    if (!postUrn) {
      throw new Error('LinkedIn createPost: missing x-restli-id header in response');
    }
    return { postUrn };
  }

  /**
   * Add a comment to a post.
   */
  async createComment(opts: CreateCommentOptions): Promise<{ commentUrn: string }> {
    const encodedUrn = encodeURIComponent(opts.postUrn);
    const body = {
      actor: opts.actorUrn,
      message: { text: opts.text },
    };

    const res = await this.request(`/rest/socialActions/${encodedUrn}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const data = await res.json() as { $URN?: string; id?: string };
    const commentUrn = data.$URN ?? data.id ?? '';
    return { commentUrn };
  }

  /**
   * Add a reaction to a post.
   */
  async addReaction(opts: AddReactionOptions): Promise<void> {
    const encodedUrn = encodeURIComponent(opts.postUrn);
    const body = {
      root: opts.postUrn,
      reactionType: opts.reactionType ?? 'LIKE',
      actor: opts.actorUrn,
    };

    await this.request(`/rest/reactions/${encodedUrn}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Reshare (repost) a post with commentary.
   */
  async resharePost(opts: ResharePostOptions): Promise<{ postUrn: string }> {
    const body = {
      author: opts.authorUrn,
      commentary: opts.commentary,
      visibility: opts.visibility ?? 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      reshareContext: {
        parent: opts.originalPostUrn,
      },
    };

    const res = await this.request('/rest/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const postUrn = res.headers.get('x-restli-id');
    if (!postUrn) {
      throw new Error('LinkedIn resharePost: missing x-restli-id header in response');
    }
    return { postUrn };
  }

  /**
   * Get basic info about a LinkedIn organization (company page).
   */
  async getOrganizationInfo(orgUrn: string): Promise<{ localizedName: string }> {
    // Extract numeric ID from URN like "urn:li:organization:12345"
    const id = orgUrn.includes(':') ? orgUrn.split(':').pop()! : orgUrn;
    const res = await this.request(`/rest/organizations/${id}`);
    const data = await res.json() as { localizedName: string };
    return { localizedName: data.localizedName };
  }

  /**
   * Get the authenticated user's profile (OpenID Connect userinfo).
   */
  async getUserProfile(): Promise<UserProfile> {
    const res = await this.request('/v2/userinfo');
    const data = await res.json() as { sub: string; name: string; email: string };
    return { sub: data.sub, name: data.name, email: data.email };
  }

  /**
   * Internal request helper — adds auth, versioning, and protocol headers.
   */
  private async request(path: string, opts: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'LinkedIn-Version': this.apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });

    if (!res.ok) {
      let errMsg: string;
      try {
        const err = await res.clone().json() as { message?: string; status?: number };
        errMsg = `LinkedIn ${res.status}: ${err.message ?? JSON.stringify(err)}`;
      } catch {
        errMsg = `LinkedIn ${res.status}: ${await res.clone().text()}`;
      }
      throw new Error(errMsg);
    }

    return res;
  }
}
