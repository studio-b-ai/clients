/**
 * Login-time lockout backoff (incident 2026-11-14 / 2026-11-17, api-bot).
 *
 * When Acumatica refuses a pool login ("locked out" or "account is disabled"),
 * the pool must stop logging in for a while instead of trying again on every
 * request. Before this fix the refusal was thrown from checkout(), outside
 * withSession's try block, so the circuit breaker never tripped and each
 * request opened a fresh login (30-77 logins/min in production).
 *
 * Every test drives the real checkout()/withSession(); login is replaced via
 * _setLoginFn (or a mocked undici for the classification tests) and the
 * assertions read what the mocks captured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { AccountLockedError } from '../error-handler.js';

const REDIS_DOWN = "Stream isn't writeable and enableOfflineQueue options is false";

/** Shared across FakeRedis instances, so two pools behave like two replicas on one Redis. */
const store = new Map<string, string>();

class FakeRedis extends EventEmitter {
  static instances: FakeRedis[] = [];
  static startReady = true;
  // pg-enum-drift-exempt: ioredis connection state, not a Postgres column
  status = FakeRedis.startReady ? 'ready' : 'connecting';
  get = vi.fn(async (key: string) => store.get(key) ?? null);
  set = vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (args.includes('NX') && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  });
  // CHECKOUT_LUA → no free slot; CREATE_SLOT_LUA → ignored.
  eval = vi.fn(async () => [null]);
  scard = vi.fn(async () => 0);
  smembers = vi.fn(async () => [] as string[]);
  hgetall = vi.fn(async () => ({}));
  constructor() {
    super();
    FakeRedis.instances.push(this);
  }
}
vi.mock('ioredis', () => ({ Redis: FakeRedis }));

const undiciRequest = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => undiciRequest(...args) }));

const { SessionPool } = await import('../session-pool.js');

function makeLogger() {
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log;
}

function makePool(overrides: Record<string, unknown> = {}) {
  const log = makeLogger();
  const onEvent = vi.fn();
  const pool = new SessionPool({
    account: 'api-bot',
    maxSize: 3,
    credentials: {
      baseUrl: 'https://test.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'TestTenant',
    },
    redisUrl: '', // degraded (in-memory) mode unless a test passes a URL
    serviceId: 'test-service',
    pollIntervalMs: 5,
    checkoutTimeoutMs: 200,
    logger: log as unknown as Logger,
    onEvent,
    ...overrides,
  });
  return { pool, log, onEvent };
}

const lockedOut = () => new AccountLockedError('Acumatica account locked out during pool login.');

function fakeResponse(statusCode: number, text: string) {
  return { statusCode, headers: {}, body: { text: async () => text } };
}

beforeEach(() => {
  FakeRedis.instances.length = 0;
  FakeRedis.startReady = true;
  store.clear();
  undiciRequest.mockReset();
});

describe('SessionPool login lockout backoff', () => {
  it('a refused login blocks the next checkouts without logging in again (degraded mode)', async () => {
    const { pool, log, onEvent } = makePool();
    const login = vi.fn().mockRejectedValue(lockedOut());
    pool._setLoginFn(login);

    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    await expect(pool.withSession(async () => 'never')).rejects.toBeInstanceOf(AccountLockedError);

    expect(login).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'api-bot', backoffMs: 60_000 }),
      expect.stringContaining('pausing new logins'),
    );
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'circuit_trip' }));
    // Short backoff, not the 10-minute breaker: recovery after a manual unlock stays fast.
    expect(pool.circuitBreaker.isOpen).toBe(false);
  });

  it('in Redis mode, a refused login writes the shared lockout key (NX, 60s) so other replicas stop too', async () => {
    const a = makePool({ redisUrl: 'redis://redis.internal:6379' });
    const loginA = vi.fn().mockRejectedValue(lockedOut());
    a.pool._setLoginFn(loginA);

    await expect(a.pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    expect(loginA).toHaveBeenCalledTimes(1);

    const redisA = FakeRedis.instances[0];
    expect(redisA.set).toHaveBeenCalledTimes(1);
    const [key, value, ...args] = redisA.set.mock.calls[0];
    expect(key).toBe(a.pool.lockoutKey);
    expect(Number.isNaN(Date.parse(value))).toBe(false);
    expect(args).toEqual(['PX', 60_000, 'NX']);

    // A second pool (another replica) on the same Redis never attempts a login.
    const b = makePool({ redisUrl: 'redis://redis.internal:6379' });
    const loginB = vi.fn().mockResolvedValue('.ASPXAUTH=b');
    b.pool._setLoginFn(loginB);
    await expect(b.pool.checkout()).rejects.toThrow(/Redis guard/);
    expect(loginB).not.toHaveBeenCalled();
  });

  it('negative control: a generic login failure does not pause logins', async () => {
    const { pool, onEvent } = makePool();
    const login = vi
      .fn()
      .mockRejectedValueOnce(new Error('Pool login failed: HTTP 503 — upstream'))
      .mockResolvedValueOnce('.ASPXAUTH=ok');
    pool._setLoginFn(login);

    await expect(pool.checkout()).rejects.toThrow(/HTTP 503/);
    const handle = await pool.checkout();

    expect(handle.cookie).toBe('.ASPXAUTH=ok');
    expect(login).toHaveBeenCalledTimes(2);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'circuit_trip' }));
  });

  it('the pause ends after loginLockoutBackoffMs and the next checkout logs in again', async () => {
    const { pool } = makePool({ loginLockoutBackoffMs: 40 });
    const login = vi
      .fn()
      .mockRejectedValueOnce(lockedOut())
      .mockResolvedValueOnce('.ASPXAUTH=after-unlock');
    pool._setLoginFn(login);

    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    expect(login).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 60));
    const handle = await pool.checkout();
    expect(handle.cookie).toBe('.ASPXAUTH=after-unlock');
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('degraded mode never runs more logins at once than maxSize', async () => {
    const { pool } = makePool({ maxSize: 2, checkoutTimeoutMs: 120 });
    let inFlight = 0;
    let peak = 0;
    const login = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return '.ASPXAUTH=slow';
    });
    pool._setLoginFn(login);

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => pool.checkout()));

    expect(peak).toBeLessThanOrEqual(2);
    expect(login).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
  });
});

