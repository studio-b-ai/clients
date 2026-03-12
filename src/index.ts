// Acumatica
export {
  AcumaticaClient,
  CallCounter,
  SessionManager,
  SessionGate,
  SessionGateTimeoutError,
  SchemaCache,
  val, unwrap, wrap, str, toDateStr, toISOStr,
  guardListExpand, isGetExpandSafe,
  matchError, genericError, cloudNotSupportedError,
} from './acumatica/index.js';
export type {
  AcumaticaClientOptions,
  SessionManagerOptions,
  SessionGateOptions,
  Lease,
  GateStatus,
  SchemaCacheOptions,
  ExpandGuardResult,
  AcumaticaError,
} from './acumatica/index.js';
export { schemas as acumaticaSchemas } from './acumatica/index.js';

// GitHub
export { GitHubClient } from './github/index.js';
export { schemas as githubSchemas } from './github/index.js';

// Railway
export { RailwayClient } from './railway/index.js';
export { schemas as railwaySchemas } from './railway/index.js';

// Shared
export * from './shared/errors.js';
export * from './shared/config.js';
