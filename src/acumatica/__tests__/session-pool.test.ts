import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionPool,
  poolKeyPrefix,
  poolLockoutKey,
  type SessionHandle,
  type PoolEvent,
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

/**
 * Seed an idle (or checked-out) local slot directly, simulating EXCESS slots
 * that exist above maxSize — e.g. inherited from a peak before maxSize was
 * lowered, or created cross-process on a shared Redis set. checkout() would
 * backpressure at maxSize, so direct seeding is the only way to construct the
 * "more live slots than maxSize" state convergence is built to drain.
 */
function seedIdleLocalSlot(pool: SessionPool, id: string, cookie: string, checkedOutBy = ''): void {
  (pool as unknown as {
    localSlots: Map<string, { cookie: string; checkedOutBy: string; checkedOutAt: number; createdAt: number }>;
  }).localSlots.set(id, {
    cookie,
    checkedOutBy,
    checkedOutAt: checkedOutBy ? Date.now() : 0,
    createdAt: Date.now(),
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

  describe('convergeIdleToMaxSize (shed excess idle slots)', () => {
    function localSize(pool: SessionPool): number {
      return (pool as unknown as { localSlots: Map<string, unknown> }).localSlots.size;
    }

    it('sheds excess idle slots down to maxSize and logs each out', async () => {
      const pool = makePool({ maxSize: 2, keepaliveMs: 50, convergeIdleToMaxSize: true });
      pool._setPingFn(vi.fn().mockResolvedValue(undefined)); // ping success → no 401 eviction
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      pool._setLogoutFn(logoutMock);

      for (let i = 0; i < 5; i++) seedIdleLocalSlot(pool, `slot-${i}`, `.ASPXAUTH=cookie${i}`);
      expect(localSize(pool)).toBe(5);

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 150));
      pool.stopKeepalive();

      expect(localSize(pool)).toBe(2); // converged to maxSize
      expect(logoutMock).toHaveBeenCalledTimes(3); // 3 excess sessions logged out
    });

    it('never evicts a checked-out slot', async () => {
      const pool = makePool({ maxSize: 2, keepaliveMs: 50, convergeIdleToMaxSize: true });
      pool._setPingFn(vi.fn().mockResolvedValue(undefined));
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      pool._setLogoutFn(logoutMock);

      seedIdleLocalSlot(pool, 'busy', '.ASPXAUTH=busy', 'in-use'); // checked out
      seedIdleLocalSlot(pool, 'idle-1', '.ASPXAUTH=i1');
      seedIdleLocalSlot(pool, 'idle-2', '.ASPXAUTH=i2');
      seedIdleLocalSlot(pool, 'idle-3', '.ASPXAUTH=i3'); // 4 slots, excess = 2

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 150));
      pool.stopKeepalive();

      const slots = (pool as unknown as { localSlots: Map<string, unknown> }).localSlots;
      expect(slots.has('busy')).toBe(true); // checked-out slot survives
      expect(slots.size).toBe(2); // shed 2 of the 3 idle
      expect(logoutMock).toHaveBeenCalledTimes(2); // only idle slots logged out
    });

    it('is a no-op when the flag is off', async () => {
      const pool = makePool({ maxSize: 2, keepaliveMs: 50 }); // convergeIdleToMaxSize default false
      pool._setPingFn(vi.fn().mockResolvedValue(undefined));
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      pool._setLogoutFn(logoutMock);

      for (let i = 0; i < 5; i++) seedIdleLocalSlot(pool, `slot-${i}`, `.ASPXAUTH=cookie${i}`);

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 150));
      pool.stopKeepalive();

      expect(localSize(pool)).toBe(5); // untouched
      expect(logoutMock).not.toHaveBeenCalled();
    });

    it('is a no-op when slot count is at or under maxSize', async () => {
      const pool = makePool({ maxSize: 5, keepaliveMs: 50, convergeIdleToMaxSize: true });
      pool._setPingFn(vi.fn().mockResolvedValue(undefined));
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      pool._setLogoutFn(logoutMock);

      for (let i = 0; i < 3; i++) seedIdleLocalSlot(pool, `slot-${i}`, `.ASPXAUTH=cookie${i}`);

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 150));
      pool.stopKeepalive();

      expect(localSize(pool)).toBe(3);
      expect(logoutMock).not.toHaveBeenCalled();
    });

    it('still evicts when the logout call fails (fail-open)', async () => {
      const pool = makePool({ maxSize: 2, keepaliveMs: 50, convergeIdleToMaxSize: true });
      pool._setPingFn(vi.fn().mockResolvedValue(undefined));
      const logoutMock = vi.fn().mockRejectedValue(new Error('logout 500'));
      pool._setLogoutFn(logoutMock);

      for (let i = 0; i < 4; i++) seedIdleLocalSlot(pool, `slot-${i}`, `.ASPXAUTH=cookie${i}`);

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 150));
      pool.stopKeepalive();

      expect(localSize(pool)).toBe(2); // slots evicted despite logout failure
      expect(logoutMock).toHaveBeenCalledTimes(2); // logout was attempted
    });

    it('emits slot_evicted for each shed slot', async () => {
      const events: PoolEvent[] = [];
      const pool = makePool({
        maxSize: 1,
        keepaliveMs: 50,
        convergeIdleToMaxSize: true,
        onEvent: (e) => events.push(e),
      });
      pool._setPingFn(vi.fn().mockResolvedValue(undefined));
      pool._setLogoutFn(vi.fn().mockResolvedValue(undefined));

      seedIdleLocalSlot(pool, 'a', '.ASPXAUTH=a');
      seedIdleLocalSlot(pool, 'b', '.ASPXAUTH=b'); // excess = 1

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 150));
      pool.stopKeepalive();

      expect(events.filter((e) => e.type === 'slot_evicted')).toHaveLength(1);
    });

    it('still sheds excess idle slots when pingIdleSlots hangs (converge decoupled from ping)', async () => {
      // Reproduces the 2026-06-09 prod bug: a hung auth-endpoint ping (Acumatica
      // Sign-In-limit throttle, Rule #311) must NOT starve convergeIdleSlots. The
      // pingFn never resolves; under the old sequential ping-THEN-converge cycle this
      // left the pool stuck above maxSize forever (prod: 5 idle vs maxSize 4 for 23d).
      // Decoupled, converge still runs every cycle and sheds.
      const pool = makePool({ maxSize: 2, keepaliveMs: 50, convergeIdleToMaxSize: true });
      pool._setPingFn(vi.fn(() => new Promise<void>(() => {}))); // hangs forever
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      pool._setLogoutFn(logoutMock);

      for (let i = 0; i < 5; i++) seedIdleLocalSlot(pool, `slot-${i}`, `.ASPXAUTH=cookie${i}`);
      expect(localSize(pool)).toBe(5);

      pool.startKeepalive();
      await new Promise((r) => setTimeout(r, 200));
      pool.stopKeepalive();

      expect(localSize(pool)).toBe(2); // converged to maxSize despite the hung ping
      expect(logoutMock).toHaveBeenCalledTimes(3);
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

  /**
   * Redis synchronous-throw race condition (SessionPool v1.1.x fix).
   *
   * When `enableOfflineQueue=false` and the Redis socket disconnects, ioredis
   * throws synchronously from `redis.eval()` / `redis.scard()` BEFORE the
   * async 'error' event fires.  At throw time `this.degraded` is still false,
   * so without explicit try/catch around each Redis call the
   * `degradedCheckout()` fallback was never triggered and the error propagated
   * to every gateway caller.
   *
   * These tests use a pool wired with a fake Redis client whose eval/scard
   * methods throw the exact ioredis offline-queue error string observed in
   * bolt-wms Railway logs on 2026-05-16.
   */
  describe('Redis connection error race — degraded fallback (v1.1.x fix)', () => {
    /** Build a pool whose internal redis client is replaced with a stub. */
    function makePoolWithFakeRedis(
      fakeRedis: Partial<Record<string, unknown>>,
      overrides: Partial<ConstructorParameters<typeof SessionPool>[0]> = {},
    ) {
      const pool = makePool({ redisUrl: 'redis://localhost:6379', ...overrides });
      // Inject the fake redis by overriding the private field after construction.
      // This is safe in tests — we want to control exactly what Redis does.
      (pool as unknown as Record<string, unknown>)['redis'] = fakeRedis;
      return pool;
    }

    const OFFLINE_QUEUE_ERROR = "Stream isn't writeable and enableOfflineQueue options is false";

    it('CHECKOUT_LUA eval throw: sets degraded=true and returns degradedCheckout result', async () => {
      const fakeRedis = {
        // Lockout check — return null (no lockout)
        get: vi.fn().mockResolvedValue(null),
        // CHECKOUT_LUA eval — throw synchronously (simulates socket disconnect)
        eval: vi.fn().mockRejectedValue(new Error(OFFLINE_QUEUE_ERROR)),
      };

      const pool = makePoolWithFakeRedis(fakeRedis);
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));

      const handle = await pool.checkout();

      // Must have fallen back to degraded mode
      expect(handle.degraded).toBe(true);
      expect(handle.cookie).toBe('.ASPXAUTH=degraded-cookie');
      // Pool must be marked degraded so subsequent calls skip Redis
      const status = await pool.status();
      expect(status.degraded).toBe(true);
    });

    it('scard throw: sets degraded=true and returns degradedCheckout result', async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(null),
        // CHECKOUT_LUA returns no slot (empty pool)
        eval: vi.fn().mockResolvedValue([null]),
        // scard — throw synchronously (simulates socket disconnect)
        scard: vi.fn().mockRejectedValue(new Error(OFFLINE_QUEUE_ERROR)),
      };

      const pool = makePoolWithFakeRedis(fakeRedis);
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));

      const handle = await pool.checkout();

      expect(handle.degraded).toBe(true);
      expect(handle.cookie).toBe('.ASPXAUTH=degraded-cookie');
      const status = await pool.status();
      expect(status.degraded).toBe(true);
    });

    it('CREATE_SLOT_LUA eval throw: sets degraded=true and returns handle with already-obtained cookie', async () => {
      let evalCallCount = 0;
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockImplementation(() => {
          evalCallCount++;
          if (evalCallCount === 1) {
            // First eval = CHECKOUT_LUA — no slot available
            return Promise.resolve([null]);
          }
          // Second eval = CREATE_SLOT_LUA — throw connection error
          return Promise.reject(new Error(OFFLINE_QUEUE_ERROR));
        }),
        // scard returns 0 — under capacity, triggers login + CREATE_SLOT_LUA
        scard: vi.fn().mockResolvedValue(0),
      };

      const pool = makePoolWithFakeRedis(fakeRedis);
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=fresh-cookie'));

      const handle = await pool.checkout();

      // Cookie must still be returned (login already happened before the throw)
      expect(handle.degraded).toBe(true);
      expect(handle.cookie).toBe('.ASPXAUTH=fresh-cookie');
      const status = await pool.status();
      expect(status.degraded).toBe(true);
    });

    it('ECONNRESET pattern is also detected as a connection error', async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockRejectedValue(new Error('read ECONNRESET')),
      };

      const pool = makePoolWithFakeRedis(fakeRedis);
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));

      const handle = await pool.checkout();
      expect(handle.degraded).toBe(true);
    });

    it('MaxRetriesPerRequestError (ioredis in-flight exhaustion) is treated as connection error', async () => {
      // When a Redis command is in-flight during a disconnect and
      // maxRetriesPerRequest (1) is exhausted, ioredis rejects with this message.
      // Must fall back to degraded, not propagate to callers.
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockRejectedValue(
          new Error('Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.'),
        ),
      };

      const pool = makePoolWithFakeRedis(fakeRedis);
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));

      const handle = await pool.checkout();
      expect(handle.degraded).toBe(true);
      const status = await pool.status();
      expect(status.degraded).toBe(true);
    });

    it('unrelated Redis error (e.g. WRONGTYPE) is NOT swallowed — propagates', async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockRejectedValue(new Error('WRONGTYPE Operation against a key holding the wrong kind of value')),
        // Stub remaining Redis methods so status() works if called
        smembers: vi.fn().mockResolvedValue([]),
      };

      const pool = makePoolWithFakeRedis(fakeRedis);
      pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

      // The non-connection error must propagate — not silently converted to degraded
      await expect(pool.checkout()).rejects.toThrow('WRONGTYPE');
      // Pool must NOT be marked degraded — this.degraded stays false
      // We verify by checking the 'degraded' field directly on the private state
      // via status(): since redis is still set and this.degraded is false,
      // status() will try to use Redis. In this test the redis smembers stub
      // returns [], so the status call succeeds with degraded=false.
      const status = await pool.status();
      expect(status.degraded).toBe(false);
    });
  });
});
