/**
 * Acumatica API Session Gate -- Redis-based distributed semaphore.
 *
 * Prevents "API Login Limit" errors by coordinating concurrent Acumatica
 * sessions across multiple services. Uses a Redis sorted set with
 * TTL-based lease expiration and atomic Lua scripts.
 *
 * Extracted from acumatica-mcp/src/lib/session-gate.ts
 * Adapted: accepts redisUrl as constructor parameter (no global config import).
 */

import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { Logger } from 'pino';

const GATE_KEY = 'acumatica:session-gate';

// -- Lua Scripts (atomic Redis operations) --

/** Prune expired leases, then acquire if under capacity */
const ACQUIRE_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[2]) then
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
    return 1
  end
  return 0
`;

/** Remove a lease */
const RELEASE_LUA = `
  return redis.call('ZREM', KEYS[1], ARGV[1])
`;

/** Extend lease TTL if it still exists */
const RENEW_LUA = `
  local exists = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if exists then
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
    return 1
  end
  return 0
`;

/** Get count + all lease holder IDs */
const STATUS_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local members = redis.call('ZRANGE', KEYS[1], 0, -1)
  return members
`;

// -- Types --

export interface Lease {
  id: string;
  acquiredAt: number;
  expiresAt: number;
  degraded: boolean;
}

export interface GateStatus {
  active: number;
  max: number;
  holders: string[];
  degraded: boolean;
}

export class SessionGateTimeoutError extends Error {
  serviceId: string;
  waitMs: number;
  activeHolders: string[];

  constructor(serviceId: string, waitMs: number, activeHolders: string[]) {
    super(
      `Session gate timeout after ${waitMs}ms -- all ${activeHolders.length} slots occupied`,
    );
    this.name = 'SessionGateTimeoutError';
    this.serviceId = serviceId;
    this.waitMs = waitMs;
    this.activeHolders = activeHolders;
  }
}

// -- Session Gate --

export interface SessionGateOptions {
  serviceId: string;
  redisUrl: string;
  maxConcurrent?: number;
  leaseTtlMs?: number;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  logger?: Logger;
}

export class SessionGate {
  private serviceId: string;
  private maxConcurrent: number;
  private leaseTtlMs: number;
  private acquireTimeoutMs: number;
  private pollIntervalMs: number;
  private redis: Redis | null = null;
  private redisUrl: string;
  private activeLeases = new Set<string>();
  private degraded = false;
  private log: Logger;

  constructor(opts: SessionGateOptions) {
    this.serviceId = opts.serviceId;
    this.redisUrl = opts.redisUrl;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.leaseTtlMs = opts.leaseTtlMs ?? 120_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 90_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.log = opts.logger ?? pino({ name: 'session-gate' });
  }

