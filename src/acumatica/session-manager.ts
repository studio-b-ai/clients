/**
 * Session Manager -- orchestrates session gate + Acumatica client.
 *
 * Provides withAcumatica(fn) that:
 * 1. Acquires a session gate slot (Redis semaphore)
 * 2. Ensures the Acumatica client is logged in
 * 3. Runs the provided function
 * 4. Releases the gate slot (even on error)
 *
 * Extracted from acumatica-mcp/src/lib/session-manager.ts
 * Adapted: accepts config objects in constructor (no global config import).
 */

import pino from 'pino';
import type { Logger } from 'pino';
import type { AcumaticaConfig } from '../shared/config.js';
import { AcumaticaClient, type AcumaticaClientOptions } from './client.js';
import { SessionGate, type Lease, type GateStatus } from './session-gate.js';

export interface SessionManagerOptions {
  /** Acumatica connection config */
  config: AcumaticaConfig;
  /** Redis URL for session gate coordination. Empty string = degraded mode. */
  redisUrl?: string;
  /** Max concurrent Acumatica sessions across all services. Default: 2 */
  maxConcurrent?: number;
  /** Service identifier for session gate lease tracking */
  serviceId?: string;
  /** API endpoint name. Default: 'default' */
  endpoint?: string;
  /** Request timeout in ms. Default: 60000 */
  requestTimeoutMs?: number;
  /** Session refresh interval in minutes. Default: 15 */
  sessionRefreshMinutes?: number;
  /** Logger instance */
  logger?: Logger;
}

export class SessionManager {
  readonly client: AcumaticaClient;
  readonly gate: SessionGate;
  private log: Logger;

  constructor(opts: SessionManagerOptions) {
    this.log = opts.logger ?? pino({ name: 'session-manager' });

    this.client = new AcumaticaClient({
      config: opts.config,
      endpoint: opts.endpoint,
      requestTimeoutMs: opts.requestTimeoutMs,
      sessionRefreshMinutes: opts.sessionRefreshMinutes,
      logger: this.log,
    });

    this.gate = new SessionGate({
      serviceId: opts.serviceId ?? 'studiob-client',
      redisUrl: opts.redisUrl ?? '',
      maxConcurrent: opts.maxConcurrent ?? 2,
      logger: this.log,
    });
  }

  /**
   * Execute a function while holding a session gate slot.
   * Acquires gate -> ensures login -> runs fn -> releases gate.
   */
  async withAcumatica<T>(fn: (client: AcumaticaClient) => Promise<T>): Promise<T> {
    return this.gate.withSession(async (lease: Lease) => {
      // Renew lease for long operations (extend TTL)
      const renewInterval = setInterval(async () => {
        await this.gate.renew(lease);
      }, 60_000); // Renew every 60s

      try {
        return await fn(this.client);
      } finally {
        clearInterval(renewInterval);
      }
    });
  }

  /** Get gate status for health endpoint. */
  async gateStatus(): Promise<GateStatus> {
    return this.gate.status();
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    await this.client.logout();
    await this.gate.shutdown();
    this.log.info('Session manager shut down');
  }
}
