/**
 * Tests for the session-pool orphan-slot leak fixes (v1.2.0).
 *
 * Root cause: withSession's outer finally called checkin() on an evicted slot.
 * CHECKIN_LUA uses HSET which creates the key even if DEL'd, producing a zombie
 * hash with no cookie and not in the :slots set. Observed in production as ~89
 * permanent Redis keys (2026-06-04).
 *
 * Three fixes:
 *   1. withSession skips checkin for evicted handles (_evictedSlotIds guard)
 *   2. CREATE_SLOT_LUA sets a defensive TTL on every slot hash
 *   3. reapOrphanSlots sweeps cookieless, not-in-set, stale hashes
 *
 * Rule #46/#223: tests invoke the REAL functions and use fake-Redis to capture
 * actual Redis ops, not mockResolvedValue-as-assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionPool, type SessionHandle } from '../session-pool.js';

// ---------------------------------------------------------------------------
// Fake Redis harness
// ---------------------------------------------------------------------------

/** In-memory Redis substitute that tracks calls and implements HSET/HGET/DEL/EXPIRE. */
function makeFakeRedis() {
  const store = new Map<string, Map<string, string>>();
  const ttls = new Map<string, number>(); // key → TTL in seconds (at set-time)
  const sets = new Map<string, Set<string>>();

  const ops: Array<{ op: string; key: string; args?: unknown }> = [];

  const fake = {
    // --- hash ops ---
    hset: vi.fn(async (key: string, ...fieldValues: string[]) => {
      if (!store.has(key)) store.set(key, new Map());
      const h = store.get(key)!;
      for (let i = 0; i < fieldValues.length; i += 2) {
        h.set(fieldValues[i], fieldValues[i + 1]);
      }
      ops.push({ op: 'HSET', key });
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => store.get(key)?.get(field) ?? null),
    hgetall: vi.fn(async (key: string) => {
      const h = store.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    }),
    del: vi.fn(async (...keys: string[]) => {
      ops.push({ op: 'DEL', key: keys.join(',') });
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
        sets.delete(k);
        ttls.delete(k);
      }
      return count;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      ops.push({ op: 'EXPIRE', key, args: seconds });
      return 1;
    }),

    // --- set ops ---
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      const s = sets.get(key)!;
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    }),
    scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),

    // --- string ops ---
    get: vi.fn(async (_key: string) => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),

    // --- SCAN ---
    scan: vi.fn(async (_cursor: string, _matchOp: string, pattern: string, _countOp: string, _count: number): Promise<[string, string[]]> => {
      // Return all keys matching the pattern
      const prefix = pattern.replace(/\*$/, '');
      const allKeys: string[] = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) allKeys.push(k);
      }
      return ['0', allKeys];
    }),

    // --- pipeline ---
    pipeline: vi.fn(() => ({
      del: vi.fn(function(this: any, key: string) {
        ops.push({ op: 'pipeline.DEL', key });
        store.delete(key);
        return this;
      }),
      exec: vi.fn(async () => []),
    })),

    // --- Lua eval --- (implements the actual Lua scripts in JS for testing)
    eval: vi.fn(async (script: string, _numKeys: number, ...args: string[]) => {
      // CHECKOUT_LUA
      if (script.includes('SMEMBERS') && script.includes('checkedOutBy')) {
        const slotsSetKey = args[0];
        const keyPrefix = args[1];
        const serviceId = args[2];
        const now = parseInt(args[3], 10);
        const staleMs = parseInt(args[4], 10);

        const slotIds = [...(sets.get(slotsSetKey) ?? [])];
        for (const sid of slotIds) {
          const sk = `${keyPrefix}:slot:${sid}`;
          const h = store.get(sk);
          const checkedOutBy = h?.get('checkedOutBy') ?? '';
          if (checkedOutBy === '') {
            h?.set('checkedOutBy', serviceId);
            h?.set('checkedOutAt', String(now));
            const cookie = h?.get('cookie') ?? '';
            return [sid, cookie];
          }
          const checkedOutAt = parseInt(h?.get('checkedOutAt') ?? '0', 10);
          if (checkedOutAt > 0 && (now - checkedOutAt) > staleMs) {
            h?.set('checkedOutBy', serviceId);
            h?.set('checkedOutAt', String(now));
            const cookie = h?.get('cookie') ?? '';
            return [sid, cookie];
          }
        }
        return [null];
      }

      // CREATE_SLOT_LUA
      if (script.includes('SADD') && script.includes('EXPIRE')) {
        const slotsSetKey = args[0];
        const slotHashKey = args[1];
        const slotId = args[2];
        const cookie = args[3];
        const serviceId = args[4];
        const now = args[5];
        const ttlSeconds = parseInt(args[6] ?? '0', 10);

        if (!sets.has(slotsSetKey)) sets.set(slotsSetKey, new Set());
        sets.get(slotsSetKey)!.add(slotId);

        store.set(slotHashKey, new Map([
          ['cookie', cookie],
          ['createdAt', now],
          ['lastUsedAt', now],
          ['checkedOutBy', serviceId],
          ['checkedOutAt', now],
        ]));
        ops.push({ op: 'CREATE_SLOT', key: slotHashKey });

        if (ttlSeconds > 0) {
          ttls.set(slotHashKey, ttlSeconds);
          ops.push({ op: 'EXPIRE', key: slotHashKey, args: ttlSeconds });
        }
        return 1;
      }

      // CHECKIN_LUA
      if (script.includes('checkedOutAt') && script.includes('lastUsedAt') && !script.includes('SADD')) {
        const slotKey = args[0];
        const now = args[1];
        if (!store.has(slotKey)) store.set(slotKey, new Map());
        const h = store.get(slotKey)!;
        h.set('checkedOutBy', '');
        h.set('checkedOutAt', '0');
        h.set('lastUsedAt', now);
        ops.push({ op: 'CHECKIN', key: slotKey });
        return 1;
      }

      // EVICT_SLOT_LUA
      if (script.includes('SREM') && script.includes('DEL')) {
        const slotsSetKey = args[0];
        const slotHashKey = args[1];
        const slotId = args[2];
        sets.get(slotsSetKey)?.delete(slotId);
        store.delete(slotHashKey);
        ops.push({ op: 'EVICT', key: slotHashKey });
        return 1;
      }

      return null;
    }),

    on: vi.fn(),
    quit: vi.fn(async () => 'OK'),

    // Expose internals for assertions
    _store: store,
    _sets: sets,
    _ttls: ttls,
    _ops: ops,
  };

  return fake;
}

