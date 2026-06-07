/**
 * Cross-prefix orphan-slot sweep.
 *
 * The per-pool `SessionPool.reapOrphanSlots()` only sweeps ITS OWN prefix
 * (`{prefix}:slot:*`). Legacy orphan slot hashes left under a DEFUNCT prefix —
 * e.g. the pre-2026-04-19 account-only key scheme, or a sandbox/instance prefix
 * whose pool is not running keepalive in this process — are invisible to every
 * per-pool reaper and accumulate forever (observed 2026-06-07: 89 hashes aged
 * 22–28 days, no TTL, only cleared by the manual `cleanup-orphan-pool-keys.ts`
 * flusher). This function promotes that manual cross-prefix flush into the
 * library, with the per-pool reaper's exact safety invariants PLUS an atomic
 * re-verify-and-UNLINK so a concurrent acquire can never lose a live slot.
 *
 * Intended invocation: a pool registry calls this on startup (clear the backlog
 * before serving traffic) and periodically (e.g. each keepalive cycle).
 *
 * Safety invariants (NEVER violated — re-checked atomically in Lua at delete time):
 *   - A slot whose id is in its prefix's `:slots` set is never reaped (active).
 *   - A hash with a `cookie` field is never reaped (live Acumatica session).
 *   - A hash whose lastUsedAt/createdAt is within `staleCheckoutMs` is skipped
 *     (could be mid-acquire in another process).
 *
 * Rule #259: field presence is checked via HKEYS / the targeted Lua HEXISTS —
 * the cookie VALUE is never read into JS or logged.
 */

import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** Re-verify all three orphan invariants against the live key and UNLINK only if still orphan.
 *  KEYS[1] = slot hash key, KEYS[2] = `{prefix}:slots` set key.
 *  ARGV[1] = slotId, ARGV[2] = now (ms), ARGV[3] = staleCheckoutMs.
 *  Returns UNLINK's removal count: 1 if this call removed the hash, 0 if preserved or
 *  already gone (duplicate SCAN result / expired between classify and eval). */
const REAP_ORPHAN_LUA = `
  local slotKey = KEYS[1]
  local slotsSetKey = KEYS[2]
  local slotId = ARGV[1]
  local now = tonumber(ARGV[2])
  local staleMs = tonumber(ARGV[3])

  if redis.call('SISMEMBER', slotsSetKey, slotId) == 1 then return 0 end
  if redis.call('HEXISTS', slotKey, 'cookie') == 1 then return 0 end

  local lu = redis.call('HGET', slotKey, 'lastUsedAt')
  local cr = redis.call('HGET', slotKey, 'createdAt')
  local ts = tonumber(lu or cr or '0') or 0
  if ts > 0 and (now - ts) < staleMs then return 0 end

  -- UNLINK returns 1 only if the hash actually existed; 0 for a duplicate SCAN hit or a key
  -- that expired between classification and now — so reaped counts real removals only.
  return redis.call('UNLINK', slotKey)
`;

export interface ReapAllOrphansOptions {
  /** Only reap orphans whose lastUsedAt/createdAt is older than this. Default: 120_000 (2 min). */
  staleCheckoutMs?: number;
  /** SCAN COUNT hint. Default: 200. */
  scanCount?: number;
  /** Optional pino-style logger. The cookie value is NEVER logged (Rule #259). */
  logger?: Pick<Logger, 'info' | 'debug' | 'warn'>;
}

export interface ReapAllOrphansResult {
  /** Number of orphan slot hashes UNLINKed. */
  reaped: number;
  /** Number of `:slot:` hashes scanned across all prefixes. */
  scanned: number;
  /** Reaped count keyed by pool prefix. */
  byPrefix: Record<string, number>;
}

/**
 * Sweep orphan slot hashes across ALL `acumatica:pool:*` prefixes.
 *
 * Best-effort: any Redis error is swallowed (logged at debug/warn) and the work
 * done so far is returned — never throws past the caller. Safe to run on a
 * degraded/unreachable Redis (returns zeros).
 */
