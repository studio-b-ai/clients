import { z } from "zod";

export const PackVersion = z.literal("1.0");

export const RelevantFile = z.object({
  path: z.string(),
  sha: z.string(),
  content: z.string(),
});

export const SimilarBrief = z.object({
  brief_id: z.string(),
  outcome: z.enum(["shipped", "shipped_partial", "abandoned", "partial"]),
  summary: z.string(),
  abandonment_notes: z.string().optional(),
});

export const SystemContext = z.object({
  acumatica_schemas: z.record(z.string(), z.object({
    response_hash: z.string(),
    schema: z.unknown(),
  })),
  relevant_files: z.array(RelevantFile),
  similar_briefs: z.array(SimilarBrief),
});

export const ExecutorHints = z.object({
  expected_repos: z.array(z.string()),
  expected_pr_size: z.enum(["small", "medium", "large"]),
  category_specific_rules: z.array(z.string()),
});

export const Pack = z.object({
  pack_version: PackVersion,
  brief_id: z.string(),
  brief: z.unknown(), // frozen brief structure — typed in portal repo
  requestor_profile: z.unknown(),
  system_context: SystemContext,
  attachments_parsed: z.array(z.unknown()),
  executor_hints: ExecutorHints,
  outcome_schema_version: z.literal("1.0"),
});

export type Pack = z.infer<typeof Pack>;

export const validatePack = (input: unknown): Pack => Pack.parse(input);

export const isPack = (input: unknown): input is Pack => Pack.safeParse(input).success;