// ---------------------------------------------------------------------------
// Pool factory
// ---------------------------------------------------------------------------

function makePool(
  fakeRedis: ReturnType<typeof makeFakeRedis>,
  overrides: Partial<ConstructorParameters<typeof SessionPool>[0]> = {},
) {
  const pool = new SessionPool({
    account: 'api-bot',
    maxSize: 3,
    credentials: {
      baseUrl: 'https://test.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'TestTenant',
    },
    redisUrl: 'redis://localhost:6379',
    serviceId: 'test-service',
    staleCheckoutMs: 1000,
    slotTtlMs: 7_200_000, // 2h
    ...overrides,
  });
  // Inject fake Redis
  (pool as unknown as Record<string, unknown>)['redis'] = fakeRedis;
  return pool;
}

// ---------------------------------------------------------------------------
// Fix 1: withSession does NOT leave an orphan after 401 eviction
// ---------------------------------------------------------------------------

describe('Fix 1 — withSession skips checkin for evicted handles (401 retry)', () => {
  it('does NOT call CHECKIN on the evicted slot ID after a 401 eviction', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis);
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie1; .ASPXAUTH=cookie2'));

    let call = 0;
    const result = await pool.withSession(async (handle) => {
      call++;
      if (call === 1) {
        // Save slot ID for later assertion
        (pool as any)._testSlotId = handle.slotId;
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(call).toBe(2);

    // The evicted slot ID should NOT appear as a CHECKIN target in the ops log.
    // If CHECKIN fires on it, it would recreate the zombie hash.
    const evictedSlotId = (pool as any)._testSlotId as string;
    const evictedSlotKey = `${pool.keyPrefix}:slot:${evictedSlotId}`;

    const checkinAfterEvict = redis._ops.filter(
      (op) => op.op === 'CHECKIN' && op.key === evictedSlotKey,
    );
    expect(checkinAfterEvict).toHaveLength(0);

    // Confirm EVICT fired for that slot
    const evictOps = redis._ops.filter(
      (op) => op.op === 'EVICT' && op.key === evictedSlotKey,
    );
    expect(evictOps.length).toBeGreaterThan(0);

    // Confirm the evicted slot hash does NOT exist in the store
    expect(redis._store.has(evictedSlotKey)).toBe(false);
  });

  it('_evictedSlotIds is cleared after withSession completes', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis);
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

    let call = 0;
    await pool.withSession(async () => {
      call++;
      if (call === 1) throw Object.assign(new Error('401'), { statusCode: 401 });
      return 'ok';
    });

    // After the call, the set should be empty (cleaned up in finally)
    expect(pool._evictedSlotIds.size).toBe(0);
  });

  it('normal (non-401) withSession still calls checkin on the handle', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis);
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

    let capturedSlotId = '';
    await pool.withSession(async (handle) => {
      capturedSlotId = handle.slotId;
      return 'ok';
    });

    const slotKey = `${pool.keyPrefix}:slot:${capturedSlotId}`;
    const checkinOps = redis._ops.filter((op) => op.op === 'CHECKIN' && op.key === slotKey);
    expect(checkinOps.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: CREATE_SLOT_LUA sets a defensive TTL on every new slot hash
// ---------------------------------------------------------------------------

describe('Fix 2 — slot hash gets a defensive TTL on creation', () => {
  it('a non-zero slotTtlMs causes EXPIRE to be set on the slot hash', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { slotTtlMs: 3_600_000 }); // 1h
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

    const handle = await pool.checkout();
    await pool.checkin(handle);

    const slotHashKey = `${pool.keyPrefix}:slot:${handle.slotId}`;
    const expireOps = redis._ops.filter((op) => op.op === 'EXPIRE' && op.key === slotHashKey);
    expect(expireOps.length).toBeGreaterThan(0);

    // TTL should be 3600 seconds (1h)
    const ttl = redis._ttls.get(slotHashKey);
    expect(ttl).toBe(3600);
  });

  it('slotTtlMs=0 disables the TTL (no EXPIRE call)', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { slotTtlMs: 0 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

    const handle = await pool.checkout();
    await pool.checkin(handle);

    const slotHashKey = `${pool.keyPrefix}:slot:${handle.slotId}`;
    const expireOps = redis._ops.filter((op) => op.op === 'EXPIRE' && op.key === slotHashKey);
    expect(expireOps).toHaveLength(0);
  });

  it('default slotTtlMs (2h = 7200s) is applied when not overridden', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis); // uses default 7_200_000ms
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=abc'));

    const handle = await pool.checkout();
    await pool.checkin(handle);

    const slotHashKey = `${pool.keyPrefix}:slot:${handle.slotId}`;
    const ttl = redis._ttls.get(slotHashKey);
    expect(ttl).toBe(7200);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: reapOrphanSlots removes zombies, preserves valid slots
// ---------------------------------------------------------------------------

describe('Fix 3 — reapOrphanSlots', () => {
  it('removes a cookieless, not-in-set, stale orphan hash', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { staleCheckoutMs: 1000 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

    // Manually insert an orphan hash: not in :slots set, no cookie, old timestamp
    const orphanKey = `${pool.keyPrefix}:slot:orphan-old`;
    redis._store.set(orphanKey, new Map([
      ['checkedOutBy', ''],
      ['checkedOutAt', '0'],
      ['lastUsedAt', String(Date.now() - 5000)], // 5s ago > staleCheckoutMs(1s)
    ]));
    // Not added to the :slots set

    const reaped = await pool.reapOrphanSlots();
    expect(reaped).toBe(1);
    expect(redis._store.has(orphanKey)).toBe(false);
  });

  it('preserves an active cookied slot that IS in the :slots set', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { staleCheckoutMs: 1000 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=live-cookie'));

    // Create a real slot via checkout
    const handle = await pool.checkout();
    const slotHashKey = `${pool.keyPrefix}:slot:${handle.slotId}`;

    // Confirm it's in the :slots set
    const inSet = redis._sets.get(`${pool.keyPrefix}:slots`)?.has(handle.slotId);
    expect(inSet).toBe(true);

    const reaped = await pool.reapOrphanSlots();
    expect(reaped).toBe(0);

    // Slot still exists with its cookie
    expect(redis._store.has(slotHashKey)).toBe(true);
    expect(redis._store.get(slotHashKey)?.get('cookie')).toBe('.ASPXAUTH=live-cookie');
  });

  it('preserves a recent cookieless orphan (within staleCheckoutMs — mid-acquire race)', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { staleCheckoutMs: 120_000 }); // 2 min
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

    // Orphan with a very recent lastUsedAt (just now)
    const recentOrphanKey = `${pool.keyPrefix}:slot:orphan-recent`;
    redis._store.set(recentOrphanKey, new Map([
      ['checkedOutBy', 'test-service'],
      ['checkedOutAt', String(Date.now())],
      ['lastUsedAt', String(Date.now())], // right now — within stale window
    ]));

    const reaped = await pool.reapOrphanSlots();
    expect(reaped).toBe(0);
    expect(redis._store.has(recentOrphanKey)).toBe(true); // preserved
  });

  it('reaps multiple orphans in one call', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { staleCheckoutMs: 100 });
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

    const oldTs = String(Date.now() - 10_000);
    for (let i = 0; i < 5; i++) {
      const key = `${pool.keyPrefix}:slot:orphan-${i}`;
      redis._store.set(key, new Map([
        ['checkedOutBy', ''],
        ['lastUsedAt', oldTs],
      ]));
    }

    const reaped = await pool.reapOrphanSlots();
    expect(reaped).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(redis._store.has(`${pool.keyPrefix}:slot:orphan-${i}`)).toBe(false);
    }
  });

  it('reapOrphanSlots returns 0 in degraded mode (no Redis)', async () => {
    const pool = new SessionPool({
      account: 'api-bot',
      maxSize: 3,
      credentials: {
        baseUrl: 'https://test.acumatica.com',
        username: 'api-bot',
        password: 'secret',
        tenant: 'TestTenant',
      },
      redisUrl: '', // degraded mode
      serviceId: 'test-service',
    });

    const reaped = await pool.reapOrphanSlots();
    expect(reaped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 + 3 combined: after a 401 cycle, reaper cleans any residual orphan
// ---------------------------------------------------------------------------

describe('Combined: 401 cycle + reaper cleans any stale remnants', () => {
  it('after a 401 withSession cycle, reaper finds nothing (fix 1 prevents creation)', async () => {
    const redis = makeFakeRedis();
    const pool = makePool(redis, { staleCheckoutMs: 0 }); // staleMs=0 means any age is stale
    pool._setLoginFn(vi.fn().mockResolvedValue('.ASPXAUTH=cookie'));

    let call = 0;
    await pool.withSession(async (handle) => {
      call++;
      if (call === 1) {
        (pool as any)._testSlotId = handle.slotId;
        throw Object.assign(new Error('401'), { statusCode: 401 });
      }
      return 'ok';
    });

    // Reaper should find zero orphans because fix 1 prevented creation
    const reaped = await pool.reapOrphanSlots();
    expect(reaped).toBe(0);
  });
});
