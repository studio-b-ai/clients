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
  matchError, genericError, cloudNotSupportedError, AccountLockedError,
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

// GoDaddy
export { GoDaddyClient } from './godaddy/index.js';
export type { GoDaddyClientConfig } from './godaddy/index.js';

// Zoom
export { ZoomClient, ZoomAuth } from './zoom/index.js';
export type { ZoomClientConfig, ZoomAuthConfig } from './zoom/index.js';

// Microsoft 365
export { MicrosoftClient } from './microsoft/index.js';
export type { MicrosoftClientConfig } from './microsoft/index.js';

// HubSpot
export { HubSpotClient } from './hubspot/index.js';
export type { HubSpotClientConfig } from './hubspot/index.js';

// Slack
export { SlackClient } from './slack/index.js';
export type { SlackClientConfig } from './slack/index.js';

// LinkedIn
export { LinkedInClient, LinkedInAuth } from './linkedin/index.js';
export type { LinkedInClientConfig, LinkedInAuthConfig, LinkedInTokenResponse } from './linkedin/index.js';

// Shared
export * from './shared/errors.js';
export * from './shared/config.js';
export * from './shared/encryption.js';

// Outcome Envelope
export * from './outcome-envelope/index.js';
