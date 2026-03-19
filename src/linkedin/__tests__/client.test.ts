import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInClient } from '../client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('LinkedInClient', () => {
  let client: LinkedInClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new LinkedInClient({ accessToken: 'test-token' });
  });

  function mockResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
    const headersObj = new Headers(headers);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: headersObj,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body ?? '')),
      clone: () => mockResponse(status, body, headers),
    } as unknown as Response;
  }

  describe('createPost', () => {
    it('sends POST to /rest/posts and returns URN from header', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(201, {}, { 'x-restli-id': 'urn:li:share:12345' }),
      );

      const result = await client.createPost({
        authorUrn: 'urn:li:organization:111',
        text: 'Hello LinkedIn!',
      });

      expect(result.postUrn).toBe('urn:li:share:12345');
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.linkedin.com/rest/posts');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer test-token');
      expect(opts.headers['LinkedIn-Version']).toBe('202401');
      expect(opts.headers['X-Restli-Protocol-Version']).toBe('2.0.0');

      const body = JSON.parse(opts.body);
      expect(body.author).toBe('urn:li:organization:111');
      expect(body.commentary).toBe('Hello LinkedIn!');
      expect(body.visibility).toBe('PUBLIC');
    });

    it('throws if x-restli-id header is missing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(201, {}));

      await expect(
        client.createPost({ authorUrn: 'urn:li:person:1', text: 'test' }),
      ).rejects.toThrow('missing x-restli-id');
    });

    it('uses CONNECTIONS visibility when specified', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(201, {}, { 'x-restli-id': 'urn:li:share:99' }),
      );

      await client.createPost({
        authorUrn: 'urn:li:person:1',
        text: 'connections only',
        visibility: 'CONNECTIONS',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.visibility).toBe('CONNECTIONS');
    });
  });

  describe('createComment', () => {
    it('sends POST to socialActions comments endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(201, { $URN: 'urn:li:comment:789' }),
      );

      const result = await client.createComment({
        postUrn: 'urn:li:share:12345',
        actorUrn: 'urn:li:person:1',
        text: 'Great post!',
      });

      expect(result.commentUrn).toBe('urn:li:comment:789');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/rest/socialActions/');
      expect(url).toContain('/comments');
    });
  });

  describe('addReaction', () => {
    it('sends POST to reactions endpoint with LIKE default', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(201, {}));

      await client.addReaction({
        postUrn: 'urn:li:share:12345',
        actorUrn: 'urn:li:person:1',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reactionType).toBe('LIKE');
      expect(body.actor).toBe('urn:li:person:1');
    });

    it('allows custom reaction type', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(201, {}));

      await client.addReaction({
        postUrn: 'urn:li:share:12345',
        actorUrn: 'urn:li:person:1',
        reactionType: 'CELEBRATE',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reactionType).toBe('CELEBRATE');
    });
  });

  describe('resharePost', () => {
    it('sends POST to /rest/posts with reshareContext', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(201, {}, { 'x-restli-id': 'urn:li:share:999' }),
      );

      const result = await client.resharePost({
        authorUrn: 'urn:li:person:1',
        originalPostUrn: 'urn:li:share:12345',
        commentary: 'Must read!',
      });

      expect(result.postUrn).toBe('urn:li:share:999');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reshareContext.parent).toBe('urn:li:share:12345');
      expect(body.commentary).toBe('Must read!');
    });
  });

  describe('getUserProfile', () => {
    it('returns user profile from /v2/userinfo', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { sub: 'abc123', name: 'Kevin B', email: 'kevin@b.studio' }),
      );

      const profile = await client.getUserProfile();
      expect(profile.sub).toBe('abc123');
      expect(profile.name).toBe('Kevin B');
      expect(profile.email).toBe('kevin@b.studio');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.linkedin.com/v2/userinfo');
    });
  });

  describe('error handling', () => {
    it('throws descriptive error on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(403, { message: 'Access denied', status: 403 }),
      );

      await expect(client.getUserProfile()).rejects.toThrow('LinkedIn 403: Access denied');
    });

    it('falls back to text body when JSON parse fails', async () => {
      const res = {
        ok: false,
        status: 500,
        headers: new Headers(),
        clone: () => {
          let callCount = 0;
          return {
            ok: false,
            status: 500,
            headers: new Headers(),
            json: () => { callCount++; if (callCount <= 1) throw new Error('not json'); return Promise.resolve({}); },
            text: () => Promise.resolve('Internal Server Error'),
          } as unknown as Response;
        },
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(res);

      await expect(client.getUserProfile()).rejects.toThrow('LinkedIn 500');
    });
  });

  describe('updateAccessToken', () => {
    it('uses the new token on subsequent requests', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { sub: 'x', name: 'X', email: 'x@x.com' }),
      );

      client.updateAccessToken('new-token');
      await client.getUserProfile();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer new-token');
    });
  });
});
