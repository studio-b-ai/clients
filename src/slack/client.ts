import { ApiError, AuthError } from '../shared/errors.js';

export interface SlackClientConfig {
  botToken: string;
}

export interface SlackMessage {
  ts: string;
  channel: string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

const AUTH_ERRORS = new Set(['invalid_auth', 'token_revoked', 'not_authed', 'account_inactive']);

export class SlackClient {
  private config: SlackClientConfig;
  private apiBase = 'https://slack.com/api';

  constructor(config: SlackClientConfig) {
    this.config = config;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new ApiError(`Slack ${method}: ${res.status} ${errText.slice(0, 300)}`, res.status, errText);
    }
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) {
      const error = data.error ?? 'unknown error';
      if (AUTH_ERRORS.has(error)) {
        throw new AuthError(`Slack ${method}: ${error}`);
      }
      throw new ApiError(`Slack ${method}: ${error}`, 400, { error });
    }
    return data as T;
  }

  /** Post a text message to a channel */
  async postMessage(channel: string, text: string): Promise<SlackMessage> {
    const data = await this.call<{ ts: string; channel: string }>('chat.postMessage', { channel, text });
    return { ts: data.ts, channel: data.channel };
  }

  /** Post Block Kit blocks with fallback text */
  async postBlockKit(channel: string, text: string, blocks: unknown[]): Promise<SlackMessage> {
    const data = await this.call<{ ts: string; channel: string }>('chat.postMessage', { channel, text, blocks });
    return { ts: data.ts, channel: data.channel };
  }

  /** Reply in a thread */
  async replyInThread(channel: string, threadTs: string, text: string): Promise<SlackMessage> {
    const data = await this.call<{ ts: string; channel: string }>('chat.postMessage', { channel, thread_ts: threadTs, text });
    return { ts: data.ts, channel: data.channel };
  }

  /** Create a public channel */
  async createChannel(name: string): Promise<SlackChannel> {
    const data = await this.call<{ channel: { id: string; name: string } }>('conversations.create', { name });
    return { id: data.channel.id, name: data.channel.name };
  }

  /** List public channels */
  async listChannels(): Promise<SlackChannel[]> {
    const data = await this.call<{ channels: Array<{ id: string; name: string }> }>('conversations.list', {
      types: 'public_channel',
      limit: 1000,
    });
    return data.channels.map((ch) => ({ id: ch.id, name: ch.name }));
  }
}
