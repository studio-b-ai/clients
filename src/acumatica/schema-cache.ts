/**
 * Redis-backed schema cache for Acumatica entity schemas.
 *
 * Caches entity field definitions to avoid repeated API calls.
 * Schema only changes on customization project publish.
 *
 * Extracted from acumatica-mcp/src/lib/schema-cache.ts
 * Adapted: accepts redisUrl and ttlHours as constructor parameters (no global config import).
 */

import { Redis } from 'ioredis';
import pino from 'pino';
import type { Logger } from 'pino';

const CACHE_PREFIX = 'acumatica:schema:';

export interface SchemaCacheOptions {
  /** Redis connection URL. If empty/undefined, cache runs in degraded (no-op) mode. */
  redisUrl?: string;
  /** TTL for cached schemas in hours. Default: 24 */
  ttlHours?: number;
  /** Logger instance */
  logger?: Logger;
}

export class SchemaCache {
  private redis: Redis | null = null;
  private degraded = false;
  private log: Logger;
  private ttlSeconds: number;
  private ttlHours: number;

  constructor(opts: SchemaCacheOptions = {}) {
    this.log = opts.logger ?? pino({ name: 'schema-cache' });
    this.ttlHours = opts.ttlHours ?? 24;
    this.ttlSeconds = this.ttlHours * 3600;

    if (!opts.redisUrl) {
      this.degraded = true;
      this.log.warn('Schema cache disabled: no Redis URL provided');
      return;
    }

    try {
      this.redis = new Redis(opts.redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times > 2) {
            this.degraded = true;
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        enableOfflineQueue: false,
      });

      this.redis.on('error', () => {
        if (!this.degraded) {
          this.degraded = true;
          this.log.warn('Schema cache degraded: Redis error');
        }
      });
    } catch {
      this.degraded = true;
    }
  }

  /** Get cached schema. Returns null on miss. */
  async get(entity: string): Promise<unknown | null> {
    if (!this.redis || this.degraded) return null;

    try {
      const data = await this.redis.get(`${CACHE_PREFIX}${entity}`);
      if (data) {
        this.log.debug({ entity }, 'Schema cache hit');
        return JSON.parse(data);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Set cached schema with TTL. */
  async set(entity: string, schema: unknown): Promise<void> {
    if (!this.redis || this.degraded) return;

    try {
      await this.redis.set(
        `${CACHE_PREFIX}${entity}`,
        JSON.stringify(schema),
        'EX',
        this.ttlSeconds,
      );
      this.log.debug({ entity, ttlHours: this.ttlHours }, 'Schema cached');
    } catch {
      // Best effort
    }
  }

  /** Clear cache for a specific entity or all. Returns number of keys cleared. */
  async clear(entity?: string): Promise<number> {
    if (!this.redis || this.degraded) return 0;

    try {
      if (entity) {
        return await this.redis.del(`${CACHE_PREFIX}${entity}`);
      }
      // Clear all schema keys
      const keys = await this.redis.keys(`${CACHE_PREFIX}*`);
      if (keys.length === 0) return 0;
      return await this.redis.del(...keys);
    } catch {
      return 0;
    }
  }

  /** Get cache stats for health endpoint. */
  async stats(): Promise<{ cached: number; degraded: boolean }> {
    if (!this.redis || this.degraded) {
      return { cached: 0, degraded: true };
    }
    try {
      const keys = await this.redis.keys(`${CACHE_PREFIX}*`);
      return { cached: keys.length, degraded: false };
    } catch {
      return { cached: 0, degraded: true };
    }
  }

  async shutdown(): Promise<void> {
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