describe('SessionPool login error classification (real HTTP path, undici mocked)', () => {
  it('"Your account is disabled" (HTTP 500) is a lockout and pauses logins', async () => {
    const { pool } = makePool();
    undiciRequest.mockResolvedValue(
      fakeResponse(500, '{"message":"An error has occurred.","exceptionMessage":"Your account is disabled."}'),
    );

    const err = await pool.checkout().catch((e) => e);
    expect(err).toBeInstanceOf(AccountLockedError);
    expect((err as Error).message).toMatch(/disabled/);

    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    expect(undiciRequest).toHaveBeenCalledTimes(1);
  });

  it('"locked out" (HTTP 500) is still a lockout', async () => {
    const { pool } = makePool();
    undiciRequest.mockResolvedValue(fakeResponse(500, 'Your account is locked out.'));

    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    await expect(pool.checkout()).rejects.toBeInstanceOf(AccountLockedError);
    expect(undiciRequest).toHaveBeenCalledTimes(1);
  });

  it('negative control: any other HTTP 500 is a plain error and does not pause logins', async () => {
    const { pool } = makePool();
    undiciRequest.mockResolvedValue(fakeResponse(500, 'Some other server error'));

    const err = await pool.checkout().catch((e) => e);
    expect(err).not.toBeInstanceOf(AccountLockedError);
    expect((err as Error).message).toMatch(/Pool login failed: HTTP 500/);

    await expect(pool.checkout()).rejects.toThrow(/Pool login failed: HTTP 500/);
    expect(undiciRequest).toHaveBeenCalledTimes(2);
  });
});

describe('SessionPool degraded flips are logged', () => {
  it('logs a warning when the converge sweep loses Redis during smembers', async () => {
    const { pool, log } = makePool({
      redisUrl: 'redis://redis.internal:6379',
      convergeIdleToMaxSize: true,
    });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=ok'));
    await pool.checkout(); // creates the Redis client
    FakeRedis.instances[0].smembers.mockRejectedValueOnce(new Error(REDIS_DOWN));

    await (pool as unknown as { convergeIdleSlots(): Promise<void> }).convergeIdleSlots();

    expect((await pool.status()).degraded).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: REDIS_DOWN }),
      expect.stringContaining('degraded'),
    );
  });

  it('logs a warning when the converge sweep loses Redis during evict-if-idle', async () => {
    const { pool, log } = makePool({
      redisUrl: 'redis://redis.internal:6379',
      convergeIdleToMaxSize: true,
      maxSize: 1,
    });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=ok'));
    await pool.checkout();
    const redis = FakeRedis.instances[0];
    redis.smembers.mockResolvedValueOnce(['slot-1', 'slot-2']);
    redis.eval.mockRejectedValueOnce(new Error(REDIS_DOWN));

    await (pool as unknown as { convergeIdleSlots(): Promise<void> }).convergeIdleSlots();

    expect((await pool.status()).degraded).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: REDIS_DOWN }),
      expect.stringContaining('degraded'),
    );
  });
});
