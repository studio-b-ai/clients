/**
 * Tests for pool-managed AcumaticaClient (initialCookies option).
 *
 * Pool-managed clients skip the internal login/re-login cycle.
 * On session expiry (proactive TTL or 401 response) they throw
 * PooledSessionExpiredError instead of re-logging in, so the SessionPool
 * can evict the slot and retry with a fresh one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockModule } from 'vitest';
import { AcumaticaClient, PooledSessionExpiredError } from '../client.js';

const BASE_CONFIG = {
  baseUrl: 'https://test.acumatica.com',
  username: 'api-bot',
  password: 'secret',
  tenant: 'TestCo',
  apiVersion: '24.200.001' as const,
};

/**
 * Build a minimal undici mock that returns the provided response shape.
 * We mock the `undici` module's `request` function directly.
 */
function makeUndiciMock(overrides: { status?: number; body?: string; headers?: Record<string, string> } = {}) {
  const status = overrides.status ?? 200;
  const body = overrides.body ?? '{}';
  const headers = overrides.headers ?? { 'content-type': 'application/json' };

  return {
    statusCode: status,
    headers,
    body: { text: async () => body },
  };
}

describe('pool-managed AcumaticaClient', () => {
  describe('1. Pre-seeded cookie is used — no HTTP call on login()', () => {
    it('uses initialCookies, marks loggedIn=true, and skips the HTTP login endpoint', async () => {
      const requestSpy = vi.fn().mockResolvedValue(makeUndiciMock());

      // Patch undici at module level using vi.mock hoisting workaround:
      // We spy on the actual undici request by monkey-patching it via module mock.
      // Because vitest ESM mocking requires static imports, we use a different approach:
      // create the client, then intercept at the httpRequest level by stubbing
      // the Agent's dispatch path — instead we test the observable contract.

      const client = new AcumaticaClient({
        config: BASE_CONFIG,
        initialCookies: 'session=abc123',
      });

      // isLoggedIn() should be true immediately after construction
      expect(client.isLoggedIn()).toBe(true);

      // login() is a no-op for pool-managed clients (ensureLoggedIn returns early
      // because loggedIn is already true and not near TTL expiry yet)
      // We verify no network call is made by confirming the client stays logged in
      // without any throw.
      await expect(client.login()).resolves.toBeUndefined();

      // Still logged in — no re-login attempt
      expect(client.isLoggedIn()).toBe(true);
    });
  });

  describe('2. PooledSessionExpiredError on 401 response', () => {
    it('throws PooledSessionExpiredError (not re-login) when a request returns 401', async () => {
      // Construct pool-managed client
      const client = new AcumaticaClient({
        config: BASE_CONFIG,
        initialCookies: 'session=expired',
      });

      // Simulate what happens when ensureLoggedIn is called after loggedIn is
      // cleared by a 401 mid-request: the get() method sets loggedIn=false then
      // calls ensureLoggedIn() again. For a pool-managed client, that second call
      // must throw PooledSessionExpiredError.
      //
      // We test this by manually tripping the state (as the 401 handler does)
      // then calling login() which delegates to ensureLoggedIn().
      (client as unknown as { loggedIn: boolean }).loggedIn = false;
      (client as unknown as { cookies: string }).cookies = '';

      await expect(client.login()).rejects.toThrow(PooledSessionExpiredError);
    });

    it('PooledSessionExpiredError has statusCode === 401', () => {
      const err = new PooledSessionExpiredError();
      expect(err.statusCode).toBe(401);
      expect(err.name).toBe('PooledSessionExpiredError');
      expect(err instanceof Error).toBe(true);
    });

    it('PooledSessionExpiredError is detected by statusCode check (like SessionPool.is401Error())', () => {
      const err = new PooledSessionExpiredError();
      // Simulate the pattern SessionPool.is401Error() uses
      const is401 = (e: unknown) =>
        typeof e === 'object' && e !== null && (e as { statusCode?: number }).statusCode === 401;
      expect(is401(err)).toBe(true);
    });
  });

  describe('3. PooledSessionExpiredError on proactive TTL refresh', () => {
    it('throws PooledSessionExpiredError when sessionRefreshMinutes is essentially 0', async () => {
      const client = new AcumaticaClient({
        config: BASE_CONFIG,
        initialCookies: 'session=stale',
        // 0.001 minutes = 60ms — expires essentially immediately
        sessionRefreshMinutes: 0.001,
      });

      // Wait long enough for the proactive refresh threshold to be crossed
      await new Promise((r) => setTimeout(r, 100));

      // ensureLoggedIn() will see loggedIn=true but (Date.now() - sessionStart > refreshMs),
      // set loggedIn=false, then hit the poolManaged guard and throw
      await expect(client.login()).rejects.toThrow(PooledSessionExpiredError);
    });

    it('still logged in before TTL expires', async () => {
      const client = new AcumaticaClient({
        config: BASE_CONFIG,
        initialCookies: 'session=fresh',
        // 60 minutes — won't expire during this test
        sessionRefreshMinutes: 60,
      });

      expect(client.isLoggedIn()).toBe(true);
      await expect(client.login()).resolves.toBeUndefined();
      expect(client.isLoggedIn()).toBe(true);
    });
  });

  describe('4. Normal (non-pool-managed) client is unaffected', () => {
    it('poolManaged logic does not interfere with a client constructed without initialCookies', async () => {
      const client = new AcumaticaClient({
        config: BASE_CONFIG,
      });

      // Should start NOT logged in
      expect(client.isLoggedIn()).toBe(false);

      // ensureLoggedIn() will proceed to loginWithRetry() and fail because there
      // is no real server — but it must NOT throw PooledSessionExpiredError.
      // It should throw a regular network/login error, proving the pool guard
      // is not active.
      let thrown: unknown;
      try {
        await client.login();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(thrown instanceof PooledSessionExpiredError).toBe(false);
      // Should be a regular error (network failure, connect error, etc.)
      expect(thrown instanceof Error).toBe(true);
    });

    it('non-pool client with loggedIn=false does NOT throw PooledSessionExpiredError', async () => {
      const client = new AcumaticaClient({
        config: BASE_CONFIG,
      });

      // Manually set loggedIn=false (as if session expired naturally)
      (client as unknown as { loggedIn: boolean }).loggedIn = false;

      let thrown: unknown;
      try {
        await client.login();
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof PooledSessionExpiredError).toBe(false);
    });
  });

  describe('5. PooledSessionExpiredError export', () => {
    it('is exported from the acumatica client module', () => {
      expect(PooledSessionExpiredError).toBeDefined();
      expect(typeof PooledSessionExpiredError).toBe('function');
    });
  });
});
