import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionPool, type SessionHandle } from '../session-pool.js';
import { AccountLockedError } from '../error-handler.js';

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

  describe('withSession', () => {
    it('should checkout, run fn, and checkin automatically', async () => {
      const pool = makePool();
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      const result = await pool.withSession(async (handle) => {
        expect(handle.cookie).toBe('.ASPXAUTH=abc123');
        return 'ok';
      });

      expect(result).toBe('ok');
      // After withSession, the slot should be available again
      const status = await pool.status();
      expect(status.checkedOut).toBe(0);
    });

    it('should evict slot on 401 and retry once', async () => {
      const pool = makePool();
      let callCount = 0;
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      const result = await pool.withSession(async (handle) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('Unauthorized');
          (err as any).statusCode = 401;
          throw err;
        }
        return 'retried-ok';
      });

      expect(result).toBe('retried-ok');
      expect(callCount).toBe(2);
    });

    it('should trip circuit breaker on AccountLockedError', async () => {
      const pool = makePool();
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      await expect(
        pool.withSession(async () => {
          throw new AccountLockedError('Account locked');
        }),
      ).rejects.toThrow('Account locked');

      expect(pool.circuitBreaker.currentState).toBe('open');
    });
  });

  describe('stale reclamation', () => {
    it('should reclaim slot after staleCheckoutMs', async () => {
      const pool = makePool({ staleCheckoutMs: 100 });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      // Checkout without checkin (simulate crash)
      const handle1 = await pool.checkout();
      const slotId1 = handle1.slotId;

      // Wait for stale threshold
      await new Promise((r) => setTimeout(r, 150));

      // Second checkout should reclaim the stale slot
      const handle2 = await pool.checkout();
      expect(handle2.slotId).toBe(slotId1);
      expect(loginMock).toHaveBeenCalledOnce(); // No new login needed
      await pool.checkin(handle2);
    });
  });

  describe('status', () => {
    it('should report pool state accurately', async () => {
      const pool = makePool();
      const loginMock = vi.fn()
        .mockResolvedValueOnce('.ASPXAUTH=cookie1')
        .mockResolvedValueOnce('.ASPXAUTH=cookie2');
      pool._setLoginFn(loginMock);

      // Checkout 2 slots
      const handle1 = await pool.checkout();
      const handle2 = await pool.checkout();

      let status = await pool.status();
      expect(status.activeSlots).toBe(2);
      expect(status.checkedOut).toBe(2);
      expect(status.available).toBe(0);
      expect(status.account).toBe('api-bot');
      expect(status.maxSize).toBe(3);
      expect(status.degraded).toBe(true); // no Redis URL
      expect(status.circuitBreaker).toBe('closed');

      // Checkin 1
      await pool.checkin(handle1);
      status = await pool.status();
      expect(status.checkedOut).toBe(1);
      expect(status.available).toBe(1);
      expect(status.activeSlots).toBe(2);

      await pool.checkin(handle2);
    });
  });
});
