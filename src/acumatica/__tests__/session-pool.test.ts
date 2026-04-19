import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionPool,
  poolKeyPrefix,
  poolLockoutKey,
  type SessionHandle,
} from '../session-pool.js';
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
  describe('per-(baseUrl, account, company) key scoping', () => {
    it('produces a different prefix for different company on the same instance', () => {
      const a = poolKeyPrefix('https://hf.acumatica.com', 'api-bot', 'Heritage Fabrics');
      const b = poolKeyPrefix('https://hf.acumatica.com', 'api-bot', 'Heritage Test');
      expect(a).not.toBe(b);
      expect(a).toMatch(/^acumatica:pool:[A-Za-z0-9_-]+:api-bot:[A-Za-z0-9_-]+$/);
    });

    it('produces a different prefix for different baseUrl with the same account+company', () => {
      const a = poolKeyPrefix('https://hf.acumatica.com', 'api-bot', 'Heritage Fabrics');
      const b = poolKeyPrefix('https://other.acumatica.com', 'api-bot', 'Heritage Fabrics');
      expect(a).not.toBe(b);
    });

    it('produces a different lockout key for different company on the same instance', () => {
      const a = poolLockoutKey('https://hf.acumatica.com', 'api-bot', 'Heritage Fabrics');
      const b = poolLockoutKey('https://hf.acumatica.com', 'api-bot', 'Heritage Test');
      expect(a).not.toBe(b);
    });

    it('two pools sharing only the account name DO NOT share lockout state', () => {
      const hf = makePool({
        credentials: {
          baseUrl: 'https://hf.acumatica.com',
          username: 'api-bot',
          password: 'secret',
          tenant: 'Heritage Fabrics',
        },
      });
      const hfTest = makePool({
        credentials: {
          baseUrl: 'https://hf.acumatica.com',
          username: 'api-bot',
          password: 'secret',
          tenant: 'Heritage Test',
        },
      });
      expect(hf.lockoutKey).not.toBe(hfTest.lockoutKey);
      expect(hf.keyPrefix).not.toBe(hfTest.keyPrefix);
    });

    it('treats undefined company the same on every call (idempotent)', () => {
      const a = poolKeyPrefix('https://x.acumatica.com', 'api-bot', undefined);
      const b = poolKeyPrefix('https://x.acumatica.com', 'api-bot', undefined);
      expect(a).toBe(b);
    });
  });

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

  describe('backpressure', () => {
    it('should wait and retry when all slots checked out', async () => {
      const pool = makePool({ maxSize: 1, pollIntervalMs: 50 });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      // Checkout the only slot
      const handle1 = await pool.checkout();
      const slotId1 = handle1.slotId;

      // Start second checkout (will block)
      const checkoutPromise = pool.checkout();

      // Checkin after 200ms — should unblock second checkout
      setTimeout(() => pool.checkin(handle1), 200);

      const handle2 = await checkoutPromise;
      expect(handle2.slotId).toBe(slotId1);
      expect(loginMock).toHaveBeenCalledOnce(); // Reused, no new login
      await pool.checkin(handle2);
    });

    it('should throw SessionPoolExhaustedError on timeout', async () => {
      const pool = makePool({ maxSize: 1, checkoutTimeoutMs: 300, pollIntervalMs: 50 });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      // Checkout the only slot, don't checkin
      await pool.checkout();

      // Second checkout should timeout
      await expect(pool.checkout()).rejects.toThrow('Session pool exhausted');
    });
  });

  describe('keepalive', () => {
    it('should evict idle slots that return 401 on ping', async () => {
      const pool = makePool({ keepaliveMs: 100 });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      // Mock the keepalive ping to return 401 (session expired)
      const pingMock = vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
      pool._setPingFn(pingMock);

      // Checkout and checkin — slot is now idle in pool
      const handle = await pool.checkout();
      await pool.checkin(handle);

      let status = await pool.status();
      expect(status.activeSlots).toBe(1);

      // Start keepalive — should ping idle slot, get 401, evict
      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 200));
      pool.stopKeepalive();

      status = await pool.status();
      expect(status.activeSlots).toBe(0); // Evicted
      expect(pingMock).toHaveBeenCalled();
    });

    it('should not evict idle slots that respond successfully', async () => {
      const pool = makePool({ keepaliveMs: 100 });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      // Mock ping success
      const pingMock = vi.fn().mockResolvedValue(undefined);
      pool._setPingFn(pingMock);

      const handle = await pool.checkout();
      await pool.checkin(handle);

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 200));
      pool.stopKeepalive();

      const status = await pool.status();
      expect(status.activeSlots).toBe(1); // Still alive
    });

    it('should not ping checked-out slots', async () => {
      const pool = makePool({ keepaliveMs: 100 });
      const loginMock = vi.fn().mockResolvedValue('.ASPXAUTH=abc123');
      pool._setLoginFn(loginMock);

      const pingMock = vi.fn().mockResolvedValue(undefined);
      pool._setPingFn(pingMock);

      // Checkout but don't checkin — slot is busy
      await pool.checkout();

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 200));
      pool.stopKeepalive();

      expect(pingMock).not.toHaveBeenCalled();
    });
  });

  describe('onEvent', () => {
    it('should emit pool_exhausted when checkout times out', async () => {
      const events: Array<{ type: string; account: string }> = [];
      const pool = makePool({
        maxSize: 1,
        checkoutTimeoutMs: 200,
        pollIntervalMs: 50,
        onEvent: (e) => events.push(e),
      });
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

      await pool.checkout(); // Take the only slot
      await pool.checkout().catch(() => {}); // Should timeout

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('pool_exhausted');
      expect(events[0].account).toBe('api-bot');
    });

    it('should emit circuit_trip on AccountLockedError', async () => {
      const events: Array<{ type: string }> = [];
      const pool = makePool({ onEvent: (e) => events.push(e) });
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

      await pool.withSession(async () => {
        throw new AccountLockedError('locked');
      }).catch(() => {});

      expect(events.some((e) => e.type === 'circuit_trip')).toBe(true);
    });

    it('should emit slot_evicted on 401', async () => {
      const events: Array<{ type: string }> = [];
      const pool = makePool({ onEvent: (e) => events.push(e) });
      let call = 0;
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

      await pool.withSession(async () => {
        call++;
        if (call === 1) throw Object.assign(new Error('401'), { statusCode: 401 });
        return 'ok';
      });

      expect(events.some((e) => e.type === 'slot_evicted')).toBe(true);
    });

    it('should emit stale_reclaimed when reclaiming stale slot', async () => {
      const events: Array<{ type: string }> = [];
      const pool = makePool({ staleCheckoutMs: 100, onEvent: (e) => events.push(e) });
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

      await pool.checkout(); // Don't checkin
      await new Promise((r) => setTimeout(r, 150));
      await pool.checkout(); // Should reclaim stale

      expect(events.some((e) => e.type === 'stale_reclaimed')).toBe(true);
    });
  });
});
