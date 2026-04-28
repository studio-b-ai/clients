import { describe, it, expect } from "vitest";
import { validatePack, isPack, Pack } from "../pack.js";

const validSystemContext = {
  acumatica_schemas: {
    SalesOrder: { response_hash: "abc123", schema: { fields: [] } },
  },
  relevant_files: [
    { path: "src/foo.ts", sha: "deadbeef", content: "export const x = 1;" },
  ],
  similar_briefs: [
    {
      brief_id: "br_001",
      outcome: "shipped" as const,
      summary: "Added export feature",
    },
  ],
};

const validPack: Pack = {
  pack_version: "1.0",
  brief_id: "br_42",
  brief: { title: "Add export button", description: "..." },
  requestor_profile: { name: "Alice", department: "Ops" },
  system_context: validSystemContext,
  attachments_parsed: [],
  executor_hints: {
    expected_repos: ["studiob", "bolt-wms"],
    expected_pr_size: "small",
    category_specific_rules: ["Deploy after 6pm CT"],
  },
  outcome_schema_version: "1.0",
};

describe("validatePack — happy path", () => {
  it("accepts a fully valid pack", () => {
    const result = validatePack(validPack);
    expect(result.pack_version).toBe("1.0");
    expect(result.brief_id).toBe("br_42");
  });

  it("isPack returns true for a valid pack", () => {
    expect(isPack(validPack)).toBe(true);
  });
});

describe("validatePack — negative cases", () => {
  it("rejects a pack missing pack_version", () => {
    const bad = { ...validPack } as Record<string, unknown>;
    delete bad.pack_version;
    expect(() => validatePack(bad)).toThrow();
    expect(isPack(bad)).toBe(false);
  });

  it("rejects a pack with wrong outcome enum in similar_briefs", () => {
    const bad = {
      ...validPack,
      system_context: {
        ...validSystemContext,
        similar_briefs: [
          {
            brief_id: "br_002",
            outcome: "INVALID_OUTCOME",
            summary: "...",
          },
        ],
      },
    };
    expect(() => validatePack(bad)).toThrow();
    expect(isPack(bad)).toBe(false);
  });

  it("rejects a pack missing system_context", () => {
    const bad = { ...validPack } as Record<string, unknown>;
    delete bad.system_context;
    expect(() => validatePack(bad)).toThrow();
    expect(isPack(bad)).toBe(false);
  });
});
