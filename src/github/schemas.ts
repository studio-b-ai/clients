/**
 * GitHub MCP tool parameter schemas.
 * Extracted from devops-mcp/src/github/tools.ts
 *
 * 8 tools: list_repos, get_file, put_file, create_branch, list_prs, create_pr, merge_pr,
 * trigger_workflow, get_workflow_runs
 */

import { z } from 'zod';

/** github_list_repos */
export const listReposSchema = z.object({
  sort: z
    .enum(['updated', 'created', 'pushed', 'full_name'])
    .optional()
    .describe('Sort order (default: updated)'),
  per_page: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe('Results per page (default: 30, max: 100)'),
});
export type ListReposParams = z.infer<typeof listReposSchema>;

/** github_get_file */
export const getFileSchema = z.object({
  repo: z.string().describe('Repository name (e.g., "celigo-mcp")'),
  path: z
    .string()
    .describe('File path within the repo (e.g., "src/index.ts")'),
  ref: z
    .string()
    .optional()
    .describe('Branch, tag, or commit SHA (default: repo default branch)'),
});
export type GetFileParams = z.infer<typeof getFileSchema>;

/** github_put_file */
export const putFileSchema = z.object({
  repo: z.string().describe('Repository name'),
  path: z.string().describe('File path within the repo'),
  content: z.string().describe('File content (UTF-8 string)'),
  message: z.string().describe('Commit message'),
  branch: z.string().describe('Target branch name'),
  sha: z
    .string()
    .optional()
    .describe(
      'Current file SHA (required for updates, omit for new files)',
    ),
});
export type PutFileParams = z.infer<typeof putFileSchema>;

/** github_create_branch */
export const createBranchSchema = z.object({
  repo: z.string().describe('Repository name'),
  branch_name: z
    .string()
    .describe('New branch name (e.g., "feat/add-widget")'),
  from_ref: z
    .string()
    .optional()
    .describe(
      'Source ref (default: "heads/main"). Use "heads/<branch>" format.',
    ),
});
export type CreateBranchParams = z.infer<typeof createBranchSchema>;

/** github_list_prs */
export const listPrsSchema = z.object({
  repo: z.string().describe('Repository name'),
  state: z
    .enum(['open', 'closed', 'all'])
    .optional()
    .describe('Filter by PR state (default: open)'),
});
export type ListPrsParams = z.infer<typeof listPrsSchema>;

/** github_create_pr */
export const createPrSchema = z.object({
  repo: z.string().describe('Repository name'),
  title: z.string().describe('PR title'),
  head: z.string().describe('Source branch name'),
  base: z.string().describe('Target branch name (e.g., "main")'),
  body: z.string().optional().describe('PR description (markdown)'),
});
export type CreatePrParams = z.infer<typeof createPrSchema>;

/** github_merge_pr */
export const mergePrSchema = z.object({
  repo: z.string().describe('Repository name'),
  pull_number: z.number().describe('PR number'),
  merge_method: z
    .enum(['merge', 'squash', 'rebase'])
    .optional()
    .describe('Merge strategy (default: squash)'),
});
export type MergePrParams = z.infer<typeof mergePrSchema>;

/** github_trigger_workflow */
export const triggerWorkflowSchema = z.object({
  repo: z.string().describe('Repository name'),
  workflow_id: z
    .string()
    .describe('Workflow filename (e.g., "deploy.yml") or numeric ID'),
  ref: z
    .string()
    .describe('Branch or tag to run the workflow on (e.g., "main")'),
  inputs: z
    .record(z.string())
    .optional()
    .describe('Workflow input parameters as key-value pairs'),
});
export type TriggerWorkflowParams = z.infer<typeof triggerWorkflowSchema>;

/** github_get_workflow_runs */
export const getWorkflowRunsSchema = z.object({
  repo: z.string().describe('Repository name'),
  workflow_id: z
    .string()
    .optional()
    .describe('Workflow filename or ID to filter by'),
  branch: z.string().optional().describe('Filter runs by branch name'),
  per_page: z
    .number()
    .min(1)
    .max(30)
    .optional()
    .describe('Number of results (default: 10)'),
});
export type GetWorkflowRunsParams = z.infer<typeof getWorkflowRunsSchema>;
