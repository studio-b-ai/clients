import { describe, it, expect } from 'vitest';
import { SessionPool, type SessionHandle } from '../session-pool.js';

describe('SessionPool', () => {
  describe('types and construction', () => {
    it('should construct with required config', () => {
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
      });
      expect(pool).toBeDefined();
      expect(pool.account).toBe('api-bot');
      expect(pool.maxSize).toBe(3);
    });

    it('should use default values for optional config', () => {
      const pool = new SessionPool({
        account: 'api-bot',
        maxSize: 3,
        credentials: {
          baseUrl: 'https://test.acumatica.com',
          username: 'api-bot',
          password: 'secret',
        },
        redisUrl: '',
        serviceId: 'test-service',
      });
      expect(pool.staleCheckoutMs).toBe(120_000);
      expect(pool.checkoutTimeoutMs).toBe(30_000);
    });
  });
});
