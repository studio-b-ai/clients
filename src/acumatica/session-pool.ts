/**
 * Per-account Acumatica session pool with Redis-backed cookie reuse.
 *
 * Replaces the pattern of login→work→logout on every request with
 * checkout→work→checkin, reusing session cookies across requests.
 * Each account gets its own pool with configurable max slots.
 *
 * Redis data model:
 *   acumatica:pool:{account}:meta    — hash (maxSize, activeLogins)
 *   acumatica:pool:{account}:slots   — set of active slot IDs
 *   acumatica:pool:{account}:slot:{id} — hash (cookie, timestamps, checkout state)
 *   acumatica:lockout:{account}      — string with TTL (circuit breaker lockout)
 *   acumatica:pool:{account}:login-failures — string with TTL (failure counter)
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

function metaKey(account: string): string {
  return `acumatica:pool:${account}:meta`;
}

function slotsKey(account: string): string {
  return `acumatica:pool:${account}:slots`;
}

function slotKey(account: string, slotId: string): string {
  return `acumatica:pool:${account}:slot:${slotId}`;
}

function lockoutKey(account: string): string {
  return `acumatica:lockout:${account}`;
}

function loginFailuresKey(account: string): string {
  return `acumatica:pool:${account}:login-failures`;
}

// -- Lua scripts --

/**
 * CHECKOUT_LUA: Find an available slot (checkedOutBy == "") or reclaim a stale one.
 * KEYS[1] = slotsKey, ARGV[1] = account, ARGV[2] = serviceId, ARGV[3] = now, ARGV[4] = staleMs
 * Returns: [slotId, cookie] or [nil] if none available.
 */
const CHECKOUT_LUA = `
  local slotsKey = KEYS[1]
  local account = ARGV[1]
  local serviceId = ARGV[2]
  local now = tonumber(ARGV[3])
  local staleMs = tonumber(ARGV[4])

  local slotIds = redis.call('SMEMBERS', slotsKey)
  for _, sid in ipairs(slotIds) do
    local sk = 'acumatica:pool:' .. account .. ':slot:' .. sid
    local checkedOutBy = redis.call('HGET', sk, 'checkedOutBy')
    if checkedOutBy == '' or checkedOutBy == false then
      -- Available slot: check it out
      redis.call('HSET', sk, 'checkedOutBy', serviceId, 'checkedOutAt', tostring(now))
      local cookie = redis.call('HGET', sk, 'cookie')
      return {sid, cookie or ''}
    else
      -- Check for stale checkout
      local checkedOutAt = tonumber(redis.call('HGET', sk, 'checkedOutAt') or '0')
      if checkedOutAt > 0 and (now - checkedOutAt) > staleMs then
        -- Reclaim stale slot
        redis.call('HSET', sk, 'checkedOutBy', serviceId, 'checkedOutAt', tostring(now))
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
 */
const CHECKIN_LUA = `
  local sk = KEYS[1]
  redis.call('HSET', sk, 'checkedOutBy', '', 'checkedOutAt', '0', 'lastUsedAt', ARGV[1])
  return 1
`;

/**
 * CREATE_SLOT_LUA: Create a new slot and add to the index.
 * KEYS[1] = slotsKey, KEYS[2] = slotKey
 * ARGV[1] = slotId, ARGV[2] = cookie, ARGV[3] = serviceId, ARGV[4] = now
 */
const CREATE_SLOT_LUA = `
  local slotsKey = KEYS[1]
  local sk = KEYS[2]
  local slotId = ARGV[1]
  local cookie = ARGV[2]
  local serviceId = ARGV[3]
  local now = ARGV[4]

  redis.call('SADD', slotsKey, slotId)
  redis.call('HSET', sk,
    'cookie', cookie,
    'createdAt', now,
    'lastUsedAt', now,
    'checkedOutBy', serviceId,
    'checkedOutAt', now)
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

// -- SessionPool --

export class SessionPool {
  readonly account: string;
  readonly maxSize: number;
  readonly staleCheckoutMs: number;
  readonly checkoutTimeoutMs: number;
  readonly pollIntervalMs: number;