export async function reapAllOrphanSlots(
  redis: Redis,
  opts: ReapAllOrphansOptions = {},
): Promise<ReapAllOrphansResult> {
  const staleCheckoutMs = opts.staleCheckoutMs ?? 120_000;
  const scanCount = opts.scanCount ?? 200;
  const now = Date.now();
  const empty: ReapAllOrphansResult = { reaped: 0, scanned: 0, byPrefix: {} };

  // 1. SCAN every key under the pool namespace.
  const allKeys: string[] = [];
  let cursor = '0';
  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'acumatica:pool:*', 'COUNT', scanCount);
      cursor = next;
      allKeys.push(...keys);
    } while (cursor !== '0');
  } catch (err) {
    opts.logger?.warn?.({ err: (err as Error)?.message }, 'reapAllOrphanSlots: SCAN failed');
    return empty;
  }

  // 2. Partition into slot hashes vs `:slots` sets, then build the active-slot set per prefix.
  const slotHashKeys: string[] = [];
  const slotsSetKeys: string[] = [];
  for (const k of allKeys) {
    if (/:slot:[^:]+$/.test(k)) slotHashKeys.push(k);
    else if (k.endsWith(':slots')) slotsSetKeys.push(k);
  }
  if (slotHashKeys.length === 0) return empty;

  const slotsByPrefix = new Map<string, Set<string>>();
  for (const setKey of slotsSetKeys) {
    const prefix = setKey.slice(0, -':slots'.length);
    try {
      slotsByPrefix.set(prefix, new Set(await redis.smembers(setKey)));
    } catch (err) {
      opts.logger?.debug?.({ err: (err as Error)?.message, setKey }, 'reapAllOrphanSlots: SMEMBERS failed');
    }
  }

  // 3. Classify candidates (cheap pre-filter; the Lua re-checks atomically before delete).
  const candidates: Array<{ key: string; prefix: string; slotId: string }> = [];
  for (const key of slotHashKeys) {
    const m = key.match(/^(.+):slot:([^:]+)$/);
    if (!m) continue;
    const prefix = m[1];
    const slotId = m[2];

    // Safety 1: never an active (in-set) slot.
    if (slotsByPrefix.get(prefix)?.has(slotId)) continue;

    try {
      // Safety 2: never a slot with a live cookie. HKEYS = field names only (Rule #259).
      const fields = await redis.hkeys(key);
      if (fields.includes('cookie')) continue;

      // Safety 3: never a record younger than the stale window (mid-acquire race).
      const [lastUsedAt, createdAt] = await redis.hmget(key, 'lastUsedAt', 'createdAt');
      const ts = parseInt(lastUsedAt ?? createdAt ?? '0', 10);
      if (ts > 0 && now - ts < staleCheckoutMs) continue;
    } catch (err) {
      opts.logger?.debug?.({ err: (err as Error)?.message, key }, 'reapAllOrphanSlots: classify read failed');
      continue;
    }

    candidates.push({ key, prefix, slotId });
  }

  // 4. Atomic re-verify-and-UNLINK per candidate (no TOCTOU: a concurrent acquire that adds the
  //    slot to the set or writes a cookie between SCAN and now will be caught by the Lua re-check).
  const byPrefix: Record<string, number> = {};
  let reaped = 0;
  for (const c of candidates) {
    try {
      const res = (await redis.eval(
        REAP_ORPHAN_LUA,
        2,
        c.key,
        `${c.prefix}:slots`,
        c.slotId,
        String(now),
        String(staleCheckoutMs),
      )) as number;
      if (res === 1) {
        reaped += 1;
        byPrefix[c.prefix] = (byPrefix[c.prefix] ?? 0) + 1;
      }
    } catch (err) {
      opts.logger?.debug?.({ err: (err as Error)?.message, key: c.key }, 'reapAllOrphanSlots: UNLINK eval failed');
    }
  }

  if (reaped > 0) {
    opts.logger?.info?.(
      { reaped, scanned: slotHashKeys.length, byPrefix },
      'reapAllOrphanSlots: reaped cross-prefix orphan slot hashes',
    );
  }
  return { reaped, scanned: slotHashKeys.length, byPrefix };
}
