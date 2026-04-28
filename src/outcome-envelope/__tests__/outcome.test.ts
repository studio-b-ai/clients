import { describe, it, expect } from "vitest";
import { validateOutcome, isOutcome, Outcome } from "../outcome.js";

const validOutcome: Outcome = {
  outcome_version: "1.0",
  verdict: "shipped",
  pr_url: "https://github.com/studio-b-ai/bolt-wms/pull/1",
  files_touched: [
    { path: "src/index.ts", lines_added: 10, lines_removed: 2 },
  ],
  tools_called_summary: { Read: 5, Edit: 3, Bash: 12 },
  approaches_attempted: [
    {
      approach: "Direct Zod schema",
      result: "shipped",
      why: "Clean and type-safe",
    },
  ],
  ac_self_assessment: [
    {
      criterion: "Tests pass",
      verdict: "pass",
      evidence: "npm test returned 0",
    },
  ],
  cost_actuals: {
    input_tokens: 12000,
    output_tokens: 3400,
    session_messages: 42,
    wall_seconds: 180,
  },
  pack_drift_detected: false,
  executor_notes_for_future: "Use tsup for bundling",
  deploy_notes: "No Acumatica deploy required",
};

describe("validateOutcome — happy path", () => {
  it("accepts a fully valid outcome", () => {
    const result = validateOutcome(validOutcome);
    expect(result.outcome_version).toBe("1.0");
    expect(result.verdict).toBe("shipped");
  });

  it("accepts null pr_url", () => {
    const result = validateOutcome({ ...validOutcome, pr_url: null });
    expect(result.pr_url).toBeNull();
  });

  it("isOutcome returns true for a valid outcome", () => {
    expect(isOutcome(validOutcome)).toBe(true);
  });
});

describe("validateOutcome — negative cases", () => {
  it("rejects a bad verdict", () => {
    const bad = { ...validOutcome, verdict: "maybe" };
    expect(() => validateOutcome(bad)).toThrow();
    expect(isOutcome(bad)).toBe(false);
  });

  it("rejects an outcome missing cost_actuals", () => {
    const bad = { ...validOutcome } as Record<string, unknown>;
    delete bad.cost_actuals;
    expect(() => validateOutcome(bad)).toThrow();
    expect(isOutcome(bad)).toBe(false);
  });

  it("rejects a malformed pr_url (not a URL and not null)", () => {
    const bad = { ...validOutcome, pr_url: "not-a-url" };
    expect(() => validateOutcome(bad)).toThrow();
    expect(isOutcome(bad)).toBe(false);
  });
});
