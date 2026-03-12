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
