import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackClient } from './client.js';
import { ApiError, AuthError } from '../shared/errors.js';

function mockFetch(body: Record<string, unknown>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('SlackClient', () => {
  let client: SlackClient;

  beforeEach(() => {
    client = new SlackClient({ botToken: 'xoxb-test-token' });
  });

  describe('postMessage', () => {
    it('returns a SlackMessage with ts and channel', async () => {
      global.fetch = mockFetch({ ok: true, ts: '1234.5678', channel: 'C123' });
      const result = await client.postMessage('C123', 'hello');
      expect(result).toEqual({ ts: '1234.5678', channel: 'C123' });
    });
  });

  describe('postBlockKit', () => {
    it('returns a SlackMessage with ts and channel', async () => {
      global.fetch = mockFetch({ ok: true, ts: '1234.5678', channel: 'C123' });
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }];
      const result = await client.postBlockKit('C123', 'fallback', blocks);
      expect(result).toEqual({ ts: '1234.5678', channel: 'C123' });
    });
  });

  describe('replyInThread', () => {
    it('returns a SlackMessage with ts and channel', async () => {
      global.fetch = mockFetch({ ok: true, ts: '1234.9999', channel: 'C123' });
      const result = await client.replyInThread('C123', '1234.5678', 'reply');
      expect(result).toEqual({ ts: '1234.9999', channel: 'C123' });
    });

    it('sends thread_ts in request body', async () => {
      const fetchMock = mockFetch({ ok: true, ts: '1234.9999', channel: 'C123' });
      global.fetch = fetchMock;
      await client.replyInThread('C123', '1234.5678', 'reply');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thread_ts).toBe('1234.5678');
    });
  });

  describe('createChannel', () => {
    it('returns unwrapped SlackChannel', async () => {
      global.fetch = mockFetch({ ok: true, channel: { id: 'C999', name: 'new-channel' } });
      const result = await client.createChannel('new-channel');
      expect(result).toEqual({ id: 'C999', name: 'new-channel' });
      // Verify unwrapped — no nested .channel property
      expect(result.id).toBe('C999');
      expect(result.name).toBe('new-channel');
    });
  });

  describe('listChannels', () => {
    it('returns unwrapped SlackChannel array', async () => {
      global.fetch = mockFetch({
        ok: true,
        channels: [
          { id: 'C001', name: 'general' },
          { id: 'C002', name: 'random' },
        ],
      });
      const result = await client.listChannels();
      expect(result).toEqual([
        { id: 'C001', name: 'general' },
        { id: 'C002', name: 'random' },
      ]);
    });

    it('sends types and limit in request body', async () => {
      const fetchMock = mockFetch({ ok: true, channels: [] });
      global.fetch = fetchMock;
      await client.listChannels();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.types).toBe('public_channel');
      expect(body.limit).toBe(1000);
    });
  });

  describe('error handling', () => {
    it('throws AuthError on invalid_auth', async () => {
      global.fetch = mockFetch({ ok: false, error: 'invalid_auth' });
      await expect(client.postMessage('C123', 'hi')).rejects.toThrow(AuthError);
    });

    it('throws AuthError on token_revoked', async () => {
      global.fetch = mockFetch({ ok: false, error: 'token_revoked' });
      await expect(client.postMessage('C123', 'hi')).rejects.toThrow(AuthError);
    });

    it('throws AuthError on not_authed', async () => {
      global.fetch = mockFetch({ ok: false, error: 'not_authed' });
      await expect(client.postMessage('C123', 'hi')).rejects.toThrow(AuthError);
    });

    it('throws ApiError on non-auth Slack errors', async () => {
      global.fetch = mockFetch({ ok: false, error: 'channel_not_found' });
      await expect(client.postMessage('C123', 'hi')).rejects.toThrow(ApiError);
    });

    it('throws ApiError on HTTP non-200', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });
      await expect(client.postMessage('C123', 'hi')).rejects.toThrow(ApiError);
    });

    it('ApiError on HTTP non-200 includes status code', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      });
      try {
        await client.postMessage('C123', 'hi');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).statusCode).toBe(503);
      }
    });
  });
});