  private credentials: PoolConfig['credentials'];
  private redisUrl: string;
  private serviceId: string;
  private redis: Redis | null = null;
  private degraded = false;
  private log: Logger;
  readonly circuitBreaker: AcumaticaCircuitBreaker;

  /** In-memory slot store for degraded mode (no Redis) */
  private localSlots = new Map<string, { cookie: string; checkedOutBy: string; checkedOutAt: number; createdAt: number }>();

  /** Test hook to replace the HTTP login call */
  private loginFn: (() => Promise<string>) | null = null;

  constructor(config: PoolConfig) {
    this.account = config.account;
    this.maxSize = config.maxSize;
    this.credentials = config.credentials;
    this.redisUrl = config.redisUrl;
    this.serviceId = config.serviceId;
    this.staleCheckoutMs = config.staleCheckoutMs ?? 120_000;
    this.checkoutTimeoutMs = config.checkoutTimeoutMs ?? 30_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.log = config.logger ?? pino({ name: `session-pool:${config.account}` });
    this.circuitBreaker = new AcumaticaCircuitBreaker();
  }

  /** Test hook: replace HTTP login with a mock function */
  _setLoginFn(fn: () => Promise<string>): void {
    this.loginFn = fn;
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

  /** Checkout a session slot. Returns a handle with cookie. */
  async checkout(): Promise<SessionHandle> {
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
    const locked = await redis.get(lockoutKey(this.account)).catch(() => null);
    if (locked) {
      throw new AccountLockedError(
        `Account "${this.account}" is locked out (Redis guard).`,
      );
    }

    // Try CHECKOUT_LUA — find available or stale slot
    const result = await redis.eval(
      CHECKOUT_LUA,
      1,
      slotsKey(this.account),
      this.account,
      this.serviceId,
      String(Date.now()),
      String(this.staleCheckoutMs),
    ) as [string | null, string?];

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

    // No available slot — check if under capacity
    const activeCount = await redis.scard(slotsKey(this.account));
    if (activeCount < this.maxSize) {
      // Login and create a new slot
      const cookie = await this.loginToAcumatica();
      const newSlotId = `slot-${randomUUID().slice(0, 8)}`;
      const now = String(Date.now());

      await redis.eval(
        CREATE_SLOT_LUA,
        2,
        slotsKey(this.account),
        slotKey(this.account, newSlotId),
        newSlotId,
        cookie,
        this.serviceId,
        now,
      );

      this.log.debug({ slotId: newSlotId }, 'Created new pool slot');
      return {
        slotId: newSlotId,
        cookie,
        checkedOutBy: this.serviceId,
        checkedOutAt: Date.now(),
        degraded: false,
      };
    }

    // At capacity — will be handled by backpressure in Task 5
    throw new SessionPoolExhaustedError(this.account, 0);
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
      slotKey(this.account, handle.slotId),
      String(Date.now()),
    );
    this.log.debug({ slotId: handle.slotId }, 'Checked in slot');
  }

  /** Degraded checkout: login directly, track locally */
  private async degradedCheckout(): Promise<SessionHandle> {
    // Try to reuse a local available slot
    for (const [sid, slot] of this.localSlots) {
      if (slot.checkedOutBy === '') {
        slot.checkedOutBy = this.serviceId;
        slot.checkedOutAt = Date.now();
        this.log.debug({ slotId: sid }, 'Reused local slot (degraded)');
        return {
          slotId: sid,
          cookie: slot.cookie,
          checkedOutBy: this.serviceId,
          checkedOutAt: Date.now(),
          degraded: true,
        };
      }
    }

    // No available local slot — login
    const cookie = await this.loginToAcumatica();
    const slotId = `degraded-${randomUUID().slice(0, 8)}`;
    this.localSlots.set(slotId, {
      cookie,
      checkedOutBy: this.serviceId,
      checkedOutAt: Date.now(),
      createdAt: Date.now(),
    });
    return {
      slotId,
      cookie,
      checkedOutBy: this.serviceId,
      checkedOutAt: Date.now(),
      degraded: true,
    };
  }
}
