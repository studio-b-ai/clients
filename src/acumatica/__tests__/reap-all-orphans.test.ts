/**
 * Tests for reapAllOrphanSlots — the cross-prefix orphan sweep.
 *
 * The per-pool SessionPool.reapOrphanSlots only sweeps its own prefix; this
 * function sweeps `acumatica:pool:*:slot:*` across ALL prefixes (the gap that
 * left 89 legacy orphans under a defunct prefix on 2026-06-07). Same safety
 * invariants as the per-pool reaper PLUS an atomic Lua re-verify-and-UNLINK.
 *
 * Rule #46/#223: the test invokes the REAL function against a fake Redis that
 * implements the actual ops it uses (SCAN/SMEMBERS/HKEYS/HMGET/EVAL) — not
 * mockResolvedValue-as-assertion. Rule #259: the cookie value is never logged.
 */

import { describe, it, expect, vi } from 'vitest';
import { reapAllOrphanSlots } from '../reap-orphans.js';
import { poolKeyPrefix } from '../session-pool.js';

const PREFIX_A = poolKeyPrefix('https://prod.acumatica.com', 'api-bot', 'Heritage Fabrics');
const PREFIX_B = poolKeyPrefix('https://legacy.acumatica.com', 'api-bot', 'Old Tenant');
const STALE_MS = 120_000;

interface FakeOpts {
  /** Slot hash keys that, when read via HMGET, add their slotId to the :slots set (simulate a
   *  concurrent acquire winning the slot between SCAN-classify and the Lua re-verify). */
  raceKeys?: Set<string>;
  /** Make SCAN throw, to exercise the best-effort/degraded path. */
  scanThrows?: boolean;
  /** Return every matching key twice (Redis SCAN explicitly permits duplicates). */
  duplicateScan?: boolean;
}

