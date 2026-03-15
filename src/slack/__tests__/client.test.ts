import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackClient } from '../client.js';

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
      mockFetch.mockResolvedValueOnce(slackOk({ ts: '1234567890.123456' }));

      const result = await client.postMessage('#general', 'Hello world');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer xoxb-test-token');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({ channel: '#general', text: 'Hello world' });
      expect(result).toEqual({ ok: true, ts: '1234567890.123456' });
    });

    it('throws on Slack error response', async () => {
      mockFetch.mockResolvedValueOnce(slackError('channel_not_found'));

      await expect(client.postMessage('#nonexistent', 'test'))
        .rejects.toThrow('channel_not_found');
    });
  });

  describe('postBlockKit', () => {
    it('sends blocks array with fallback text', async () => {
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: '*Bold text*' } },
      ];
      mockFetch.mockResolvedValueOnce(slackOk({ ts: '111.222' }));

      await client.postBlockKit('#alerts', 'Fallback text', blocks);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channel).toBe('#alerts');
      expect(body.text).toBe('Fallback text');
      expect(body.blocks).toEqual(blocks);
    });
  });

  describe('replyInThread', () => {
    it('sends thread_ts in the request body', async () => {
      mockFetch.mockResolvedValueOnce(slackOk({ ts: '333.444' }));

      await client.replyInThread('#general', '111.222', 'Thread reply');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channel).toBe('#general');
      expect(body.thread_ts).toBe('111.222');
      expect(body.text).toBe('Thread reply');
    });
  });

  describe('createChannel', () => {
    it('calls conversations.create with channel name', async () => {
      mockFetch.mockResolvedValueOnce(slackOk({ channel: { id: 'C123', name: 'new-channel' } }));

      const result = await client.createChannel('new-channel');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/conversations.create');
      const body = JSON.parse(opts.body);
      expect(body.name).toBe('new-channel');
      expect(result.channel).toEqual({ id: 'C123', name: 'new-channel' });
    });
  });

  describe('listChannels', () => {
    it('calls conversations.list with correct params', async () => {
      const channels = [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'random' }];
      mockFetch.mockResolvedValueOnce(slackOk({ channels }));

      const result = await client.listChannels();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/conversations.list');
      expect(result.channels).toEqual(channels);
    });
  });

  describe('HTTP error handling', () => {
    it('throws on non-200 HTTP response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      await expect(client.postMessage('#general', 'test'))
        .rejects.toThrow('500');
    });
  });
});
