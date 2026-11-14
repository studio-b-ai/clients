/**
 * Startup race + recovery (2026-11-14, studiob-api prod).
 *
 * The pool creates its Redis client lazily on the FIRST checkout, with
 * enableOfflineQueue=false. That first checkout then sent CHECKOUT_LUA before
 * the socket was 'ready', ioredis rejected it ("Stream isn't writeable …"),
 * and the pool went degraded — and stayed degraded until the process
 * restarted. Degraded pools keep sessions in memory only, so two pools on the
 * same Acumatica user stop seeing each other's seats and can exceed the
 * license's concurrent-login cap together.
 *
 * These tests replace ioredis with a controllable fake so the real
 * getRedis() → checkout() path runs against a client that is still
 * connecting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const OFFLINE_QUEUE_ERROR = "Stream isn't writeable and enableOfflineQueue options is false";

class FakeRedis extends EventEmitter {
  static instances: FakeRedis[] = [];
  // pg-enum-drift-exempt: ioredis connection state, not a Postgres column
  status = 'connecting';
  opts: Record<string, unknown>;

  get = vi.fn(async () => {
    if (this.status !== 'ready') throw new Error(OFFLINE_QUEUE_ERROR);
    return null;
  });

  eval = vi.fn(async () => {
    if (this.status !== 'ready') throw new Error(OFFLINE_QUEUE_ERROR);
    return ['slot-redis-1', '.ASPXAUTH=redis-cookie'];
  });

  scard = vi.fn(async () => 0);
  smembers = vi.fn(async () => []);
  hgetall = vi.fn(async () => ({}));

  constructor(_url: string, opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    FakeRedis.instances.push(this);
  }

  becomeReady(): void {
    // pg-enum-drift-exempt: ioredis connection state, not a Postgres column
    this.status = 'ready';
    this.emit('ready');
  }
}

vi.mock('ioredis', () => ({ Redis: FakeRedis }));

const { SessionPool } = await import('../session-pool.js');

function makePool(overrides: Record<string, unknown> = {}) {
  return new SessionPool({
    account: 'api-bot',
    maxSize: 3,
    credentials: {
      baseUrl: 'https://test.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'TestTenant',
    },
    redisUrl: 'redis://redis.internal:6379',
    serviceId: 'test-service',
    ...overrides,
  });
}

function localSlotCount(pool: unknown): number {
  return (pool as { localSlots: Map<string, unknown> }).localSlots.size;
}

describe('SessionPool — Redis startup race and recovery', () => {
  beforeEach(() => {
    FakeRedis.instances.length = 0;
  });

  it('first checkout on a still-connecting client waits for ready instead of degrading', async () => {
    const pool = makePool();
    const login = vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie');
    pool._setLoginFn(login);

    const pending = pool.checkout();
    // The client is created inside checkout(); let it connect a moment later.
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeRedis.instances).toHaveLength(1);
    FakeRedis.instances[0].becomeReady();

    const handle = await pending;
    expect(handle.degraded).toBe(false);
    expect(handle.slotId).toBe('slot-redis-1');
    expect(login).not.toHaveBeenCalled();
    expect((await pool.status()).degraded).toBe(false);
  });

  it('falls back to a degraded checkout when Redis is not ready within redisReadyTimeoutMs', async () => {
    const pool = makePool({ redisReadyTimeoutMs: 40 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));

    const started = Date.now();
    const handle = await pool.checkout();
    expect(handle.degraded).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leaves degraded mode when Redis becomes ready, and logs out idle in-memory sessions', async () => {
    const pool = makePool({ redisReadyTimeoutMs: 20 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));
    const logout = vi.fn().mockResolvedValue(undefined);
    pool._setLogoutFn(logout);

    const h1 = await pool.checkout();
    expect(h1.degraded).toBe(true);
    await pool.checkin(h1);
    expect(localSlotCount(pool)).toBe(1);

    FakeRedis.instances[0].becomeReady();
    await new Promise((r) => setTimeout(r, 0));

    expect((await pool.status()).degraded).toBe(false);
    expect(localSlotCount(pool)).toBe(0);
    expect(logout).toHaveBeenCalledWith('.ASPXAUTH=degraded-cookie');

    // The next checkout is coordinated through Redis again.
    const h2 = await pool.checkout();
    expect(h2.degraded).toBe(false);
    expect(h2.slotId).toBe('slot-redis-1');
  });

  it('a degraded handle checked in after recovery is logged out, not re-pooled in memory', async () => {
    const pool = makePool({ redisReadyTimeoutMs: 20 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=held-cookie'));
    const logout = vi.fn().mockResolvedValue(undefined);
    pool._setLogoutFn(logout);

    const held = await pool.checkout();
    expect(held.degraded).toBe(true);

    FakeRedis.instances[0].becomeReady();
    await new Promise((r) => setTimeout(r, 0));
    // Still checked out at recovery time, so it is not logged out yet.
    expect(logout).not.toHaveBeenCalled();

    await pool.checkin(held);
    expect(localSlotCount(pool)).toBe(0);
    expect(logout).toHaveBeenCalledWith('.ASPXAUTH=held-cookie');
  });

  it('a Redis error after ready degrades the pool, and the next ready recovers it', async () => {
    const pool = makePool();
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));
    const pending = pool.checkout();
    await new Promise((r) => setTimeout(r, 10));
    const client = FakeRedis.instances[0];
    client.becomeReady();
    await pending;

    // pg-enum-drift-exempt: ioredis connection state, not a Postgres column
    client.status = 'reconnecting';
    client.emit('error', new Error('read ECONNRESET'));
    expect((await pool.status()).degraded).toBe(true);

    client.becomeReady();
    await new Promise((r) => setTimeout(r, 0));
    expect((await pool.status()).degraded).toBe(false);
  });

  it('keeps retrying the Redis connection instead of giving up after a few attempts', async () => {
    const pool = makePool({ redisReadyTimeoutMs: 10 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=degraded-cookie'));
    await pool.checkout();

    const retry = FakeRedis.instances[0].opts.retryStrategy as (times: number) => number | null;
    expect(retry(3)).not.toBeNull();
    expect(retry(50)).not.toBeNull();
    expect(retry(50)).toBeLessThanOrEqual(5_000);
  });
});