function makeFakeRedis(opts: FakeOpts = {}) {
  const store = new Map<string, Map<string, string>>(); // slot hashes
  const sets = new Map<string, Set<string>>(); // :slots sets

  function seedSlot(key: string, fields: Record<string, string>): void {
    store.set(key, new Map(Object.entries(fields)));
  }
  function seedSet(key: string, members: string[]): void {
    sets.set(key, new Set(members));
  }

  const fake = {
    scan: vi.fn(async (_cursor: string, _m: string, pattern: string, _c: string, _n: number): Promise<[string, string[]]> => {
      if (opts.scanThrows) throw new Error('READONLY scan failed');
      const prefix = pattern.replace(/\*$/, '');
      const keys = [...store.keys(), ...sets.keys()].filter((k) => k.startsWith(prefix));
      return ['0', opts.duplicateScan ? [...keys, ...keys] : keys];
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    hkeys: vi.fn(async (key: string) => [...(store.get(key)?.keys() ?? [])]),
    hmget: vi.fn(async (key: string, ...fields: string[]) => {
      const out = fields.map((f) => store.get(key)?.get(f) ?? null);
      // Race hook: a concurrent acquire claims this slot right after we classify it.
      if (opts.raceKeys?.has(key)) {
        const m = key.match(/^(.+):slot:([^:]+)$/);
        if (m) {
          const [, prefix, slotId] = m;
          if (!sets.has(`${prefix}:slots`)) sets.set(`${prefix}:slots`, new Set());
          sets.get(`${prefix}:slots`)!.add(slotId);
          store.get(key)?.set('cookie', '.ASPXAUTH=just-acquired');
        }
      }
      return out;
    }),
    eval: vi.fn(async (script: string, _numKeys: number, ...args: string[]): Promise<number> => {
      // REAP_ORPHAN_LUA discriminator: it (and only it) does HEXISTS + UNLINK.
      if (!(script.includes('HEXISTS') && script.includes('UNLINK'))) return null as unknown as number;
      const [slotKey, slotsSetKey, slotId, nowStr, staleStr] = args;
      const now = parseInt(nowStr, 10);
      const staleMs = parseInt(staleStr, 10);
      if (sets.get(slotsSetKey)?.has(slotId)) return 0; // SISMEMBER
      if (store.get(slotKey)?.has('cookie')) return 0; // HEXISTS cookie
      const lu = store.get(slotKey)?.get('lastUsedAt');
      const cr = store.get(slotKey)?.get('createdAt');
      const ts = parseInt(lu ?? cr ?? '0', 10);
      if (ts > 0 && now - ts < staleMs) return 0;
      return store.delete(slotKey) ? 1 : 0; // UNLINK returns the removal count (0 if already gone)
    }),

    _store: store,
    _sets: sets,
    seedSlot,
    seedSet,
  };
  return fake;
}

type Fake = ReturnType<typeof makeFakeRedis>;
const asRedis = (f: Fake) => f as unknown as Parameters<typeof reapAllOrphanSlots>[0];

const old = () => String(Date.now() - 10 * 86_400_000); // 10 days ago — well past stale
const fresh = () => String(Date.now());

describe('reapAllOrphanSlots — cross-prefix orphan sweep', () => {
  it('reaps stale cookieless not-in-set orphans across MULTIPLE prefixes in one call', async () => {
    const r = makeFakeRedis();
    // Prefix A orphan: no :slots set exists for A at all (the defunct-prefix case)
    r.seedSlot(`${PREFIX_A}:slot:orphan-a`, { checkedOutBy: '', lastUsedAt: old() });
    // Prefix B orphan: a :slots set exists but this slotId is not a member
    r.seedSet(`${PREFIX_B}:slots`, ['some-other-live-slot']);
    r.seedSlot(`${PREFIX_B}:slot:orphan-b`, { checkedOutBy: '', lastUsedAt: old() });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    expect(res.reaped).toBe(2);
    expect(res.scanned).toBe(2);
    expect(res.byPrefix[PREFIX_A]).toBe(1);
    expect(res.byPrefix[PREFIX_B]).toBe(1);
    expect(r._store.has(`${PREFIX_A}:slot:orphan-a`)).toBe(false);
    expect(r._store.has(`${PREFIX_B}:slot:orphan-b`)).toBe(false);
  });

  it('NEVER reaps an active in-set slot', async () => {
    const r = makeFakeRedis();
    r.seedSet(`${PREFIX_A}:slots`, ['live-1']);
    r.seedSlot(`${PREFIX_A}:slot:live-1`, { cookie: '.ASPXAUTH=x', checkedOutBy: '', lastUsedAt: old() });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    expect(res.reaped).toBe(0);
    expect(r._store.has(`${PREFIX_A}:slot:live-1`)).toBe(true);
  });

  it('NEVER reaps a cookied slot even when it is NOT in the :slots set (defensive)', async () => {
    const r = makeFakeRedis();
    r.seedSlot(`${PREFIX_A}:slot:cookied-orphan`, { cookie: '.ASPXAUTH=live', checkedOutBy: '', lastUsedAt: old() });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    expect(res.reaped).toBe(0);
    expect(r._store.has(`${PREFIX_A}:slot:cookied-orphan`)).toBe(true);
  });

  it('NEVER reaps a fresh orphan inside the stale window (mid-acquire race)', async () => {
    const r = makeFakeRedis();
    r.seedSlot(`${PREFIX_A}:slot:recent`, { checkedOutBy: '', lastUsedAt: fresh() });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    expect(res.reaped).toBe(0);
    expect(r._store.has(`${PREFIX_A}:slot:recent`)).toBe(true);
  });

  it('reaps an orphan with NO timestamp fields (undated zombie)', async () => {
    const r = makeFakeRedis();
    r.seedSlot(`${PREFIX_A}:slot:undated`, { checkedOutBy: '' });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    expect(res.reaped).toBe(1);
    expect(r._store.has(`${PREFIX_A}:slot:undated`)).toBe(false);
  });

  it('does NOT overcount when SCAN returns the same orphan key twice', async () => {
    const r = makeFakeRedis({ duplicateScan: true });
    r.seedSlot(`${PREFIX_A}:slot:dup`, { checkedOutBy: '', lastUsedAt: old() });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    // Two candidates (the dup), but only ONE actual UNLINK removal → reaped counts it once.
    expect(res.reaped).toBe(1);
    expect(res.byPrefix[PREFIX_A]).toBe(1);
    expect(r._store.has(`${PREFIX_A}:slot:dup`)).toBe(false);
  });

  it('atomic re-verify: a slot acquired AFTER classification but before UNLINK is preserved', async () => {
    const raceKey = `${PREFIX_A}:slot:racer`;
    const r = makeFakeRedis({ raceKeys: new Set([raceKey]) });
    // Both look like stale orphans at classify time...
    r.seedSlot(raceKey, { checkedOutBy: '', lastUsedAt: old() });
    r.seedSlot(`${PREFIX_A}:slot:control`, { checkedOutBy: '', lastUsedAt: old() });

    const res = await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS });

    // The racer was claimed (added to :slots + given a cookie) during classify read →
    // the Lua re-check (SISMEMBER/HEXISTS) refuses to UNLINK it.
    expect(r._store.has(raceKey)).toBe(true);
    // The control orphan is still reaped.
    expect(r._store.has(`${PREFIX_A}:slot:control`)).toBe(false);
    expect(res.reaped).toBe(1);
  });

  it('returns zeros when there are no pool keys at all', async () => {
    const r = makeFakeRedis();
    const res = await reapAllOrphanSlots(asRedis(r));
    expect(res).toEqual({ reaped: 0, scanned: 0, byPrefix: {} });
  });

  it('is best-effort: a SCAN failure returns zeros instead of throwing', async () => {
    const r = makeFakeRedis({ scanThrows: true });
    const warn = vi.fn();
    const res = await reapAllOrphanSlots(asRedis(r), { logger: { info: vi.fn(), debug: vi.fn(), warn } });
    expect(res).toEqual({ reaped: 0, scanned: 0, byPrefix: {} });
    expect(warn).toHaveBeenCalled();
  });

  it('logs a summary (without the cookie value) only when something was reaped', async () => {
    const r = makeFakeRedis();
    r.seedSlot(`${PREFIX_A}:slot:z`, { checkedOutBy: '', lastUsedAt: old() });
    const info = vi.fn();
    await reapAllOrphanSlots(asRedis(r), { staleCheckoutMs: STALE_MS, logger: { info, debug: vi.fn(), warn: vi.fn() } });
    expect(info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(info.mock.calls[0]);
    expect(logged).not.toContain('ASPXAUTH');
    expect(logged).not.toContain('cookie');
  });
});
