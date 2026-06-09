/**
 * Per-(baseUrl, account, company) Acumatica session pool with Redis-backed
 * cookie reuse.
 *
 * Replaces the pattern of login→work→logout on every request with
 * checkout→work→checkin, reusing session cookies across requests.
 * Each (baseUrl, account, company) tuple gets its own pool with configurable
 * max slots — tenants on the same Acumatica instance, or the same account
 * name across instances, do NOT share lockout state or session slots.
 *
 * Redis data model (PREFIX = `acumatica:pool:{b64(baseUrl)}:{account}:{b64(company)}`):
 *   {PREFIX}:meta    — hash (maxSize, activeLogins)
 *   {PREFIX}:slots   — set of active slot IDs
 *   {PREFIX}:slot:{id} — hash (cookie, timestamps, checkout state) — has TTL
 *   {PREFIX}:login-failures — string with TTL (failure counter)
 *   acumatica:lockout:{b64(baseUrl)}:{account}:{b64(company)} — string with TTL
 *
 * Orphan prevention (v1.2.0):
 *   1. withSession no longer calls checkin() on a handle that was evicted in
 *      the 401-retry branch — the evicted slot is tracked via `_evictedSlotIds`
 *      and skipped in the outer finally block.
 *   2. Every slot hash is given a defensive TTL (slotTtlMs, default 2h) so any
 *      stray record self-expires even if cleanup logic fails.
 *   3. A reaper sweep (run at each keepalive cycle) removes orphan hashes:
 *      NOT in the :slots set, no cookie field, lastUsedAt older than
 *      staleCheckoutMs. Active cookied/in-set slots are never touched.
 *
 * Note: pre-2026-04-19 keys (account-only scope) are abandoned on upgrade.
 * They will expire naturally via the AcumaticaClient session TTL or can be
 * flushed manually with `redis-cli --scan --pattern 'acumatica:pool:*'`.
 */

import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { request as undiciRequest } from 'undici';
import pino from 'pino';
import type { Logger } from 'pino';
import { AcumaticaCircuitBreaker } from './circuit-breaker.js';
import { AccountLockedError } from './error-handler.js';

// -- Types --

export interface SessionHandle {
  slotId: string;
  cookie: string;
  checkedOutBy: string;
  checkedOutAt: number;
  degraded: boolean;
}

export interface PoolEvent {
  type: 'pool_exhausted' | 'circuit_trip' | 'slot_evicted' | 'stale_reclaimed' | 'orphan_reaped';
  account: string;
  detail: string;
  timestamp: number;
}

export interface PoolConfig {
  /** Account name (e.g., "api-bot", "api-sync") */
  account: string;
  /** Max concurrent pooled sessions */
  maxSize: number;
  /** Acumatica credentials */
  credentials: {
    baseUrl: string;
    username: string;
    password: string;
    tenant?: string;
  };
  /** Redis URL for coordination. Empty string = degraded mode. */
  redisUrl: string;
  /** Service identifier for checkout tracking */
  serviceId: string;
  /** How long before a checked-out slot is considered stale (ms). Default: 120_000 */
  staleCheckoutMs?: number;
  /** Max time to wait for a slot (ms). Default: 30_000 */
  checkoutTimeoutMs?: number;
  /** Polling interval when waiting for a slot (ms). Default: 2_000 */
  pollIntervalMs?: number;
  /** Background keepalive interval for idle sessions (ms). Default: 600_000 (10 min) */
  keepaliveMs?: number;
  /**
   * Defensive TTL on every slot hash in seconds. Default: 7200 (2h).
   * A slot hash that somehow escapes both checkin and eviction will self-expire
   * after this duration, preventing permanent Redis key accumulation.
   * Set to 0 to disable (not recommended for production).
   */
  slotTtlMs?: number;
  /**
   * When true, the keepalive cycle sheds EXCESS IDLE slots so the live session
   * count converges DOWN to maxSize: each excess idle slot is atomically
   * evicted (idle-only) AND logged out Acumatica-side, immediately returning the
   * concurrent-API-login seat. Default false.
   *
   * Why this exists: maxSize only gates NEW slot creation; idle slots are only
   * ever evicted on a 401, and keepalive PREVENTS the 401 by pinging them alive.
   * So a pool that once peaked at N slots (e.g. before maxSize was lowered, or a
   * load spike) keeps N live sessions FOREVER, even above maxSize — a permanent
   * draw on the per-account concurrent-login cap (CLAUDE.md Rule #311).
   *
   * ⚠️ SHARED-PREFIX INVARIANT: pools sharing a (baseUrl, account, company) Redis
   * slot set MUST enable this on AT MOST ONE pool, and it must be the pool with
   * the LARGEST maxSize. A smaller-maxSize co-pool with convergence enabled would
   * shed slots the larger pool still needs → login thrash. Enable ONLY on the
   * primary (largest) pool — e.g. the studiob-api gateway pool — NEVER on a
   * co-pool like the MCP pool (which runs a smaller maxSize on the same prefix).
   */
  convergeIdleToMaxSize?: boolean;
  /** Optional event callback for observability (Slack alerts, metrics) */
  onEvent?: (event: PoolEvent) => void;
  /** Logger instance */
  logger?: Logger;
}

export interface PoolStatus {
  account: string;
  maxSize: number;
  activeSlots: number;
  checkedOut: number;
  available: number;
  circuitBreaker: string;
  degraded: boolean;
  slots: Array<{
    id: string;
    ageMs: number;
    checkedOutBy: string;
    idle: boolean;
  }>;
}

export class SessionPoolExhaustedError extends Error {
  account: string;
  waitMs: number;

