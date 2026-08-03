import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MicrosoftClient } from '../client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function tokenOk() {
  return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function graphOk(data: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ id: 'evt-1', ...data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MicrosoftClient.createEvent recurrence pass-through (studio-b-ai/clients#35)', () => {
  let client: MicrosoftClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MicrosoftClient({ tenantId: 't', clientId: 'c', clientSecret: 's' });
  });

  it('forwards recurrence verbatim into the Graph POST body when supplied', async () => {
    const recurrence = {
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
      range: { type: 'noEnd', startDate: '2026-08-10' },
    };
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(graphOk());

    await client.createEvent({
      subject: 'Weekly sync',
      startDateTime: '2026-08-10T15:00:00Z',
      endDateTime: '2026-08-10T15:30:00Z',
      recurrence,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, eventOpts] = mockFetch.mock.calls[1];
    const body = JSON.parse(eventOpts.body);
    expect(body.recurrence).toEqual(recurrence);
  });

  it('omits the recurrence key entirely when not supplied', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(graphOk());

    await client.createEvent({
      subject: 'One-off meeting',
      startDateTime: '2026-08-10T15:00:00Z',
      endDateTime: '2026-08-10T15:30:00Z',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, eventOpts] = mockFetch.mock.calls[1];
    const body = JSON.parse(eventOpts.body);
    expect('recurrence' in body).toBe(false);
  });
});
