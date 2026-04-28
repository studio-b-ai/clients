import { describe, it, expect } from "vitest";
import { buildPack, buildOutcome, assertCompatibleVersion } from "../builders.js";
import type { Pack } from "../pack.js";
import type { Outcome } from "../outcome.js";

const validPack: Pack = {
  pack_version: "1.0",
  brief_id: "br_99",
  brief: { title: "Export CSV" },
  requestor_profile: { name: "Bob" },
  system_context: {
    acumatica_schemas: {},
    relevant_files: [],
    similar_briefs: [],
  },
  attachments_parsed: [],
  executor_hints: {
    expected_repos: ["bolt-wms"],
    expected_pr_size: "medium",
    category_specific_rules: [],
  },
  outcome_schema_version: "1.0",
};

const validOutcome: Outcome = {
  outcome_version: "1.0",
  verdict: "abandoned",
  pr_url: null,
  files_touched: [],
  tools_called_summary: {},
  approaches_attempted: [],
  ac_self_assessment: [],
  cost_actuals: {
    input_tokens: 0,
    output_tokens: 0,
    session_messages: 0,
    wall_seconds: 0,
  },
  pack_drift_detected: false,
  executor_notes_for_future: "",
  deploy_notes: "",
};

describe("buildPack", () => {
  it("returns a validated Pack for valid input", () => {
    const result = buildPack(validPack);
    expect(result.brief_id).toBe("br_99");
    expect(result.pack_version).toBe("1.0");
  });

  it("throws on invalid input", () => {
    expect(() => buildPack({ pack_version: "9.9" })).toThrow();
  });
});

describe("buildOutcome", () => {
  it("returns a validated Outcome for valid input", () => {
    const result = buildOutcome(validOutcome);
    expect(result.verdict).toBe("abandoned");
    expect(result.outcome_version).toBe("1.0");
  });

  it("throws on invalid input", () => {
    expect(() => buildOutcome({ verdict: "unknown" })).toThrow();
  });
});

describe("assertCompatibleVersion", () => {
  it("does not throw when version is in supported list", () => {
    expect(() => assertCompatibleVersion("1.0", ["1.0", "1.1"])).not.toThrow();
  });

  it("throws when version is not in supported list", () => {
    expect(() => assertCompatibleVersion("2.0", ["1.0"])).toThrowError(
      /Unsupported envelope version "2.0"/,
    );
  });

  it("throws with helpful message listing all supported versions", () => {
    try {
      assertCompatibleVersion("9.9", ["1.0", "1.1"]);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("1.0");
      expect((err as Error).message).toContain("1.1");
    }
  });
});
