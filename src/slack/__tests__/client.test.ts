import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackClient } from '../client.js';
import { ApiError, AuthError } from '../../shared/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function slackOk(data: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slackError(error: string) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SlackClient', () => {
  let client: SlackClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SlackClient({ botToken: 'xoxb-test-token' });
  });

  describe('postMessage', () => {
    it('sends POST to chat.postMessage with correct auth and body', async () => {
      mockFetch.mockResolvedValueOnce(slackOk({ ts: '1234567890.123456', channel: 'C123' }));

      const result = await client.postMessage('#general', 'Hello world');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer xoxb-test-token');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({ channel: '#general', text: 'Hello world' });
      expect(result).toEqual({ ts: '1234567890.123456', channel: 'C123' });
    });

    it('throws ApiError on Slack error response', async () => {
      mockFetch.mockResolvedValueOnce(slackError('channel_not_found'));

      await expect(client.postMessage('#nonexistent', 'test'))
        .rejects.toThrow(ApiError);
    });

    it('throws AuthError on invalid_auth', async () => {
      mockFetch.mockResolvedValueOnce(slackError('invalid_auth'));

      await expect(client.postMessage('#general', 'test'))
        .rejects.toThrow(AuthError);
    });
  });

  describe('postBlockKit', () => {
    it('sends blocks array with fallback text', async () => {
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: '*Bold text*' } },
      ];
      mockFetch.mockResolvedValueOnce(slackOk({ ts: '111.222', channel: 'C123' }));

      await client.postBlockKit('#alerts', 'Fallback text', blocks);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channel).toBe('#alerts');
      expect(body.text).toBe('Fallback text');
      expect(body.blocks).toEqual(blocks);
    });
  });

  describe('replyInThread', () => {
    it('sends thread_ts in the request body', async () => {
      mockFetch.mockResolvedValueOnce(slackOk({ ts: '333.444', channel: 'C123' }));

      await client.replyInThread('#general', '111.222', 'Thread reply');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channel).toBe('#general');
      expect(body.thread_ts).toBe('111.222');
      expect(body.text).toBe('Thread reply');
    });
  });

  describe('createChannel', () => {
    it('returns unwrapped SlackChannel', async () => {
      mockFetch.mockResolvedValueOnce(slackOk({ channel: { id: 'C123', name: 'new-channel' } }));

      const result = await client.createChannel('new-channel');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/conversations.create');
      const body = JSON.parse(opts.body);
      expect(body.name).toBe('new-channel');
      expect(result).toEqual({ id: 'C123', name: 'new-channel' });
    });
  });

  describe('listChannels', () => {
    it('returns unwrapped SlackChannel array', async () => {
      const channels = [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'random' }];
      mockFetch.mockResolvedValueOnce(slackOk({ channels }));

      const result = await client.listChannels();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/conversations.list');
      expect(result).toEqual(channels);
    });

    it('sends types and limit in request body', async () => {
      mockFetch.mockResolvedValueOnce(slackOk({ channels: [] }));

      await client.listChannels();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.types).toBe('public_channel');
      expect(body.limit).toBe(1000);
    });
  });

  describe('HTTP error handling', () => {
    it('throws ApiError on non-200 HTTP response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      await expect(client.postMessage('#general', 'test'))
        .rejects.toThrow(ApiError);
    });
  });
});
