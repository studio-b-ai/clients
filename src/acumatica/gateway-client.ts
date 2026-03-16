/**
 * Acumatica Gateway Client — drop-in replacement for AcumaticaClient
 * that routes requests through studiob-api's REST API instead of
 * calling Acumatica directly.
 *
 * Downstream services switch by setting ACUMATICA_GATEWAY_URL env var.
 * Same method signatures as the direct client, no login/logout needed.
 */

import { val, str } from './value-wrapper.js';

export interface GatewayConfig {
  /** studiob-api base URL, e.g. http://studiob-api.railway.internal */
  gatewayUrl: string;
  /** Bearer token for gateway auth */
  gatewayToken: string;
  /** Request timeout in ms. Default: 30000 */
  timeout?: number;
}

export class GatewayCircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayCircuitOpenError';
  }
}

export class GatewayRequestError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string, url: string) {
    super(`Gateway returned HTTP ${statusCode} for ${url}`);
    this.name = 'GatewayRequestError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class AcumaticaGatewayClient {
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(config: GatewayConfig) {
    this.baseUrl = config.gatewayUrl.replace(/\/$/, '');
    this.token = config.gatewayToken;
    this.timeout = config.timeout ?? 30_000;
  }

  // -- No-op auth (session managed by gateway) --

  async login(): Promise<void> {}
  async logout(): Promise<void> {}
  isLoggedIn(): boolean {
    return true;
  }

  // -- Internal HTTP --

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1/acumatica${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const res = await fetch(url, init);

      if (res.status === 503) {
        const text = await res.text();
        throw new GatewayCircuitOpenError(
          `Acumatica circuit breaker is open (gateway returned 503). ` +
            `The gateway is protecting Acumatica from overload. Retry after a brief wait. ` +
            `Detail: ${text.slice(0, 200)}`,
        );
      }

      if (!res.ok) {
        const text = await res.text();
        throw new GatewayRequestError(res.status, text, url);
      }

      const text = await res.text();
      if (!text.trim()) return {} as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // -- CRUD methods matching studiob-api REST routes --

  /**
   * Query records with OData filters.
   * Maps to GET /api/v1/acumatica/query/{entity}
   */
  async query<T = unknown>(
    entity: string,
    params: {
      $filter?: string;
      $select?: string;
      $expand?: string;
      $orderby?: string;
      $top?: number;
      $skip?: number;
    } = {},
  ): Promise<T[]> {
    const qs = new URLSearchParams();
    if (params.$filter) qs.set('filter', params.$filter);
    if (params.$select) qs.set('select', params.$select);
    if (params.$expand) qs.set('expand', params.$expand);
    if (params.$orderby) qs.set('orderby', params.$orderby);
    if (params.$top !== undefined) qs.set('top', String(params.$top));
    if (params.$skip !== undefined) qs.set('skip', String(params.$skip));
    const qsStr = qs.toString();
    const path = `/query/${encodeURIComponent(entity)}${qsStr ? `?${qsStr}` : ''}`;
    return this.request<T[]>('GET', path);
  }

  /**
   * Get a single record by key.
   * Maps to GET /api/v1/acumatica/record/{entity}/{key}
   */
  async get<T = unknown>(
    entity: string,
    key: string,
    params: { $expand?: string; $select?: string } = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    if (params.$expand) qs.set('expand', params.$expand);
    if (params.$select) qs.set('select', params.$select);
    const qsStr = qs.toString();
    const path = `/record/${encodeURIComponent(entity)}/${encodeURIComponent(key)}${qsStr ? `?${qsStr}` : ''}`;
    return this.request<T>('GET', path);
  }

  /**
   * Create a new record.
   * Maps to POST /api/v1/acumatica/record/{entity}
   */
  async create<T = unknown>(
    entity: string,
    fields: Record<string, unknown>,
  ): Promise<T> {
    const path = `/record/${encodeURIComponent(entity)}`;
    return this.request<T>('POST', path, { fields });
  }

  /**
   * Update an existing record.
   * Maps to PUT /api/v1/acumatica/record/{entity}/{key}
   */
  async update<T = unknown>(
    entity: string,
    key: string,
    fields: Record<string, unknown>,
  ): Promise<T> {
    const path = `/record/${encodeURIComponent(entity)}/${encodeURIComponent(key)}`;
    return this.request<T>('PUT', path, { fields });
  }

  /**
   * Delete a record.
   * Maps to DELETE /api/v1/acumatica/record/{entity}/{key}
   */
  async delete(entity: string, key: string): Promise<void> {
    const path = `/record/${encodeURIComponent(entity)}/${encodeURIComponent(key)}`;
    await this.request<unknown>('DELETE', path);
  }

  /**
   * Paginated query — fetches all records page by page.
   * The gateway's query route already uses getAll internally,
   * but this provides client-side pagination for very large result sets.
   */
  async getAll<T = unknown>(
    entity: string,
    params: {
      $filter?: string;
      $select?: string;
      $expand?: string;
      $orderby?: string;
    } = {},
    maxRecords = 10_000,
  ): Promise<T[]> {
    const results: T[] = [];
    const pageSize = 100;
    let skip = 0;

    while (results.length < maxRecords) {
      const page = await this.query<T>(entity, {
        ...params,
        $top: pageSize,
        $skip: skip,
      });

      if (!Array.isArray(page)) {
        // Non-array response (error or single object) — return as-is
        results.push(page as T);
        break;
      }

      results.push(...page);
      if (page.length < pageSize) break;
      skip += pageSize;
    }

    return results;
  }

  // -- Static value helpers (same interface as standalone functions) --

  /**
   * Unwrap a single Acumatica {value: x} field.
   * Provided as static method so downstream code using
   * AcumaticaClient.val() or AcumaticaGatewayClient.val() still works.
   */
  static val(field: unknown): unknown {
    return val(field);
  }

  /**
   * Unwrap to string with fallback.
   */
  static str(field: unknown, fallback = ''): string {
    return str(field, fallback);
  }

  /**
   * Unwrap to number with fallback.
   */
  static num(field: unknown, fallback = 0): number {
    const v = val(field);
    if (v === null || v === undefined) return fallback;
    const n = Number(v);
    return isNaN(n) ? fallback : n;
  }
}
