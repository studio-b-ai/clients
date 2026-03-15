export interface SlackClientConfig {
  botToken: string;
}

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
      throw new Error(`Slack ${method}: ${res.status} ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) {
      throw new Error(`Slack ${method}: ${data.error ?? 'unknown error'}`);
    }
    return data as T;
  }

  /** Post a text message to a channel */
  async postMessage(channel: string, text: string) {
    return this.call<{ ts: string }>('chat.postMessage', { channel, text });
  }

  /** Post Block Kit blocks with fallback text */
  async postBlockKit(channel: string, text: string, blocks: unknown[]) {
    return this.call<{ ts: string }>('chat.postMessage', { channel, text, blocks });
  }

  /** Reply in a thread */
  async replyInThread(channel: string, threadTs: string, text: string) {
    return this.call<{ ts: string }>('chat.postMessage', { channel, thread_ts: threadTs, text });
  }

  /** Create a public channel */
  async createChannel(name: string) {
    return this.call<{ channel: { id: string; name: string } }>('conversations.create', { name });
  }

  /** List public channels */
  async listChannels() {
    return this.call<{ channels: Array<{ id: string; name: string }> }>('conversations.list', {});
  }
}
