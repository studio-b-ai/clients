/**
 * Acumatica REST API client with cookie-based session auth.
 *
 * Features:
 *   - Cookie-based .ASPXAUTH session management
 *   - Session TTL tracking with proactive refresh
 *   - Login retry with progressive backoff on "API Login Limit"
 *   - API call counter with per-cycle/hour/day budgets
 *   - Auto value wrap/unwrap
 *   - Explicit logout() to release session slots
 *
 * Extracted from acumatica-mcp/src/lib/acumatica-client.ts
 * Adapted: accepts AcumaticaConfig in constructor (no global config import).
 * Uses undici instead of axios (Node 22 native fetch drops Acumatica cookies).
 */

import { Agent, request as undiciRequest } from 'undici';
import pino from 'pino';
import type { Logger } from 'pino';
import type { AcumaticaConfig } from '../shared/config.js';
import { wrap, unwrap } from './value-wrapper.js';
import { matchError, genericError, AccountLockedError, type AcumaticaError } from './error-handler.js';
import { AcumaticaCircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

// -- Call Counter --

export class CallCounter {
  perCycle = 0;
  perHour = 0;
  perDay = 0;
  private hourStart = Date.now();
  private dayStart = Date.now();
  readonly budgets: { perCycle: number; perHour: number; perDay: number };

  constructor(budgets?: { perCycle: number; perHour: number; perDay: number }) {
    this.budgets = budgets ?? { perCycle: 200, perHour: 500, perDay: 3000 };
  }

  private rollover() {
    const now = Date.now();
    if (now - this.hourStart > 3_600_000) {
      this.perHour = 0;
      this.hourStart = now;
    }
    if (now - this.dayStart > 86_400_000) {
      this.perDay = 0;
      this.perCycle = 0; // reset cycle counter daily to prevent accumulation
      this.dayStart = now;
    }
  }

  tick() {
    this.rollover();
    this.perCycle++;
    this.perHour++;
    this.perDay++;
  }

  isOverBudget(): boolean {
    this.rollover();
    return (
      this.perCycle >= this.budgets.perCycle ||
      this.perHour >= this.budgets.perHour ||
      this.perDay >= this.budgets.perDay
    );
  }

  resetCycle() {
    this.perCycle = 0;
  }

  stats() {
    this.rollover();
    return {
      perCycle: this.perCycle,
      perHour: this.perHour,
      perDay: this.perDay,
      budgets: this.budgets,
    };
  }
}

// -- Client Options --

export interface AcumaticaClientOptions {
  /** Acumatica connection configuration */
  config: AcumaticaConfig;
  /** API endpoint name. Default: 'default' */
  endpoint?: string;
  /** Request timeout in ms. Default: 60000 */
  requestTimeoutMs?: number;
  /** Session refresh interval in minutes. Default: 15 */
  sessionRefreshMinutes?: number;
  /** Logger instance */
  logger?: Logger;
  /** API call budget overrides (per-cycle/hour/day limits) */
  budget?: { perCycle: number; perHour: number; perDay: number };
  /**
   * Optional Redis instance for lockout guard coordination.
   * When provided, the client will:
   * - Check `acumatica:lockout` before login (skip if locked)
   * - Set `acumatica:lockout` on AccountLockedError (pause all services)
   * If not provided, lockout guard is disabled (standalone mode).
   */
  redis?: { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: unknown[]): Promise<unknown>; };
}

// -- Client --

const LOGIN_RETRY_DELAYS = [10_000, 30_000, 60_000];

// Lockout guard constants (shared with webhook-router lockout-guard.ts)
const LOCKOUT_KEY = 'acumatica:lockout';
const LOCKOUT_TTL_SECONDS = 600; // 10 minutes
const LOGIN_FAILURES_KEY = 'acumatica:login-failures';
const LOGIN_BUDGET_TTL_SECONDS = 1800; // 30-min sliding window
const LOGIN_BUDGET_MAX = 5; // was: 1 — single transient error shouldn't brick env

export class AcumaticaClient {
  private baseUrl: string;
  private apiBase: string;
  private username: string;
  private password: string;
  private tenant: string;
  private loggedIn = false;
  private cookies = '';
  private sessionStart = 0;
  private loggingIn = false;
  private loginPromise: Promise<void> | null = null;
  private agent: Agent;
  private sessionRefreshMs: number;
  readonly callCounter: CallCounter;
  private log: Logger;
  private redis?: AcumaticaClientOptions['redis'];

  /** Optional circuit breaker — trips on lockout, blocks all requests until cooldown. */
  circuitBreaker?: AcumaticaCircuitBreaker;

