import { z } from "zod";

export const OutcomeVersion = z.literal("1.0");

export const FilesTouchedItem = z.object({
  path: z.string(),
  lines_added: z.number().int().nonnegative(),
  lines_removed: z.number().int().nonnegative(),
});

export const ApproachAttempted = z.object({
  approach: z.string(),
  result: z.enum(["abandoned", "partial", "shipped"]),
  why: z.string(),
  memory_rule_referenced: z.number().int().optional(),
});

export const ACSelfAssessment = z.object({
  criterion: z.string(),
  verdict: z.enum(["pass", "fail", "partial"]),
  evidence: z.string(),
});

export const CostActuals = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  session_messages: z.number().int().nonnegative(),
  wall_seconds: z.number().int().nonnegative(),
});

export const Outcome = z.object({
  outcome_version: OutcomeVersion,
  verdict: z.enum(["shipped", "shipped_partial", "abandoned"]),
  pr_url: z.string().url().nullable(),
  files_touched: z.array(FilesTouchedItem),
  tools_called_summary: z.record(z.string(), z.number().int().nonnegative()),
  approaches_attempted: z.array(ApproachAttempted),
  ac_self_assessment: z.array(ACSelfAssessment),
  cost_actuals: CostActuals,
  pack_drift_detected: z.boolean(),
  executor_notes_for_future: z.string(),
  deploy_notes: z.string(),
});

export type Outcome = z.infer<typeof Outcome>;
export const validateOutcome = (input: unknown): Outcome => Outcome.parse(input);
export const isOutcome = (input: unknown): input is Outcome => Outcome.safeParse(input).success;
