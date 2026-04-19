import { describe, it, expect } from 'vitest';
import { AcumaticaClient } from '../client.js';
import { poolLockoutKey } from '../session-pool.js';

function makeClient(config: { baseUrl: string; username: string; password: string; tenant?: string }) {
  return new AcumaticaClient({ config: { ...config, apiVersion: '24.200.001' } });
}

describe('AcumaticaClient per-tenant lockout key', () => {
  it('derives lockoutKey from (baseUrl, username, tenant) matching poolLockoutKey', () => {
    const c = makeClient({
      baseUrl: 'https://heritagefabrics.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });
    expect(c.lockoutKey).toBe(
      poolLockoutKey(
        'https://heritagefabrics.acumatica.com',
        'api-bot',
        'Heritage Fabrics',
      ),
    );
  });

  it('two clients on the same instance but different tenants have different lockout keys', () => {
    const prod = makeClient({
      baseUrl: 'https://heritagefabrics.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });
    const test = makeClient({
      baseUrl: 'https://heritagefabrics.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Test',
    });
    expect(prod.lockoutKey).not.toBe(test.lockoutKey);
    expect(prod.loginFailuresKey).not.toBe(test.loginFailuresKey);
  });

  it('two clients on different instances have different lockout keys', () => {
    const a = makeClient({
      baseUrl: 'https://hf.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });
    const b = makeClient({
      baseUrl: 'https://roth.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });
    expect(a.lockoutKey).not.toBe(b.lockoutKey);
  });

  it('scoped lockout key is never the legacy global key', () => {
    const c = makeClient({
      baseUrl: 'https://heritagefabrics.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });
    expect(c.lockoutKey).not.toBe('acumatica:lockout');
    expect(c.loginFailuresKey).not.toBe('acumatica:login-failures');
  });

  it('reads `locked` if EITHER the legacy global key or the scoped key is set', async () => {
    const c = makeClient({
      baseUrl: 'https://heritagefabrics.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });

    // Fake Redis: only the legacy global key set — simulates webhook-router or
    // maintenance.ts manually pausing operations.
    const globalOnly: Record<string, string> = { 'acumatica:lockout': 'paused' };
    c.setRedisForTesting({
      get: async (k: string) => globalOnly[k] ?? null,
      set: async () => 'OK',
    });
    expect(await c.isLockedForTesting()).toBe(true);

    // Only scoped key set — simulates a future multi-tenant setter.
    const scopedOnly: Record<string, string> = { [c.lockoutKey]: 'paused' };
    c.setRedisForTesting({
      get: async (k: string) => scopedOnly[k] ?? null,
      set: async () => 'OK',
    });
    expect(await c.isLockedForTesting()).toBe(true);

    // Neither set → not locked.
    const empty: Record<string, string> = {};
    c.setRedisForTesting({
      get: async (k: string) => empty[k] ?? null,
      set: async () => 'OK',
    });
    expect(await c.isLockedForTesting()).toBe(false);
  });

  it('writes lockout flag to BOTH legacy global and scoped keys (back-compat dual-write)', async () => {
    const c = makeClient({
      baseUrl: 'https://heritagefabrics.acumatica.com',
      username: 'api-bot',
      password: 'secret',
      tenant: 'Heritage Fabrics',
    });
    const store: Record<string, string> = {};
    c.setRedisForTesting({
      get: async (k: string) => store[k] ?? null,
      set: async (k: string, v: string) => {
        store[k] = v;
        return 'OK';
      },
    });
    await c.setLockoutForTesting('unit-test');
    expect(store['acumatica:lockout']).toBeDefined();
    expect(store[c.lockoutKey]).toBeDefined();
  });
});
