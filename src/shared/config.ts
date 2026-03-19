import { z } from 'zod';

/** Read a required environment variable, throw if missing */
export function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

/** Read an optional environment variable */
export function optional(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

/** Read an optional integer environment variable */
export function optionalInt(name: string, defaultValue?: number): number | undefined {
  const val = process.env[name];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) throw new Error(`Env var ${name} must be an integer, got: ${val}`);
  return parsed;
}

/** Acumatica connection config */
export const AcumaticaConfigSchema = z.object({
  baseUrl: z.string().url(),
  username: z.string(),
  password: z.string(),
  tenant: z.string().optional(),
  branch: z.string().optional(),
  apiVersion: z.string().default('24.200.001'),
});
export type AcumaticaConfig = z.infer<typeof AcumaticaConfigSchema>;

/** GitHub connection config */
export const GitHubConfigSchema = z.object({
  token: z.string(),
  org: z.string().default('studio-b-ai'),
});
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

/** Railway connection config */
export const RailwayConfigSchema = z.object({
  token: z.string(),
  projectId: z.string().optional(),
});
export type RailwayConfig = z.infer<typeof RailwayConfigSchema>;

/** Redis connection config */
export const RedisConfigSchema = z.object({
  url: z.string().url().optional(),
});
export type RedisConfig = z.infer<typeof RedisConfigSchema>;

/** Load Acumatica config from environment */
export function loadAcumaticaConfig(): AcumaticaConfig {
  return AcumaticaConfigSchema.parse({
    baseUrl: required('ACUMATICA_URL'),
    username: required('ACUMATICA_USERNAME'),
    password: required('ACUMATICA_PASSWORD'),
    tenant: optional('ACUMATICA_TENANT'),
    branch: optional('ACUMATICA_BRANCH', 'HERFAB'),
    apiVersion: optional('ACUMATICA_API_VERSION', '24.200.001'),
  });
}

/** Load GitHub config from environment */
export function loadGitHubConfig(): GitHubConfig {
  return GitHubConfigSchema.parse({
    token: required('GITHUB_TOKEN'),
    org: optional('GITHUB_ORG', 'studio-b-ai'),
  });
}

/** Load Railway config from environment */
export function loadRailwayConfig(): RailwayConfig {
  return RailwayConfigSchema.parse({
    token: required('RAILWAY_TOKEN'),
    projectId: optional('RAILWAY_PROJECT_ID'),
  });
}

/** GoDaddy connection config */
export const GoDaddyConfigSchema = z.object({
  apiKey: z.string(),
  apiSecret: z.string(),
  env: z.enum(['production', 'ote']).default('production'),
});
export type GoDaddyConfig = z.infer<typeof GoDaddyConfigSchema>;

/** Load GoDaddy config from environment */
export function loadGoDaddyConfig(): GoDaddyConfig {
  return GoDaddyConfigSchema.parse({
    apiKey: required('GODADDY_API_KEY'),
    apiSecret: required('GODADDY_API_SECRET'),
    env: optional('GODADDY_ENV', 'production'),
  });
}

/** Zoom connection config */
export const ZoomConfigSchema = z.object({
  accountId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
});
export type ZoomConfig = z.infer<typeof ZoomConfigSchema>;

/** Load Zoom config from environment */
export function loadZoomConfig(): ZoomConfig {
  return ZoomConfigSchema.parse({
    accountId: required('ZOOM_ACCOUNT_ID'),
    clientId: required('ZOOM_CLIENT_ID'),
    clientSecret: required('ZOOM_CLIENT_SECRET'),
  });
}

/** Microsoft 365 connection config */
export const MicrosoftConfigSchema = z.object({
  tenantId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  defaultUserEmail: z.string().optional(),
});
export type MicrosoftConfig = z.infer<typeof MicrosoftConfigSchema>;

/** Load Microsoft 365 config from environment */
export function loadMicrosoftConfig(): MicrosoftConfig {
  return MicrosoftConfigSchema.parse({
    tenantId: required('AZURE_TENANT_ID'),
    clientId: required('AZURE_CLIENT_ID'),
    clientSecret: required('AZURE_CLIENT_SECRET'),
    defaultUserEmail: optional('DEFAULT_USER_EMAIL'),
  });
}

/** HubSpot connection config */
export const HubSpotConfigSchema = z.object({
  accessToken: z.string(),
});
export type HubSpotConfig = z.infer<typeof HubSpotConfigSchema>;

/** Load HubSpot config from environment */
export function loadHubSpotConfig(): HubSpotConfig {
  return HubSpotConfigSchema.parse({
    accessToken: required('HUBSPOT_ACCESS_TOKEN'),
  });
}

/** Slack connection config */
export const SlackConfigSchema = z.object({
  botToken: z.string(),
});
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

/** Load Slack config from environment (returns null if no token set) */
export function loadSlackConfig(): SlackConfig | null {
  const botToken = process.env.SLACK_BOT_TOKEN || process.env.STUDIOB_SLACK_BOT_TOKEN;
  if (!botToken) return null;
  return SlackConfigSchema.parse({ botToken });
}

/** LinkedIn connection config */
export const LinkedInConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().url().default('https://studiob-api-production.up.railway.app/api/v1/linkedin/callback'),
});
export type LinkedInConfig = z.infer<typeof LinkedInConfigSchema>;

/** Load LinkedIn config from environment */
export function loadLinkedInConfig(): LinkedInConfig {
  return LinkedInConfigSchema.parse({
    clientId: required('LINKEDIN_CLIENT_ID'),
    clientSecret: required('LINKEDIN_CLIENT_SECRET'),
    redirectUri: optional('LINKEDIN_REDIRECT_URI', 'https://studiob-api-production.up.railway.app/api/v1/linkedin/callback'),
  });
}
