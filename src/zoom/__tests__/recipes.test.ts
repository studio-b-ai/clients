import { describe, it, expect, vi } from 'vitest';
import { provisionPhone, deprovisionPhone } from '../recipes.js';

// --- Mock factory ---

function mockClient() {
  return {
    getUser: vi.fn(),
    request: vi.fn(),
    getPhoneUser: vi.fn(),
  };
}

// --- Tests ---

describe('provisionPhone', () => {
  it('provisions phone for a user end-to-end', async () => {
    const client = mockClient();
    client.getUser.mockResolvedValue({ id: 'user-abc', email: 'jane@example.com' });
    client.request
      // First call: POST /phone/users (enable phone)
      .mockResolvedValueOnce({ id: 'phone-user-1' })
      // Second call: POST calling_plans (assign calling plan)
      .mockResolvedValueOnce({});
    client.getPhoneUser.mockResolvedValue({
      id: 'user-abc',
      phone_numbers: [{ number: '+17041234567' }],
    });

    const result = await provisionPhone(client as any, 'jane@example.com', 200);

    expect(client.getUser).toHaveBeenCalledWith('jane@example.com');
    // Enable phone
    expect(client.request).toHaveBeenCalledWith('POST', '/phone/users', {
      user_id: 'user-abc',
    });
    // Assign calling plan
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/phone/users/user-abc/calling_plans',
      { calling_plans: [{ type: 200 }] },
    );
    expect(client.getPhoneUser).toHaveBeenCalledWith('user-abc');
    expect(result).toEqual({
      id: 'user-abc',
      phone_numbers: [{ number: '+17041234567' }],
    });
  });

  it('handles 409 on calling plan assignment (already assigned)', async () => {
    const client = mockClient();
    client.getUser.mockResolvedValue({ id: 'user-abc' });
    client.request
      .mockResolvedValueOnce({ id: 'phone-user-1' })
      // 409 conflict on calling plan
      .mockRejectedValueOnce(new Error('Zoom 409: Calling plan already assigned'));
    client.getPhoneUser.mockResolvedValue({
      id: 'user-abc',
      phone_numbers: [],
    });

    // Should not throw
    const result = await provisionPhone(client as any, 'jane@example.com', 200);
    expect(result.id).toBe('user-abc');
  });

  it('rethrows non-409 errors on calling plan assignment', async () => {
    const client = mockClient();
    client.getUser.mockResolvedValue({ id: 'user-abc' });
    client.request
      .mockResolvedValueOnce({ id: 'phone-user-1' })
      .mockRejectedValueOnce(new Error('Zoom 500: Internal Server Error'));

    await expect(provisionPhone(client as any, 'jane@example.com', 200)).rejects.toThrow(
      'Zoom 500',
    );
  });
});

describe('deprovisionPhone', () => {
  it('looks up user and deletes phone provisioning', async () => {
    const client = mockClient();
    client.getUser.mockResolvedValue({ id: 'user-xyz' });
    client.request.mockResolvedValue({});

    await deprovisionPhone(client as any, 'jane@example.com');

    expect(client.getUser).toHaveBeenCalledWith('jane@example.com');
    expect(client.request).toHaveBeenCalledWith('DELETE', '/phone/users/user-xyz');
  });
});
