import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionPool, type SessionHandle } from '../session-pool.js';

function makePool(overrides: Partial<ConstructorParameters<typeof SessionPool>[0]> = {}) {
  return new SessionPool({
    account: 'api-bot',
    maxSize: 3,
    credentials: {
      baseUrl: 'https://test.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'TestTenant',
    },
    redisUrl: '',
    serviceId: 'test-service',
    ...overrides,
  });
}

describe('SessionPool', () => {
  describe('types and construction', () => {
    it('should construct with required config', () => {
      const pool = makePool({ redisUrl: 'redis://localhost:6379' });
      expect(pool).toBeDefined();
      expect(pool.account).toBe('api-bot');
      expect(pool.maxSize).toBe(3);
    });

    it('should use default values for optional config', () => {
      const pool = makePool();
      expect(pool.staleCheckoutMs).toBe(120_000);
      expect(pool.checkoutTimeoutMs).toBe(30_000);
    });
  });

  describe('checkout', () => {
    it('should create a new slot when pool is empty', async () => {
      const pool = makePool();
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123; ASP.NET_SessionId=xyz');
      pool._setLoginFn(loginMock);

      const handle = await pool.checkout();
      expect(handle).toBeDefined();
      expect(handle.cookie).toBe('.ASPXAUTH=abc123; ASP.NET_SessionId=xyz');
      expect(handle.slotId).toBeTruthy();
      expect(loginMock).toHaveBeenCalledOnce();

      await pool.checkin(handle);
    });

    it('should reuse existing available slot without logging in', async () => {
      const pool = makePool();
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123; ASP.NET_SessionId=xyz');
      pool._setLoginFn(loginMock);

      const handle1 = await pool.checkout();
      const slotId1 = handle1.slotId;
      await pool.checkin(handle1);

      const handle2 = await pool.checkout();
      expect(handle2.slotId).toBe(slotId1);
      expect(loginMock).toHaveBeenCalledOnce(); // NOT called a second time
      await pool.checkin(handle2);
    });

    it('should return degraded handle when Redis unavailable', async () => {
      const pool = makePool({ redisUrl: '' });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      const handle = await pool.checkout();
      expect(handle.degraded).toBe(true);
      expect(handle.cookie).toBe('.ASPXAUTH=abc123');
      await pool.checkin(handle);
    });
  });
});