  /** Lazy-connect to Redis. Returns null if unreachable. */
  private getRedis(): Redis | null {
    if (this.redis) return this.redis;
    if (this.degraded) return null;
    if (!this.redisUrl) {
      this.degraded = true;
      this.log.warn('Session gate degraded: no REDIS_URL configured');
      return null;
    }

    try {
      this.redis = new Redis(this.redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times > 2) {
            this.degraded = true;
            this.log.warn('Session gate degraded: Redis connection failed');
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        enableOfflineQueue: false,
      });

      this.redis.on('error', (err: Error) => {
        if (!this.degraded) {
          this.degraded = true;
          this.log.warn({ err: err.message }, 'Session gate degraded');
        }
      });

      return this.redis;
    } catch (err) {
      this.degraded = true;
      this.log.warn(
        { err: (err as Error).message },
        'Session gate degraded: init failed',
      );
      return null;
    }
  }

  /** Create a degraded lease (no Redis coordination). */
  private degradedLease(): Lease {
    const lease: Lease = {
      id: `${this.serviceId}:degraded:${randomUUID()}`,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + this.leaseTtlMs,
      degraded: true,
    };
    this.activeLeases.add(lease.id);
    return lease;
  }

  /** Acquire a session lease. Blocks until slot available or timeout. */
  async acquire(): Promise<Lease> {
    const redis = this.getRedis();
    if (!redis || this.degraded) return this.degradedLease();

    const leaseId = `${this.serviceId}:${randomUUID()}`;
    const started = Date.now();

    while (true) {
      const now = Date.now();
      const elapsed = now - started;

      if (elapsed > this.acquireTimeoutMs) {
        let holders: string[] = [];
        try {
          holders = (await redis.eval(
            STATUS_LUA,
            1,
            GATE_KEY,
            String(now),
          )) as string[];
        } catch {
          /* best effort */
        }
        throw new SessionGateTimeoutError(this.serviceId, elapsed, holders);
      }

      try {
        const expiresAt = now + this.leaseTtlMs;
        const acquired = await redis.eval(
          ACQUIRE_LUA,
          1,
          GATE_KEY,
          String(now),
          String(this.maxConcurrent),
          String(expiresAt),
          leaseId,
        );

        if (acquired === 1) {
          const lease: Lease = {
            id: leaseId,
            acquiredAt: now,
            expiresAt,
            degraded: false,
          };
          this.activeLeases.add(leaseId);
          this.log.debug(
            { leaseId, waitMs: elapsed },
            'Session gate: acquired',
          );
          return lease;
        }

        // Slot not available -- wait and retry
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      } catch (err) {
        if (err instanceof SessionGateTimeoutError) throw err;
        this.log.warn(
          { err: (err as Error).message },
          'Session gate degraded during acquire',
        );
        this.degraded = true;
        return this.degradedLease();
      }
    }
  }

  /** Release a session lease. Idempotent. */
  async release(lease: Lease): Promise<void> {
    if (!lease) return;
    this.activeLeases.delete(lease.id);
    if (lease.degraded) return;

    const redis = this.getRedis();
    if (!redis || this.degraded) return;

    try {
      await redis.eval(RELEASE_LUA, 1, GATE_KEY, lease.id);
      this.log.debug(
        { leaseId: lease.id, heldMs: Date.now() - lease.acquiredAt },
        'Session gate: released',
      );
    } catch (err) {
      this.log.warn(
        { leaseId: lease.id, err: (err as Error).message },
        'Session gate: release failed',
      );
    }
  }

  /** Extend lease TTL for long-running operations. */
  async renew(lease: Lease, extensionMs?: number): Promise<void> {
    if (!lease || lease.degraded) return;
    const redis = this.getRedis();
    if (!redis || this.degraded) return;

    const newExpiry = Date.now() + (extensionMs ?? this.leaseTtlMs);
    try {
      const renewed = await redis.eval(
        RENEW_LUA,
        1,
        GATE_KEY,
        lease.id,
        String(newExpiry),
      );
      if (renewed === 1) lease.expiresAt = newExpiry;
    } catch (err) {
      this.log.warn(
        { leaseId: lease.id, err: (err as Error).message },
        'Session gate: renew failed',
      );
    }
  }

  /** Execute fn while holding a session lease. */
  async withSession<T>(fn: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await fn(lease);
    } finally {
      await this.release(lease);
    }
  }

  /** Get current gate status. */
  async status(): Promise<GateStatus> {
    const redis = this.getRedis();
    if (!redis || this.degraded) {
      return {
        active: this.activeLeases.size,
        max: this.maxConcurrent,
        holders: [...this.activeLeases],
        degraded: true,
      };
    }

    try {
      const holders = (await redis.eval(
        STATUS_LUA,
        1,
        GATE_KEY,
        String(Date.now()),
      )) as string[];
      return {
        active: holders.length,
        max: this.maxConcurrent,
        holders,
        degraded: false,
      };
    } catch {
      return {
        active: this.activeLeases.size,
        max: this.maxConcurrent,
        holders: [...this.activeLeases],
        degraded: true,
      };
    }
  }

  /** Graceful shutdown -- release all leases and disconnect Redis. */
  async shutdown(): Promise<void> {
    for (const leaseId of this.activeLeases) {
      await this.release({
        id: leaseId,
        acquiredAt: 0,
        expiresAt: 0,
        degraded: false,
      });
    }
    this.activeLeases.clear();

    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        try {
          this.redis.disconnect();
        } catch {
          /* best effort */
        }
      }
      this.redis = null;
    }
  }
}
