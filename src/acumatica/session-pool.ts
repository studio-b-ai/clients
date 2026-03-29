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
}
