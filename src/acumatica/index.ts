export { AcumaticaClient, CallCounter } from './client.js';
export type { AcumaticaClientOptions } from './client.js';
export { AcumaticaCircuitBreaker, CircuitOpenError, isLockoutError } from './circuit-breaker.js';
export type { CircuitState, CircuitBreakerOptions } from './circuit-breaker.js';
export {
  AcumaticaGatewayClient,
  GatewayCircuitOpenError,
  GatewayRequestError,
} from './gateway-client.js';
export type { GatewayConfig } from './gateway-client.js';
export { SessionManager } from './session-manager.js';
export type { SessionManagerOptions } from './session-manager.js';
export { SessionGate, SessionGateTimeoutError } from './session-gate.js';
export type { SessionGateOptions, Lease, GateStatus } from './session-gate.js';
export { SchemaCache } from './schema-cache.js';
export type { SchemaCacheOptions } from './schema-cache.js';
export { val, unwrap, wrap, str, toDateStr, toISOStr } from './value-wrapper.js';
export { guardListExpand, isGetExpandSafe } from './expand-guard.js';
export type { ExpandGuardResult } from './expand-guard.js';
export { matchError, genericError, cloudNotSupportedError, AccountLockedError } from './error-handler.js';
export type { AcumaticaError } from './error-handler.js';
export * as schemas from './schemas.js';
export { SoapClient, loadTenantConfig, selectBolts } from './soap-client.js';
export type { SoapClientConfig, SoapCommand, AllocateLotParams, AllocateLotResult, TenantConfig, TenantName, AvailableLot } from './soap-client.js';
export { SessionPool, SessionPoolExhaustedError } from './session-pool.js';
export type { PoolConfig, PoolEvent, PoolStatus, SessionHandle } from './session-pool.js';

// -- Factory --

import { AcumaticaClient } from './client.js';
import { AcumaticaGatewayClient } from './gateway-client.js';
import { loadAcumaticaConfig } from '../shared/config.js';

/**
 * Create an Acumatica client based on environment configuration.
 *
 * If ACUMATICA_GATEWAY_URL is set, returns a gateway client that routes
 * through studiob-api's REST API. Otherwise returns a direct client
 * that connects to Acumatica with cookie-based session auth.
 *
 * This lets downstream services switch from direct to gateway by
 * setting a single env var — no code changes required.
 */
export function createAcumaticaClient(): AcumaticaClient | AcumaticaGatewayClient {
  const gatewayUrl = process.env.ACUMATICA_GATEWAY_URL;
  if (gatewayUrl) {
    return new AcumaticaGatewayClient({
      gatewayUrl,
      gatewayToken: process.env.ACUMATICA_GATEWAY_TOKEN ?? '',
    });
  }
  return new AcumaticaClient({ config: loadAcumaticaConfig() });
}