  constructor(opts: AcumaticaClientOptions) {
    const { config } = opts;
    const endpoint = opts.endpoint ?? 'default';
    const apiVersion = config.apiVersion ?? '24.200.001';

    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiBase = `${this.baseUrl}/entity/${endpoint}/${apiVersion}`;
    this.username = config.username;
    this.password = config.password;
    this.tenant = config.tenant ?? '';
    this.sessionRefreshMs = (opts.sessionRefreshMinutes ?? 15) * 60 * 1000;
    this.log = opts.logger ?? pino({ name: 'acumatica-client' });
    this.callCounter = new CallCounter(opts.budget);
    this.redis = opts.redis;
    this.agent = new Agent({
      connect: { timeout: opts.requestTimeoutMs ?? 60_000 },
    });
  }

  // -- HTTP helpers --

  private async httpRequest(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (this.cookies) headers['Cookie'] = this.cookies;

    const opts: Parameters<typeof undiciRequest>[1] = {
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      headers,
      dispatcher: this.agent,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await undiciRequest(url, opts);
    const text = await res.body.text();
    return {
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[]>,
      body: text,
    };
  }

  // -- Auth --

  private async ensureLoggedIn(): Promise<void> {
    // Circuit breaker check — block all requests while open
    if (this.circuitBreaker?.isOpen) {
      throw new CircuitOpenError(
        this.circuitBreaker.reason,
        this.circuitBreaker.retryAfterSeconds,
      );
    }

    // Check Redis lockout guard before attempting login
    if (this.redis) {
      const locked = await this.redis.get(LOCKOUT_KEY).catch(() => null);
      if (locked) {
        throw new AccountLockedError(
          'Acumatica account locked out (Redis guard). Unlock in SM201010 or wait for TTL expiry.',
        );
      }
    }

    // Proactive refresh near expiry
    if (this.loggedIn && Date.now() - this.sessionStart > this.sessionRefreshMs) {
      this.log.debug('Session near expiry, refreshing');
      this.loggedIn = false;
      this.cookies = '';
    }

    if (this.loggedIn) return;

    // Check login budget before attempting — trips guard preemptively
    await this.checkLoginBudget();

    // Prevent concurrent login attempts -- reuse in-flight promise
    if (this.loggingIn && this.loginPromise) {
      await this.loginPromise;
      if (this.loggedIn) return;
    }

    this.loggingIn = true;
    this.loginPromise = this.loginWithRetry();
    try {
      await this.loginPromise;
    } catch (err) {
      // Trip circuit breaker on login failure
      this.circuitBreaker?.onError(err as Error);
      throw err;
    } finally {
      this.loggingIn = false;
      this.loginPromise = null;
    }
  }

  private async loginWithRetry(): Promise<void> {
    const loginBody: Record<string, string> = {
      name: this.username,
      password: this.password,
    };
    if (this.tenant) loginBody.company = this.tenant;

    for (let attempt = 0; attempt <= LOGIN_RETRY_DELAYS.length; attempt++) {
      try {
        this.log.debug({ attempt: attempt + 1 }, 'Logging in to Acumatica');

        const res = await this.httpRequest(
          'POST',
          `${this.baseUrl}/entity/auth/login`,
          loginBody,
        );

        if (res.status >= 400) {
          const isLockedOut =
            res.status === 500 && res.body.includes('locked out');
          if (isLockedOut) {
            this.log.error(
              'Acumatica account is LOCKED OUT — stopping all login attempts',
            );
            // Set Redis lockout flag so all services stop attempting login
            if (this.redis) {
              await this.redis.set(
                LOCKOUT_KEY,
                new Date().toISOString(),
                'EX',
                LOCKOUT_TTL_SECONDS,
              ).catch((e) => this.log.warn({ err: (e as Error).message }, 'Failed to set Redis lockout flag'));
            }
            throw new AccountLockedError(
              'Acumatica account locked out. Unlock in SM201010 (Users screen).',
            );
          }

          const isLoginLimit =
            res.status === 500 && res.body.includes('API Login Limit');

          if (isLoginLimit && attempt < LOGIN_RETRY_DELAYS.length) {
            const delay = LOGIN_RETRY_DELAYS[attempt];
            this.log.warn(
              { attempt: attempt + 1, delayMs: delay },
              'API Login Limit, retrying',
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          await this.recordLoginFailure();
          throw new Error(
            `Login failed: HTTP ${res.status} -- ${res.body.slice(0, 200)}`,
          );
        }

        // Capture session cookies from set-cookie header
        const setCookieHeader = res.headers['set-cookie'];
        const setCookies = Array.isArray(setCookieHeader)
          ? setCookieHeader
          : setCookieHeader
            ? [setCookieHeader]
            : [];
        this.cookies = setCookies.map((c) => c.split(';')[0]).join('; ');

        this.loggedIn = true;
        this.sessionStart = Date.now();
        this.log.debug({ attempt: attempt + 1 }, 'Login successful');
        return;
      } catch (err) {
        if (err instanceof AccountLockedError) throw err;
        if (attempt >= LOGIN_RETRY_DELAYS.length) throw err;
        const msg = (err as Error).message || '';
        if (!msg.includes('API Login Limit')) throw err;
        const delay = LOGIN_RETRY_DELAYS[attempt];
        this.log.warn({ delayMs: delay }, 'Login limit, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Public login method — ensures the client has an active session.
   * Delegates to the internal ensureLoggedIn() which handles
   * session refresh, retry, and concurrent-login dedup.
   */
  async login(): Promise<void> {
    await this.ensureLoggedIn();
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    try {
      await this.httpRequest(
        'POST',
        `${this.baseUrl}/entity/auth/logout`,
        null,
      );
      this.log.debug('Logout successful');
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'Logout failed (best-effort)');
    }
    this.loggedIn = false;
    this.cookies = '';
    this.sessionStart = 0;
  }

  // -- Login budget --

  /**
   * Check if login attempt budget is exhausted.
   * Throws if too many recent failures — trips the lockout guard
   * BEFORE Acumatica's own lockout threshold (typically 3-5 attempts).
   */
  private async checkLoginBudget(): Promise<void> {
    if (!this.redis) return;
    try {
      const count = await this.redis.get(LOGIN_FAILURES_KEY);
      if (count && parseInt(count, 10) > LOGIN_BUDGET_MAX) {
        await this.redis.set(
          LOCKOUT_KEY,
          `${new Date().toISOString()} | Login budget exhausted (${count} failures in 30min)`,
          'EX',
          LOCKOUT_TTL_SECONDS,
        ).catch(() => {});
        throw new AccountLockedError(
          `Login attempt budget exhausted — ${count} failures in 30-min window. Guard tripped preemptively.`,
        );
      }
    } catch (err) {
      if (err instanceof AccountLockedError) throw err;
      this.log.warn({ err: (err as Error).message }, 'Login budget check failed (non-fatal)');
    }
  }

  /**
   * Record a login failure. After LOGIN_BUDGET_MAX failures in a 30-min
   * window, checkLoginBudget() will trip the lockout guard.
   */
  private async recordLoginFailure(): Promise<void> {
    if (!this.redis) return;
    try {
      const current = await this.redis.get(LOGIN_FAILURES_KEY);
      const next = current ? parseInt(current, 10) + 1 : 1;
      await this.redis.set(LOGIN_FAILURES_KEY, String(next), 'EX', LOGIN_BUDGET_TTL_SECONDS);
      this.log.warn({ failures: next, budget: LOGIN_BUDGET_MAX }, 'Login failure recorded');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Failed to record login failure (non-fatal)');
    }
  }

  // -- API methods --

  /**
   * GET entity endpoint. Returns unwrapped response.
   */
  async get(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<unknown> {
    await this.ensureLoggedIn();
    this.callCounter.tick();
    if (this.callCounter.isOverBudget()) {
      throw new Error(
        `API call budget exceeded: ${JSON.stringify(this.callCounter.stats())}`,
      );
    }

    const url = new URL(`${this.apiBase}/${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }

    const res = await this.httpRequest('GET', url.toString());

    // Auto-retry on 401
    if (res.status === 401) {
      this.log.warn('Session expired mid-request, re-authenticating');
      this.loggedIn = false;
      this.cookies = '';
      await this.ensureLoggedIn();
      const retry = await this.httpRequest('GET', url.toString());
      if (retry.status >= 400) {
        return this.handleError(retry.status, retry.body, url.toString());
      }
      return unwrap(JSON.parse(retry.body));
    }

    if (res.status >= 400) {
      return this.handleError(res.status, res.body, url.toString());
    }

    this.circuitBreaker?.onSuccess();
    return unwrap(JSON.parse(res.body));
  }

  /** Basic Auth header for OData — Acumatica cloud OData rejects cookie auth */
  private get odataBasicAuth(): Record<string, string> {
    const creds = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    // Explicitly clear Cookie header — OData rejects mixed auth (Cookie + Basic)
    return { Authorization: `Basic ${creds}`, Cookie: '' };
  }

  /**
   * GET OData endpoint for Generic Inquiries.
   * GI OData is at /odata/{giName}, NOT /entity/.../{giName}.
   * Uses Basic Auth (not session cookies) — Acumatica cloud OData requires it.
   */
  async getOData(
    giName: string,
    params?: Record<string, string | number>,
  ): Promise<unknown> {
    this.callCounter.tick();
    if (this.callCounter.isOverBudget()) {
      throw new Error(
        `API call budget exceeded: ${JSON.stringify(this.callCounter.stats())}`,
      );
    }

    // Include company/tenant in OData path if configured (required on multi-company instances)
    const odataPath = this.tenant
      ? `/odata/${encodeURIComponent(this.tenant)}/${giName}`
      : `/odata/${giName}`;
    const url = new URL(`${this.baseUrl}${odataPath}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }

    const res = await this.httpRequest('GET', url.toString(), undefined, this.odataBasicAuth);

    if (res.status === 401) {
      this.log.warn('OData Basic Auth rejected (401) — check credentials');
      return this.handleError(res.status, res.body, url.toString());
    }

    if (res.status >= 400) {
      return this.handleError(res.status, res.body, url.toString());
    }

    this.circuitBreaker?.onSuccess();
    const json = JSON.parse(res.body);
    // OData wraps results in { value: [...] }
    return json.value ?? json;
  }

  /**
   * PUT entity endpoint with a pre-wrapped body (no auto-wrap).
   * Use this when the body contains metadata fields like `id` or `delete`
   * that must NOT be wrapped in {value: x} format.
   */
  async putRaw(path: string, body: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoggedIn();
    this.callCounter.tick();

    const url = `${this.apiBase}/${path}`;
    const res = await this.httpRequest('PUT', url, body);

    if (res.status === 401) {
      this.loggedIn = false;
      this.cookies = '';
      await this.ensureLoggedIn();
      const retry = await this.httpRequest('PUT', url, body);
      if (retry.status >= 400) {
        return this.handleError(retry.status, retry.body, url);
      }
      return unwrap(JSON.parse(retry.body));
    }

    if (res.status >= 400) {
      return this.handleError(res.status, res.body, url);
    }

    this.circuitBreaker?.onSuccess();
    return unwrap(JSON.parse(res.body));
  }

  /**
   * PUT entity endpoint (create or update). Auto-wraps input, unwraps response.
   */
  async put(path: string, body: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoggedIn();
    this.callCounter.tick();

    const url = `${this.apiBase}/${path}`;
    const wrapped = wrap(body);
    const res = await this.httpRequest('PUT', url, wrapped);

    if (res.status === 401) {
      this.loggedIn = false;
      this.cookies = '';
      await this.ensureLoggedIn();
      const retry = await this.httpRequest('PUT', url, wrapped);
      if (retry.status >= 400) {
        return this.handleError(retry.status, retry.body, url);
      }
      return unwrap(JSON.parse(retry.body));
    }

    if (res.status >= 400) {
      return this.handleError(res.status, res.body, url);
    }

    this.circuitBreaker?.onSuccess();
    return unwrap(JSON.parse(res.body));
  }

  /**
   * POST to entity endpoint (for actions). Auto-wraps input, unwraps response.
   */
  async post(path: string, body?: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoggedIn();
    this.callCounter.tick();

    const url = `${this.apiBase}/${path}`;
    const wrapped = body ? wrap(body) : undefined;
    const res = await this.httpRequest('POST', url, wrapped);

    if (res.status === 401) {
      this.loggedIn = false;
      this.cookies = '';
      await this.ensureLoggedIn();
      const retry = await this.httpRequest('POST', url, wrapped);
      if (retry.status >= 400) {
        return this.handleError(retry.status, retry.body, url);
      }
      const retryBody = retry.body.trim();
      return retryBody ? unwrap(JSON.parse(retryBody)) : { success: true };
    }

    if (res.status >= 400) {
      return this.handleError(res.status, res.body, url);
    }

    this.circuitBreaker?.onSuccess();
    const respBody = res.body.trim();
    return respBody ? unwrap(JSON.parse(respBody)) : { success: true };
  }

  /**
   * DELETE entity record.
   */
  async delete(path: string): Promise<unknown> {
    await this.ensureLoggedIn();
    this.callCounter.tick();

    const url = `${this.apiBase}/${path}`;
    const res = await this.httpRequest('DELETE', url);

    if (res.status === 401) {
      this.loggedIn = false;
      this.cookies = '';
      await this.ensureLoggedIn();
      const retry = await this.httpRequest('DELETE', url);
      if (retry.status >= 400) {
        return this.handleError(retry.status, retry.body, url);
      }
      return { success: true };
    }

    if (res.status >= 400) {
      return this.handleError(res.status, res.body, url);
    }

    this.circuitBreaker?.onSuccess();
    return { success: true };
  }

  /**
   * Raw GET to any URL (for attachments, custom endpoints).
   */
  async rawGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
    await this.ensureLoggedIn();
    this.callCounter.tick();
    return this.httpRequest('GET', url);
  }

  /**
   * Raw PUT with binary body (for file upload).
   */
  async rawPut(url: string, body: Buffer, contentType: string): Promise<{ status: number; body: string }> {
    await this.ensureLoggedIn();
    this.callCounter.tick();

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };
    if (this.cookies) headers['Cookie'] = this.cookies;

    const res = await undiciRequest(url, {
      method: 'PUT',
      headers,
      body,
      dispatcher: this.agent,
    });
    const text = await res.body.text();
    return { status: res.statusCode, body: text };
  }

  // -- Pagination helper --

  /**
   * Auto-paginate a list query, fetching all pages.
   */
  async getAll(
    entity: string,
    params: Record<string, string | number> = {},
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    let skip = 0;
    const top = 100;

    while (true) {
      const page = (await this.get(entity, {
        $top: top,
        $skip: skip,
        ...params,
      })) as unknown[];

      if (!Array.isArray(page)) {
        // Single object or error response
        if (page && typeof page === 'object' && 'error' in (page as Record<string, unknown>)) {
          return [page]; // Return error as single-element array
        }
        results.push(page);
        break;
      }

      results.push(...page);
      if (page.length < top) break;
      skip += top;
    }
    return results;
  }

  /**
   * Batch query with OR-chained filters, chunked to avoid 414 URI Too Long.
   */
  async getBatch(
    entity: string,
    field: string,
    values: string[],
    params: Record<string, string | number> = {},
  ): Promise<unknown[]> {
    if (!values || values.length === 0) return [];

    const CHUNK = 100;
    const results: unknown[] = [];

    for (let i = 0; i < values.length; i += CHUNK) {
      const batch = values.slice(i, i + CHUNK);
      const filter = batch.map((v) => `${field} eq '${v}'`).join(' or ');
      const existing = params.$filter ? `(${params.$filter}) and (${filter})` : filter;
      const page = await this.getAll(entity, { ...params, $filter: existing });
      results.push(...page);
    }

    return results;
  }

  // -- Proxy pass-through --

  /**
   * Proxy a raw HTTP request to Acumatica, injecting session cookies.
   * Returns the raw response without any value unwrapping.
   * Used by the REST proxy gateway.
   */
  async proxyRequest(
    method: string,
    path: string,
    query: string,
    body: string | null,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
    await this.ensureLoggedIn();
    this.callCounter.tick();
    if (this.callCounter.isOverBudget()) {
      return {
        status: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'API call budget exceeded',
          stats: this.callCounter.stats(),
        }),
      };
    }

    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;

    const headers: Record<string, string> = {
      ...extraHeaders,
    };
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.cookies) headers['Cookie'] = this.cookies;

    const reqOpts: Parameters<typeof undiciRequest>[1] = {
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      headers,
      dispatcher: this.agent,
    };
    if (body && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
      reqOpts.body = body;
    }

    const res = await undiciRequest(url, reqOpts);
    const text = await res.body.text();

    // Auto-retry on 401 (session expired)
    if (res.statusCode === 401) {
      this.log.warn('Proxy: session expired, re-authenticating');
      this.loggedIn = false;
      this.cookies = '';
      await this.ensureLoggedIn();

      // Rebuild headers with new cookie
      if (this.cookies) headers['Cookie'] = this.cookies;
      const retryOpts = { ...reqOpts, headers };
      const retry = await undiciRequest(url, retryOpts);
      const retryText = await retry.body.text();
      return {
        status: retry.statusCode,
        headers: retry.headers as Record<string, string | string[]>,
        body: retryText,
      };
    }

    return {
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[]>,
      body: text,
    };
  }

  // -- Heartbeat --

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start a background heartbeat that keeps the Acumatica session alive.
   * Calls ensureLoggedIn() periodically, which will proactively refresh
   * the session if it's near expiry.
   */
  startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.ensureLoggedIn();
        this.log.debug('Heartbeat: session alive');
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'Heartbeat: login failed');
      }
    }, intervalMs);
    // Don't block process shutdown
    this.heartbeatTimer.unref();
    this.log.info({ intervalMs }, 'Heartbeat started');
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.log.info('Heartbeat stopped');
    }
  }

  // -- Error handling --

  private handleError(
    status: number,
    body: string,
    url: string,
  ): AcumaticaError {
    const known = matchError(status, body, url);
    if (known) return known;
    return genericError(status, body, url);
  }
}