  constructor(account: string, waitMs: number) {
    super(
      `Session pool exhausted for account "${account}" after ${waitMs}ms — all slots checked out`,
    );
    this.name = 'SessionPoolExhaustedError';
    this.account = account;
    this.waitMs = waitMs;
  }
}

// -- Redis key helpers --
//
// Keys are scoped by (baseUrl, account, company) so tenants on the same
// Acumatica instance, or the same `account` name across instances, do NOT
// share session slots or lockout state. baseUrl + company are base64url
// encoded so colons in URLs survive the key parser.

function b64u(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/**
 * Build the per-tuple key prefix. Exposed for tests.
 * Empty `company` is normalised to `_` so it stays distinguishable from a
 * caller who passes the literal string `_`.
 */
export function poolKeyPrefix(
  baseUrl: string,
  account: string,
  company: string | undefined,
): string {
  return `acumatica:pool:${b64u(baseUrl)}:${account}:${b64u(company || '_')}`;
}

/** Mirror of `poolKeyPrefix` for the per-tuple lockout key. */
export function poolLockoutKey(
  baseUrl: string,
  account: string,
  company: string | undefined,
): string {
  return `acumatica:lockout:${b64u(baseUrl)}:${account}:${b64u(company || '_')}`;
}

function metaKey(prefix: string): string {
  return `${prefix}:meta`;
}

function slotsKey(prefix: string): string {
  return `${prefix}:slots`;
}

function slotKey(prefix: string, slotId: string): string {
  return `${prefix}:slot:${slotId}`;
}

function loginFailuresKey(prefix: string): string {
  return `${prefix}:login-failures`;
}

// -- Lua scripts --

/**
 * CHECKOUT_LUA: Find an available slot (checkedOutBy == "") or reclaim a stale one.
 * KEYS[1] = slotsKey, ARGV[1] = keyPrefix, ARGV[2] = serviceId, ARGV[3] = now, ARGV[4] = staleMs
 * Returns: [slotId, cookie] or [nil] if none available.
 */
const CHECKOUT_LUA = `
  local slotsKey = KEYS[1]
  local keyPrefix = ARGV[1]
  local serviceId = ARGV[2]
  local now = tonumber(ARGV[3])
  local staleMs = tonumber(ARGV[4])
  local ttlSeconds = tonumber(ARGV[5])

  local slotIds = redis.call('SMEMBERS', slotsKey)
  for _, sid in ipairs(slotIds) do
    local sk = keyPrefix .. ':slot:' .. sid
    local checkedOutBy = redis.call('HGET', sk, 'checkedOutBy')
    if checkedOutBy == '' or checkedOutBy == false then
      -- Available slot: check it out
      redis.call('HSET', sk, 'checkedOutBy', serviceId, 'checkedOutAt', tostring(now))
      if ttlSeconds > 0 then redis.call('EXPIRE', sk, ttlSeconds) end
      local cookie = redis.call('HGET', sk, 'cookie')
      return {sid, cookie or ''}
    else
      -- Check for stale checkout
      local checkedOutAt = tonumber(redis.call('HGET', sk, 'checkedOutAt') or '0')
      if checkedOutAt > 0 and (now - checkedOutAt) > staleMs then
        -- Reclaim stale slot
        redis.call('HSET', sk, 'checkedOutBy', serviceId, 'checkedOutAt', tostring(now))
        if ttlSeconds > 0 then redis.call('EXPIRE', sk, ttlSeconds) end
        local cookie = redis.call('HGET', sk, 'cookie')
        return {sid, cookie or ''}
      end
    end
  end
  return {nil}
`;

/**
 * CHECKIN_LUA: Return a slot to the pool.
 * KEYS[1] = slotKey, ARGV[1] = now
 * NOTE: HSET creates the hash if absent. For evicted slots this produces an
 * orphan. Fix (v1.2.0): withSession skips checkin for evicted handles via
 * _evictedSlotIds so this code path is no longer reached for evicted slots.
 */
const CHECKIN_LUA = `
  local sk = KEYS[1]
  local ttlSeconds = tonumber(ARGV[2])
  redis.call('HSET', sk, 'checkedOutBy', '', 'checkedOutAt', '0', 'lastUsedAt', ARGV[1])
  if ttlSeconds > 0 then redis.call('EXPIRE', sk, ttlSeconds) end
  return 1
`;

/**
 * CREATE_SLOT_LUA: Create a new slot and add to the index.
 * KEYS[1] = slotsKey, KEYS[2] = slotKey
 * ARGV[1] = slotId, ARGV[2] = cookie, ARGV[3] = serviceId, ARGV[4] = now,
 * ARGV[5] = ttlSeconds (0 = no TTL)
 */
const CREATE_SLOT_LUA = `
  local slotsKey = KEYS[1]
  local sk = KEYS[2]
  local slotId = ARGV[1]
  local cookie = ARGV[2]
  local serviceId = ARGV[3]
  local now = ARGV[4]
  local ttlSeconds = tonumber(ARGV[5])

  redis.call('SADD', slotsKey, slotId)
  redis.call('HSET', sk,
    'cookie', cookie,
    'createdAt', now,
    'lastUsedAt', now,
    'checkedOutBy', serviceId,
    'checkedOutAt', now)
  if ttlSeconds > 0 then
    redis.call('EXPIRE', sk, ttlSeconds)
  end
  return 1
`;

/**
 * EVICT_SLOT_LUA: Remove a slot from the pool.
 * KEYS[1] = slotsKey, KEYS[2] = slotKey, ARGV[1] = slotId
 */
const EVICT_SLOT_LUA = `
  redis.call('SREM', KEYS[1], ARGV[1])
  redis.call('DEL', KEYS[2])
  return 1
`;

/**
 * EVICT_IDLE_LUA: Atomically evict ONE slot for convergence, guarded by BOTH the
 * live pool size AND the slot's checkout state — both read inside the same Lua so
 * there is no TOCTOU. This makes convergence safe even when multiple processes
 * (e.g. two gateway replicas during a deploy) run it on a shared slot set, or a
 * 401-eviction races it: the SCARD>maxSize gate means the pool can never be shed
 * BELOW maxSize, so valid warm sessions are never over-logged-out (codex P2).
 * KEYS[1] = slotsKey, KEYS[2] = slotKey, ARGV[1] = slotId, ARGV[2] = maxSize
 * Returns (distinct JS types, no collision):
 *   -1 (number)           → pool already at/under maxSize; caller STOPs the sweep.
 *   cookie / '' (string)  → slot evicted; cookie to log out ('' if it had none).
 *   false (→ JS null)     → slot is checked out; skip it, keep sweeping.
 */
const EVICT_IDLE_LUA = `
  local slotsKey = KEYS[1]
  local sk = KEYS[2]
  local maxSize = tonumber(ARGV[2])
  if redis.call('SCARD', slotsKey) <= maxSize then
    return -1
  end
  local checkedOutBy = redis.call('HGET', sk, 'checkedOutBy')
  if checkedOutBy == '' or checkedOutBy == false then
    local cookie = redis.call('HGET', sk, 'cookie')
    redis.call('SREM', slotsKey, ARGV[1])
    redis.call('DEL', sk)
    return cookie or ''
  end
  return false
`;

// -- SessionPool --

export class SessionPool {
  readonly account: string;
  readonly maxSize: number;
  readonly staleCheckoutMs: number;
  readonly checkoutTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly keepaliveMs: number;
  /** Defensive TTL on slot hashes in milliseconds. 0 = disabled. */
  readonly slotTtlMs: number;
  /** When true, keepalive sheds excess idle slots down to maxSize (logout + evict). */
  readonly convergeIdleToMaxSize: boolean;

  private credentials: PoolConfig['credentials'];
  private redisUrl: string;
  private serviceId: string;
  private redis: Redis | null = null;
  private degraded = false;
  private log: Logger;
  /** Per-(baseUrl, account, company) Redis key prefix. */
  readonly keyPrefix: string;
  /** Per-(baseUrl, account, company) lockout key. */
  readonly lockoutKey: string;
  readonly circuitBreaker: AcumaticaCircuitBreaker;

  /** In-memory slot store for degraded mode (no Redis) */
  private localSlots = new Map<string, { cookie: string; checkedOutBy: string; checkedOutAt: number; createdAt: number }>();

  /**
   * Slot IDs evicted during the current withSession invocation.
   * The outer finally block checks this set before calling checkin() to avoid
   * recreating zombie hashes on already-deleted slot keys (v1.2.0 fix).
   */
  readonly _evictedSlotIds = new Set<string>();

  /** Test hook to replace the HTTP login call */
  private loginFn: (() => Promise<string>) | null = null;
  /** Test hook to replace the keepalive ping */
  private pingFn: ((cookie: string) => Promise<void>) | null = null;
  /** Test hook to replace the HTTP logout call */
  private logoutFn: ((cookie: string) => Promise<void>) | null = null;
  /** Keepalive timer handle */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional event callback */
  private onEvent?: (event: PoolEvent) => void;

  constructor(config: PoolConfig) {
    this.account = config.account;
    this.maxSize = config.maxSize;
    this.credentials = config.credentials;
    this.redisUrl = config.redisUrl;
    this.serviceId = config.serviceId;
    this.staleCheckoutMs = config.staleCheckoutMs ?? 120_000;
    this.checkoutTimeoutMs = config.checkoutTimeoutMs ?? 30_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.keepaliveMs = config.keepaliveMs ?? 600_000;
    this.slotTtlMs = config.slotTtlMs ?? 7_200_000; // 2h default
    this.convergeIdleToMaxSize = config.convergeIdleToMaxSize ?? false;
    this.log = config.logger ?? pino({ name: `session-pool:${config.account}` });
    this.keyPrefix = poolKeyPrefix(
      config.credentials.baseUrl,
      config.account,
      config.credentials.tenant,
    );
    this.lockoutKey = poolLockoutKey(
      config.credentials.baseUrl,
      config.account,
      config.credentials.tenant,
    );
    this.circuitBreaker = new AcumaticaCircuitBreaker();
    this.onEvent = config.onEvent;
  }

  /** Emit a pool event if callback is configured */
  private emit(type: PoolEvent['type'], detail: string): void {
    this.onEvent?.({ type, account: this.account, detail, timestamp: Date.now() });
  }

  /** Test hook: replace HTTP login with a mock function */
  _setLoginFn(fn: () => Promise<string>): void {
    this.loginFn = fn;
  }

  /** Test hook: replace keepalive ping with a mock function */
  _setPingFn(fn: (cookie: string) => Promise<void>): void {
    this.pingFn = fn;
  }

  /** Test hook: replace HTTP logout with a mock function */
  _setLogoutFn(fn: (cookie: string) => Promise<void>): void {
    this.logoutFn = fn;
  }

  /** Start background keepalive that pings idle sessions to prevent TTL expiry */
  startKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      // Ping idle sessions (+ reap orphans) AND shed excess idle slots to maxSize
      // as INDEPENDENT tasks — neither awaits the other. This decoupling is
      // load-bearing: pingIdleSlots awaits a network ping per idle slot, and under
      // an Acumatica Sign-In-limit throttle (Rule #311) that ping can be slow or
      // hang. Running them sequentially (ping THEN converge) let a slow/hung ping
      // starve convergeIdleSlots, so the pool never shed back to maxSize (2026-06-09
      // prod: stuck at 5 idle sessions vs maxSize 4 for 23 days). Decoupled, converge
      // runs every cycle regardless of ping latency. Safe to run concurrently:
      // EVICT_IDLE_LUA re-guards SCARD>maxSize atomically per evict and the degraded
      // path re-checks localSlots.size each iteration, so a concurrent ping eviction
      // can never make converge shed below maxSize; JS Map deletion during iteration
      // is well-defined. Each task is independently fail-open. Convergence is a no-op
      // unless convergeIdleToMaxSize is set.
      void this.pingIdleSlots().catch((err) => {
        this.log.warn({ err: (err as Error).message }, 'Keepalive ping cycle failed');
      });
      void this.convergeIdleSlots().catch((err) => {
        this.log.warn({ err: (err as Error).message }, 'Keepalive converge cycle failed');
      });
    }, this.keepaliveMs);
    this.keepaliveTimer.unref();
    this.log.debug({ intervalMs: this.keepaliveMs }, 'Keepalive started');
  }

  /** Stop the keepalive timer */
  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.log.debug('Keepalive stopped');
    }
  }

  /** Ping all idle (not checked-out) slots. Evict any that return 401. Also runs orphan reaper. */
  private async pingIdleSlots(): Promise<void> {
    // Degraded mode: iterate local slots
    for (const [sid, slot] of this.localSlots) {
      if (slot.checkedOutBy !== '') continue; // Skip checked-out slots
      try {
        await this.pingSession(slot.cookie);
      } catch (err) {
        if (this.is401Error(err)) {
          this.log.debug({ slotId: sid }, 'Keepalive: idle slot expired, evicting');
          await this.evictSlot(sid, true);
        }
      }
    }

    // Redis mode: iterate slot hashes
    const redis = this.getRedis();
    if (!redis || this.degraded) return;

    const slotIds = await redis.smembers(slotsKey(this.keyPrefix));
    for (const sid of slotIds) {
      const slotData = await redis.hgetall(slotKey(this.keyPrefix, sid));
      if (!slotData || slotData.checkedOutBy !== '') continue;
      try {
        await this.pingSession(slotData.cookie);
      } catch (err) {
        if (this.is401Error(err)) {
          this.log.debug({ slotId: sid }, 'Keepalive: idle slot expired, evicting');
          await this.evictSlot(sid, false);
        }
      }
    }

    // Run orphan reaper as part of every keepalive cycle
    await this.reapOrphanSlots(redis);
  }

  /**
   * Reap orphan slot hashes: hashes that are NOT in the :slots set, have no
   * cookie field (were never successfully created or were evicted), and whose
   * lastUsedAt/createdAt is older than staleCheckoutMs.
   *
   * Root cause: withSession's outer finally called CHECKIN_LUA on an evicted
   * slot. CHECKIN_LUA uses HSET which recreates the key even if DEL'd,
   * producing a zombie hash with checkedOutBy='' and no cookie. This reaper
   * removes those zombies.
   *
   * Safety invariants (NEVER violated):
   *   - A slot ID present in the :slots set is never reaped (active slot).
   *   - A hash with a cookie field is never reaped (live Acumatica session).
   *   - A hash whose lastUsedAt/createdAt is within staleCheckoutMs is skipped
   *     (could be mid-acquire in another process).
   *
   * Exposed publicly so callers (e.g. session-pool-registry) can invoke it
   * on startup to clear the backlog before serving traffic.
   */
  async reapOrphanSlots(redisClient?: Redis | null): Promise<number> {
    const redis = redisClient ?? this.getRedis();
    if (!redis || this.degraded) return 0;

    const now = Date.now();

    // Get the set of active slot IDs — never reap these
    const activeSlotIds = new Set(await redis.smembers(slotsKey(this.keyPrefix)));

    // Scan for all slot hashes under this pool's prefix
    const pattern = `${this.keyPrefix}:slot:*`;
    let cursor = '0';
    const orphanKeys: string[] = [];

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      for (const key of keys) {
        // Extract slotId from key: `{prefix}:slot:{slotId}`
        const slotId = key.slice(this.keyPrefix.length + ':slot:'.length);

        // Safety check 1: never reap an active (in-set) slot
        if (activeSlotIds.has(slotId)) continue;

        const hashData = await redis.hgetall(key);
        if (!hashData || Object.keys(hashData).length === 0) continue;

        // Safety check 2: never reap a slot with a live cookie
        if (hashData.cookie) continue;

        // Safety check 3: only reap if the record is old enough
        // (avoids racing with a slow mid-acquire in another process)
        const lastUsedAt = parseInt(hashData.lastUsedAt ?? hashData.createdAt ?? '0', 10);
        if (lastUsedAt > 0 && (now - lastUsedAt) < this.staleCheckoutMs) continue;

        orphanKeys.push(key);
      }
    } while (cursor !== '0');

    if (orphanKeys.length === 0) return 0;

    // Delete orphans in one pipeline
    const pipeline = redis.pipeline();
    for (const key of orphanKeys) {
      pipeline.del(key);
    }
    await pipeline.exec();

    this.log.info(
      { count: orphanKeys.length, account: this.account },
      'Reaped orphan slot hashes',
    );
    this.emit('orphan_reaped', `Reaped ${orphanKeys.length} orphan slot hashes`);
    return orphanKeys.length;
  }

  /** Ping an Acumatica session to check if it's still valid */
  private async pingSession(cookie: string): Promise<void> {
    if (this.pingFn) return this.pingFn(cookie);

    const baseUrl = this.credentials.baseUrl.replace(/\/$/, '');
    // Bounded (8s) — same as logoutSession. The ping hits /entity/auth/login,
    // the AUTH endpoint, which is exactly what an Acumatica Sign-In-limit
    // throttle chokes (Rule #311). Without a timeout, a throttled ping HANGS
    // indefinitely; since pingIdleSlots awaits each ping in turn, a single hung
    // ping would stall the whole keepalive cycle. The timeout surfaces it as a
    // normal (non-401) error so the slot is left intact and the cycle proceeds.
    const res = await undiciRequest(`${baseUrl}/entity/auth/login`, {
      method: 'GET',
      headers: { Cookie: cookie },
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    await res.body.text(); // Drain body
    if (res.statusCode === 401) {
      throw Object.assign(new Error('Session expired'), { statusCode: 401 });
    }
  }

  /**
   * Log an Acumatica session out server-side, freeing its concurrent-API-login
   * seat IMMEDIATELY instead of waiting ~20-30 min for the session to time out.
   * Bounded (8s) so a hung logout cannot stall the keepalive cycle. Callers run
   * this best-effort AFTER the slot is already evicted, so a failure here only
   * means the seat self-clears on Acumatica's own timeout — no worse than before.
   */
  private async logoutSession(cookie: string): Promise<void> {
    if (this.logoutFn) return this.logoutFn(cookie);
    if (!cookie) return;

    const baseUrl = this.credentials.baseUrl.replace(/\/$/, '');
    const res = await undiciRequest(`${baseUrl}/entity/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    await res.body.text(); // Drain body
  }

  /**
   * Shed EXCESS IDLE slots so the live session count converges DOWN to maxSize.
   * Opt-in via `convergeIdleToMaxSize`; runs at the end of each keepalive cycle.
   *
   * Why: maxSize only gates NEW slot creation, and idle slots are only ever
   * evicted on a 401 — which keepalive actively prevents by pinging them alive.
   * So a pool that once peaked above maxSize holds those extra live sessions
   * forever, a permanent draw on the per-account login cap (Rule #311). This
   * sheds the excess.
   *
   * Each excess idle slot is evicted FIRST (atomically, idle-only) then logged
   * out — so the slot is gone regardless of whether the logout succeeds (a failed
   * logout just falls back to Acumatica's timeout, the pre-convergence behaviour).
   * Checked-out slots are never touched. Fail-open throughout: never throws into
   * the keepalive timer.
   *
   * Safe on a slot set shared across processes: the Redis path uses an atomic
   * evict-if-idle (EVICT_IDLE_LUA), so a slot another process checked out between
   * our SMEMBERS read and the evict is skipped, never yanked out from under it.
   */
  private async convergeIdleSlots(): Promise<void> {
    if (!this.convergeIdleToMaxSize) return;

    const redis = this.getRedis();

    // --- Degraded mode (no Redis): shed excess idle local slots ---
    if (!redis || this.degraded) {
      if (this.localSlots.size <= this.maxSize) return;
      let evicted = 0;
      for (const [sid, slot] of this.localSlots) {
        // Re-check the LIVE size each iteration so a concurrent 401-eviction in
        // this process can never make us shed below maxSize (codex P2, degraded path).
        if (this.localSlots.size <= this.maxSize) break;
        if (slot.checkedOutBy !== '') continue; // never evict a checked-out slot
        this.localSlots.delete(sid); // evict first — slot is gone even if logout fails
        evicted++;
        this.emit('slot_evicted', `Converge: shed excess idle slot ${sid} (degraded)`);
        try {
          await this.logoutSession(slot.cookie);
        } catch (err) {
          this.log.debug(
            { slotId: sid, err: (err as Error).message },
            'Converge logout failed (slot already evicted)',
          );
        }
      }
      if (evicted > 0) {
        this.log.info(
          { account: this.account, evicted, maxSize: this.maxSize, degraded: true },
          'Converge: shed excess idle pool slots down to maxSize',
        );
      }
      return;
    }

    // --- Redis mode: atomic evict-if-idle per excess slot, then logout ---
    let slotIds: string[];
    try {
      slotIds = await redis.smembers(slotsKey(this.keyPrefix));
    } catch (err) {
      if (this.isRedisConnectionError(err)) this.degraded = true;
      return;
    }
    if (slotIds.length <= this.maxSize) return; // cheap pre-check; the Lua re-guards atomically per evict

    let evicted = 0;
    for (const sid of slotIds) {
      let res: unknown;
      try {
        res = await redis.eval(
          EVICT_IDLE_LUA,
          2,
          slotsKey(this.keyPrefix),
          slotKey(this.keyPrefix, sid),
          sid,
          String(this.maxSize),
        );
      } catch (err) {
        if (this.isRedisConnectionError(err)) {
          this.degraded = true;
          return;
        }
        this.log.debug(
          { slotId: sid, err: (err as Error).message },
          'Converge evict-if-idle eval failed',
        );
        continue;
      }
      if (typeof res === 'number') break; // -1: pool reached maxSize — stop the sweep
      if (res === null || res === undefined) continue; // checked out — skip, keep sweeping
      const cookie = res as string; // evicted (cookie may be '')
      evicted++;
      this.emit('slot_evicted', `Converge: shed excess idle slot ${sid}`);
      if (cookie) {
        try {
          await this.logoutSession(cookie);
        } catch (err) {
          this.log.debug(
            { slotId: sid, err: (err as Error).message },
            'Converge logout failed (slot already evicted)',
          );
        }
      }
    }
    if (evicted > 0) {
      this.log.info(
        { account: this.account, evicted, maxSize: this.maxSize },
        'Converge: shed excess idle pool slots down to maxSize',
      );
    }
  }

  /** Lazy-connect to Redis. Returns null if unreachable. */
  private getRedis(): Redis | null {
    if (this.redis) return this.redis;
    if (this.degraded) return null;
    if (!this.redisUrl) {
      this.degraded = true;
      this.log.warn('Session pool degraded: no Redis URL configured');
      return null;
    }

    try {
      this.redis = new Redis(this.redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times > 2) {
            this.degraded = true;
            this.log.warn('Session pool degraded: Redis connection failed');
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        enableOfflineQueue: false,
      });

      this.redis.on('error', (err: Error) => {
        if (!this.degraded) {
          this.degraded = true;
          this.log.warn({ err: err.message }, 'Session pool degraded');
        }
      });

      return this.redis;
    } catch (err) {
      this.degraded = true;
      this.log.warn(
        { err: (err as Error).message },
        'Session pool degraded: init failed',
      );
      return null;
    }
  }

  /** Login to Acumatica and return session cookie string */
  private async loginToAcumatica(): Promise<string> {
    if (this.loginFn) return this.loginFn();

    const loginBody: Record<string, string> = {
      name: this.credentials.username,
      password: this.credentials.password,
    };
    if (this.credentials.tenant) loginBody.company = this.credentials.tenant;

    const baseUrl = this.credentials.baseUrl.replace(/\/$/, '');
    const res = await undiciRequest(`${baseUrl}/entity/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginBody),
    });

    const text = await res.body.text();

    if (res.statusCode >= 400) {
      if (res.statusCode === 500 && text.includes('locked out')) {
        throw new AccountLockedError(
          'Acumatica account locked out during pool login.',
        );
      }
      throw new Error(`Pool login failed: HTTP ${res.statusCode} — ${text.slice(0, 200)}`);
    }

    const setCookieHeader = res.headers['set-cookie'];
    const setCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    return setCookies.map((c) => c.split(';')[0]).join('; ');
  }

  /**
   * Detect whether a thrown error is a Redis connection/socket error that
   * requires falling back to degraded mode.  These errors are thrown
   * synchronously from `redis.eval()` / `redis.scard()` BEFORE ioredis's
   * async 'error' event fires, so `this.degraded` is still false at the
   * point of the throw.
   */
  private isRedisConnectionError(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    return (
      msg.includes("Stream isn't writeable") ||
      msg.includes('enableOfflineQueue') ||
      msg.includes('ECONNRESET') ||
      msg.includes('Connection is closed') ||
      msg.includes('Socket closed unexpectedly') ||
      msg.includes('connect ECONNREFUSED') ||
      // ioredis MaxRetriesPerRequestError — thrown when a command is in-flight
      // during a disconnect and the configured maxRetriesPerRequest (1) is
      // exhausted before a reply arrives. Same degraded-fallback applies.
      msg.includes('max retries per request')
    );
  }

  /** Checkout a session slot. Returns a handle with cookie. */
  async checkout(): Promise<SessionHandle> {
    const started = Date.now();

    // Circuit breaker check
    if (this.circuitBreaker.isOpen) {
      throw new Error(
        `Circuit breaker open for account "${this.account}": ${this.circuitBreaker.reason}`,
      );
    }

    const redis = this.getRedis();

    // Degraded mode: login directly, return handle
    if (!redis || this.degraded) {
      return this.degradedCheckout();
    }

    // Check lockout
    const locked = await redis.get(this.lockoutKey).catch(() => null);
    if (locked) {
      throw new AccountLockedError(
        `Account "${this.account}" is locked out (Redis guard).`,
      );
    }

    // Try CHECKOUT_LUA — find available or stale slot.
    // Catch synchronous Redis connection errors: ioredis throws before the
    // async 'error' event fires when enableOfflineQueue=false and the socket
    // is gone, so this.degraded is still false at throw time.
    let result: [string | null, string?];
    try {
      result = await redis.eval(
        CHECKOUT_LUA,
        1,
        slotsKey(this.keyPrefix),
        this.keyPrefix,
        this.serviceId,
        String(Date.now()),
        String(this.staleCheckoutMs),
        this.slotTtlMs > 0 ? String(Math.ceil(this.slotTtlMs / 1000)) : '0',
      ) as [string | null, string?];
    } catch (err) {
      if (this.isRedisConnectionError(err)) {
        this.degraded = true;
        this.log.warn(
          { err: (err as Error).message },
          'Session pool degraded: Redis connection error during CHECKOUT_LUA eval',
        );
        return this.degradedCheckout();
      }
      throw err;
    }

    if (result[0]) {
      this.log.debug({ slotId: result[0] }, 'Checked out existing slot');
      return {
        slotId: result[0],
        cookie: result[1] ?? '',
        checkedOutBy: this.serviceId,
        checkedOutAt: Date.now(),
        degraded: false,
      };
    }

    // No available slot — check if under capacity.
    // Same synchronous-throw guard for scard().
    let activeCount: number;
    try {
      activeCount = await redis.scard(slotsKey(this.keyPrefix));
    } catch (err) {
      if (this.isRedisConnectionError(err)) {
        this.degraded = true;
        this.log.warn(
          { err: (err as Error).message },
          'Session pool degraded: Redis connection error during scard',
        );
        return this.degradedCheckout();
      }
      throw err;
    }

    if (activeCount < this.maxSize) {
      // Login and create a new slot.
      // Same synchronous-throw guard for CREATE_SLOT_LUA eval().
      const cookie = await this.loginToAcumatica();
      const newSlotId = `slot-${randomUUID().slice(0, 8)}`;
      const now = String(Date.now());
      const ttlSeconds = this.slotTtlMs > 0 ? String(Math.ceil(this.slotTtlMs / 1000)) : '0';

      try {
        await redis.eval(
          CREATE_SLOT_LUA,
          2,
          slotsKey(this.keyPrefix),
          slotKey(this.keyPrefix, newSlotId),
          newSlotId,
          cookie,
          this.serviceId,
          now,
          ttlSeconds,
        );
      } catch (err) {
        if (this.isRedisConnectionError(err)) {
          this.degraded = true;
          this.log.warn(
            { err: (err as Error).message },
            'Session pool degraded: Redis connection error during CREATE_SLOT_LUA eval',
          );
          // Cookie already obtained — hand it back as a degraded slot so the
          // caller does not lose the fresh session.
          const degradedSlotId = `degraded-${randomUUID().slice(0, 8)}`;
          this.localSlots.set(degradedSlotId, {
            cookie,
            checkedOutBy: this.serviceId,
            checkedOutAt: Date.now(),
            createdAt: Date.now(),
          });
          return {
            slotId: degradedSlotId,
            cookie,
            checkedOutBy: this.serviceId,
            checkedOutAt: Date.now(),
            degraded: true,
          };
        }
        throw err;
      }

      this.log.debug({ slotId: newSlotId }, 'Created new pool slot');
      return {
        slotId: newSlotId,
        cookie,
        checkedOutBy: this.serviceId,
        checkedOutAt: Date.now(),
        degraded: false,
      };
    }

    // At capacity — enter polling loop (backpressure)
    return this.waitForSlot(redis, started);
  }

  /** Poll for an available slot until one frees up or timeout */
  private async waitForSlot(redis: Redis, started: number): Promise<SessionHandle> {
    while (true) {
      const elapsed = Date.now() - started;
      if (elapsed > this.checkoutTimeoutMs) {
        this.emit('pool_exhausted', `Timeout after ${elapsed}ms — all ${this.maxSize} slots checked out`);
        throw new SessionPoolExhaustedError(this.account, elapsed);
      }

      await new Promise((r) => setTimeout(r, this.pollIntervalMs));

      // Same synchronous-throw guard for CHECKOUT_LUA inside the poll loop.
      let result: [string | null, string?];
      try {
        result = await redis.eval(
          CHECKOUT_LUA,
          1,
          slotsKey(this.keyPrefix),
          this.keyPrefix,
          this.serviceId,
          String(Date.now()),
          String(this.staleCheckoutMs),
          this.slotTtlMs > 0 ? String(Math.ceil(this.slotTtlMs / 1000)) : '0',
        ) as [string | null, string?];
      } catch (err) {
        if (this.isRedisConnectionError(err)) {
          this.degraded = true;
          this.log.warn(
            { err: (err as Error).message },
            'Session pool degraded: Redis connection error during poll CHECKOUT_LUA eval',
          );
          return this.degradedCheckout();
        }
        throw err;
      }

      if (result[0]) {
        this.log.debug({ slotId: result[0], waitMs: Date.now() - started }, 'Checked out slot after wait');
        return {
          slotId: result[0],
          cookie: result[1] ?? '',
          checkedOutBy: this.serviceId,
          checkedOutAt: Date.now(),
          degraded: false,
        };
      }
    }
  }

  /** Return a session slot to the pool */
  async checkin(handle: SessionHandle): Promise<void> {
    if (handle.degraded) {
      this.localSlots.set(handle.slotId, {
        cookie: handle.cookie,
        checkedOutBy: '',
        checkedOutAt: 0,
        createdAt: Date.now(),
      });
      return;
    }

    const redis = this.getRedis();
    if (!redis || this.degraded) return;

    await redis.eval(
      CHECKIN_LUA,
      1,
      slotKey(this.keyPrefix, handle.slotId),
      String(Date.now()),
      this.slotTtlMs > 0 ? String(Math.ceil(this.slotTtlMs / 1000)) : '0',
    );
    this.log.debug({ slotId: handle.slotId }, 'Checked in slot');
  }

  /**
   * Execute fn while holding a session slot.
   * Checkout → run fn → checkin (in finally).
   * On 401: evict slot, retry once with fresh slot.
   * On AccountLockedError: evict all, trip breaker, re-throw.
   *
   * Fix (v1.2.0): the outer finally block skips checkin if the handle was
   * evicted in the 401-retry branch. Previously CHECKIN_LUA's HSET on the
   * evicted (DEL'd) slot key recreated a zombie hash with no cookie and not
   * in the :slots set — accumulating into the ~89 orphan keys observed in
   * production (2026-06-04). `_evictedSlotIds` tracks evictions within this
   * call so the finally block can skip them safely.
   */
  async withSession<T>(fn: (handle: SessionHandle) => Promise<T>): Promise<T> {
    const handle = await this.checkout();
    // Clear any stale tracking from a previous call on this pool instance
    this._evictedSlotIds.delete(handle.slotId);

    try {
      return await fn(handle);
    } catch (err) {
      // AccountLockedError: evict all slots, trip circuit breaker
      if (err instanceof AccountLockedError) {
        await this.evictAllSlots();
        this.circuitBreaker.trip((err as Error).message);
        this.emit('circuit_trip', (err as Error).message);
        throw err;
      }

      // 401: evict this slot and retry once
      if (this.is401Error(err)) {
        this.log.warn({ slotId: handle.slotId }, 'Session expired (401), evicting and retrying');
        await this.evictSlot(handle.slotId, handle.degraded);
        // Mark this handle as evicted so the outer finally skips checkin
        this._evictedSlotIds.add(handle.slotId);

        // Retry once with a fresh slot
        const retryHandle = await this.checkout();
        try {
          return await fn(retryHandle);
        } finally {
          await this.checkin(retryHandle);
        }
      }

      throw err;
    } finally {
      // Skip checkin if this handle was evicted above.
      // Calling checkin on an evicted (DEL'd) slot key would let CHECKIN_LUA's
      // HSET recreate the key as a zombie hash (no cookie, not in :slots set).
      if (!this._evictedSlotIds.has(handle.slotId)) {
        await this.checkin(handle);
      }
      this._evictedSlotIds.delete(handle.slotId);
    }
  }

  /** Evict a single slot from the pool */
  private async evictSlot(slotId: string, isDegraded: boolean): Promise<void> {
    if (isDegraded) {
      this.localSlots.delete(slotId);
      this.log.debug({ slotId }, 'Evicted local slot (degraded)');
      this.emit('slot_evicted', `Evicted slot ${slotId} (degraded)`);
      return;
    }

    const redis = this.getRedis();
    if (!redis || this.degraded) {
      this.localSlots.delete(slotId);
      return;
    }

    await redis.eval(
      EVICT_SLOT_LUA,
      2,
      slotsKey(this.keyPrefix),
      slotKey(this.keyPrefix, slotId),
      slotId,
    );
    this.log.debug({ slotId }, 'Evicted pool slot');
    this.emit('slot_evicted', `Evicted slot ${slotId}`);
  }

  /** Evict all slots from the pool (lockout scenario) */
  private async evictAllSlots(): Promise<void> {
    const redis = this.getRedis();
    if (!redis || this.degraded) {
      this.localSlots.clear();
      return;
    }

    const slotIds = await redis.smembers(slotsKey(this.keyPrefix));
    for (const sid of slotIds) {
      await this.evictSlot(sid, false);
    }
    this.log.warn({ account: this.account, evicted: slotIds.length }, 'Evicted all pool slots');
  }

  /** Check if error is a 401 Unauthorized */
  private is401Error(err: unknown): boolean {
    return (err as any)?.statusCode === 401;
  }

  /** Get pool status */
  async status(): Promise<PoolStatus> {
    const redis = this.getRedis();

    // Redis mode: read from Redis
    if (redis && !this.degraded) {
      const now = Date.now();
      let activeSlots = 0;
      let checkedOut = 0;
      const slots: PoolStatus['slots'] = [];

      const slotIds = await redis.smembers(slotsKey(this.keyPrefix));
      for (const sid of slotIds) {
        const slotData = await redis.hgetall(slotKey(this.keyPrefix, sid));
        if (!slotData || !slotData.createdAt) continue;
        activeSlots++;
        const isCheckedOut = slotData.checkedOutBy !== '';
        if (isCheckedOut) checkedOut++;
        slots.push({
          id: sid,
          ageMs: now - parseInt(slotData.createdAt, 10),
          checkedOutBy: slotData.checkedOutBy,
          idle: !isCheckedOut,
        });
      }

      return {
        account: this.account,
        maxSize: this.maxSize,
        activeSlots,
        checkedOut,
        available: activeSlots - checkedOut,
        circuitBreaker: this.circuitBreaker.currentState,
        degraded: false,
        slots,
      };
    }

    // Degraded mode: report from local state
    let activeSlots = 0;
    let checkedOut = 0;
    const slots: PoolStatus['slots'] = [];

    for (const [sid, slot] of this.localSlots) {
      activeSlots++;
      const isCheckedOut = slot.checkedOutBy !== '';
      if (isCheckedOut) checkedOut++;
      slots.push({
        id: sid,
        ageMs: Date.now() - slot.createdAt,
        checkedOutBy: slot.checkedOutBy,
        idle: !isCheckedOut,
      });
    }

    return {
      account: this.account,
      maxSize: this.maxSize,
      activeSlots,
      checkedOut,
      available: activeSlots - checkedOut,
      circuitBreaker: this.circuitBreaker.currentState,
      degraded: this.degraded || !this.redisUrl,
      slots,
    };
  }

  /** Degraded checkout: login directly, track locally, enforce capacity */
  private async degradedCheckout(): Promise<SessionHandle> {
    const started = Date.now();

    while (true) {
      const now = Date.now();

      // Try to reuse a local available slot, or reclaim stale
      for (const [sid, slot] of this.localSlots) {
        if (slot.checkedOutBy === '') {
          slot.checkedOutBy = this.serviceId;
          slot.checkedOutAt = now;
          this.log.debug({ slotId: sid }, 'Reused local slot (degraded)');
          return {
            slotId: sid,
            cookie: slot.cookie,
            checkedOutBy: this.serviceId,
            checkedOutAt: now,
            degraded: true,
          };
        }
        // Check for stale checkout
        if (slot.checkedOutAt > 0 && (now - slot.checkedOutAt) > this.staleCheckoutMs) {
          slot.checkedOutBy = this.serviceId;
          slot.checkedOutAt = now;
          this.log.debug({ slotId: sid }, 'Reclaimed stale local slot (degraded)');
          this.emit('stale_reclaimed', `Reclaimed stale slot ${sid}`);
          return {
            slotId: sid,
            cookie: slot.cookie,
            checkedOutBy: this.serviceId,
            checkedOutAt: now,
            degraded: true,
          };
        }
      }

      // Under capacity — login and create new slot
      if (this.localSlots.size < this.maxSize) {
        const cookie = await this.loginToAcumatica();
        const slotId = `degraded-${randomUUID().slice(0, 8)}`;
        this.localSlots.set(slotId, {
          cookie,
          checkedOutBy: this.serviceId,
          checkedOutAt: now,
          createdAt: now,
        });
        return {
          slotId,
          cookie,
          checkedOutBy: this.serviceId,
          checkedOutAt: now,
          degraded: true,
        };
      }

      // At capacity — wait with backpressure
      const elapsed = now - started;
      if (elapsed > this.checkoutTimeoutMs) {
        this.emit('pool_exhausted', `Timeout after ${elapsed}ms — all ${this.maxSize} slots checked out (degraded)`);
        throw new SessionPoolExhaustedError(this.account, elapsed);
      }

      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}
