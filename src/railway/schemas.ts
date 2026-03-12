/**
 * Railway MCP tool parameter schemas.
 * Extracted from devops-mcp/src/railway/tools.ts
 *
 * 14 tools: list_services, get_service, list_environments, get_deployments,
 * trigger_deploy, list_variables, get_deploy_logs, upsert_variable,
 * upsert_variables_bulk, delete_variable, list_domains, create_domain,
 * restart_service, get_usage
 */

import { z } from 'zod';

/** railway_list_services — no parameters */
export const listServicesSchema = z.object({});
export type ListServicesParams = z.infer<typeof listServicesSchema>;

/** railway_get_service */
export const getServiceSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
});
export type GetServiceParams = z.infer<typeof getServiceSchema>;

/** railway_list_environments — no parameters */
export const listEnvironmentsSchema = z.object({});
export type ListEnvironmentsParams = z.infer<typeof listEnvironmentsSchema>;

/** railway_get_deployments */
export const getDeploymentsSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
  limit: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe('Number of deployments to return (default: 5)'),
});
export type GetDeploymentsParams = z.infer<typeof getDeploymentsSchema>;

/** railway_trigger_deploy */
export const triggerDeploySchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
});
export type TriggerDeployParams = z.infer<typeof triggerDeploySchema>;

/** railway_list_variables */
export const listVariablesSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
});
export type ListVariablesParams = z.infer<typeof listVariablesSchema>;

/** railway_get_deploy_logs */
export const getDeployLogsSchema = z.object({
  deployment_id: z.string().describe('Railway deployment ID'),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe('Number of log lines (default: 50)'),
});
export type GetDeployLogsParams = z.infer<typeof getDeployLogsSchema>;

/** railway_upsert_variable */
export const upsertVariableSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
  name: z.string().describe('Variable name (e.g., ACUMATICA_URL)'),
  value: z.string().describe('Variable value'),
});
export type UpsertVariableParams = z.infer<typeof upsertVariableSchema>;

/** railway_upsert_variables_bulk */
export const upsertVariablesBulkSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
  variables: z
    .record(z.string())
    .describe('Key-value pairs of variable names and values'),
});
export type UpsertVariablesBulkParams = z.infer<typeof upsertVariablesBulkSchema>;

/** railway_delete_variable */
export const deleteVariableSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
  name: z.string().describe('Variable name to delete'),
});
export type DeleteVariableParams = z.infer<typeof deleteVariableSchema>;

/** railway_list_domains */
export const listDomainsSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
});
export type ListDomainsParams = z.infer<typeof listDomainsSchema>;

/** railway_create_domain */
export const createDomainSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
});
export type CreateDomainParams = z.infer<typeof createDomainSchema>;

/** railway_restart_service */
export const restartServiceSchema = z.object({
  service_id: z.string().describe('Railway service ID'),
  environment_id: z.string().describe('Railway environment ID'),
});
export type RestartServiceParams = z.infer<typeof restartServiceSchema>;

/** railway_get_usage — no parameters */
export const getUsageSchema = z.object({});
export type GetUsageParams = z.infer<typeof getUsageSchema>;
