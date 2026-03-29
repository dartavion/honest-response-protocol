import { describe, it, expect } from "vitest";
import { validateHrpResponse, validatePlainText } from "../src/validator.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeValid(overrides: Record<string, unknown> = {}): string {
  const base = {
    evidence: ["Sky appears blue due to Rayleigh scattering."],
    response: {
      claims: [
        { text: "The sky is blue.", confidence: "HIGH", source: "optics textbook" },
      ],
    },
    countercheck: {
      challenges: ["Could appear gray when overcast."],
      survives: true,
      residual: null,
    },
    blank: false,
    blank_reason: null,
    ...overrides,
  };
  return JSON.stringify(base);
}

// ─── validateHrpResponse ──────────────────────────────────────────────────────

describe("validateHrpResponse", () => {
  it("accepts a fully conformant response", () => {
    const result = validateHrpResponse(makeValid());
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.parse_error).toBeNull();
  });

  it("accepts blank=true with a non-empty blank_reason", () => {
    const result = validateHrpResponse(
      makeValid({ blank: true, blank_reason: "Insufficient evidence to answer." })
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects blank=true with null blank_reason", () => {
    const result = validateHrpResponse(
      makeValid({ blank: true, blank_reason: null })
    );
    expect(result.valid).toBe(false);
    const types = result.violations.map((v) => v.type);
    expect(types).toContain("BLANK_WITHOUT_REASON");
  });

  it("rejects blank=true with empty string blank_reason", () => {
    const result = validateHrpResponse(
      makeValid({ blank: true, blank_reason: "" })
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].type).toBe("BLANK_WITHOUT_REASON");
    expect(result.violations[0].severity).toBe("ERROR");
  });

  it("skips further checks when blank=true (even with empty evidence)", () => {
    const result = validateHrpResponse(
      makeValid({ blank: true, blank_reason: "No data.", evidence: [] })
    );
    // blank_reason provided → valid, and no NO_EVIDENCE violation added
    expect(result.valid).toBe(true);
    const types = result.violations.map((v) => v.type);
    expect(types).not.toContain("NO_EVIDENCE");
  });

  it("rejects missing evidence array", () => {
    const result = validateHrpResponse(makeValid({ evidence: [] }));
    expect(result.valid).toBe(false);
    const types = result.violations.map((v) => v.type);
    expect(types).toContain("NO_EVIDENCE");
  });

  it("rejects missing countercheck challenges", () => {
    const result = validateHrpResponse(
      makeValid({
        countercheck: { challenges: [], survives: true, residual: null },
      })
    );
    expect(result.valid).toBe(false);
    const types = result.violations.map((v) => v.type);
    expect(types).toContain("NO_COUNTERCHECK");
  });

  it("adds WARNING for HIGH confidence claim without source", () => {
    const result = validateHrpResponse(
      makeValid({
        response: {
          claims: [{ text: "The sky is blue.", confidence: "HIGH", source: null }],
        },
      })
    );
    // WARNING only → still valid
    expect(result.valid).toBe(true);
    const v = result.violations.find((x) => x.type === "UNMARKED_ASSERTION");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("WARNING");
  });

  it("adds WARNING for INFERRED claim that has a source", () => {
    const result = validateHrpResponse(
      makeValid({
        response: {
          claims: [
            { text: "This is inferred.", confidence: "INFERRED", source: "some paper" },
          ],
        },
      })
    );
    expect(result.valid).toBe(true);
    const v = result.violations.find((x) => x.type === "MISSING_CONFIDENCE_TAG");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("WARNING");
  });

  it("rejects malformed JSON", () => {
    const result = validateHrpResponse("not json at all");
    expect(result.valid).toBe(false);
    expect(result.violations[0].type).toBe("SCHEMA_VIOLATION");
    expect(result.parse_error).toBe("JSON parse failed");
  });

  it("strips markdown code fences before parsing", () => {
    const wrapped = "```json\n" + makeValid() + "\n```";
    const result = validateHrpResponse(wrapped);
    expect(result.valid).toBe(true);
    expect(result.parse_error).toBeNull();
  });

  it("rejects JSON that fails schema validation", () => {
    const result = validateHrpResponse(JSON.stringify({ foo: "bar" }));
    expect(result.valid).toBe(false);
    expect(result.violations[0].type).toBe("SCHEMA_VIOLATION");
    expect(result.parse_error).not.toBeNull();
  });

  it("rejects schema mismatch — wrong confidence enum value", () => {
    const result = validateHrpResponse(
      makeValid({
        response: {
          claims: [{ text: "claim.", confidence: "MAYBE", source: null }],
        },
      })
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].type).toBe("SCHEMA_VIOLATION");
  });

  it("counts confidence distribution from claims", () => {
    const result = validateHrpResponse(
      makeValid({
        response: {
          claims: [
            { text: "A.", confidence: "HIGH", source: "s1" },
            { text: "B.", confidence: "INFERRED", source: null },
            { text: "C.", confidence: "UNCERTAIN", source: null },
          ],
        },
      })
    );
    expect(result.confidence_distribution.HIGH).toBe(1);
    expect(result.confidence_distribution.INFERRED).toBe(1);
    expect(result.confidence_distribution.UNCERTAIN).toBe(1);
  });

  it("returns zero distribution on JSON parse failure", () => {
    const result = validateHrpResponse("{bad");
    expect(result.confidence_distribution.HIGH).toBe(0);
    expect(result.confidence_distribution.INFERRED).toBe(0);
  });

  it("can accumulate both NO_EVIDENCE and NO_COUNTERCHECK errors", () => {
    const result = validateHrpResponse(
      makeValid({
        evidence: [],
        countercheck: { challenges: [], survives: false, residual: null },
      })
    );
    expect(result.valid).toBe(false);
    const types = result.violations.map((v) => v.type);
    expect(types).toContain("NO_EVIDENCE");
    expect(types).toContain("NO_COUNTERCHECK");
  });
});

// ─── validatePlainText ────────────────────────────────────────────────────────

describe("validatePlainText", () => {
  it("returns valid for fully tagged text with countercheck keyword", () => {
    // All substantive sentences tagged; source attribution present for HIGH; countercheck present.
    const text =
      "[HIGH] The sky is blue, per optics research. [INFERRED] Probably clear today. Countercheck: [UNCERTAIN] could be overcast.";
    const result = validatePlainText(text);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("returns valid when text contains 'however' as countercheck signal", () => {
    const text = "[INFERRED] This is likely true. However, there are exceptions.";
    const result = validatePlainText(text);
    expect(result.valid).toBe(true);
    const types = result.violations.map((v) => v.type);
    expect(types).not.toContain("NO_COUNTERCHECK");
  });

  it("returns valid when text contains 'challenge' as countercheck signal", () => {
    const text = "[UNCERTAIN] This might be the case. One challenge is that data is limited.";
    const result = validatePlainText(text);
    expect(result.valid).toBe(true);
  });

  it("flags NO_COUNTERCHECK when none of the signals are present", () => {
    const text = "[HIGH] This is definitely true. [INFERRED] And this follows.";
    const result = validatePlainText(text);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.type === "NO_COUNTERCHECK");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("ERROR");
  });

  it("flags MISSING_CONFIDENCE_TAG for untagged sentences longer than 20 chars", () => {
    const text =
      "This is a plain sentence without any tag. However, we should note this.";
    const result = validatePlainText(text);
    const v = result.violations.find((x) => x.type === "MISSING_CONFIDENCE_TAG");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("WARNING");
  });

  it("does not flag short sentences (<=20 chars) as untagged", () => {
    const text = "Ok. Yes. No. However, short.";
    const result = validatePlainText(text);
    const v = result.violations.find((x) => x.type === "MISSING_CONFIDENCE_TAG");
    expect(v).toBeUndefined();
  });

  it("flags UNMARKED_ASSERTION when HIGH tags appear without source attribution", () => {
    const text =
      "[HIGH] This is definitely the case. [HIGH] And so is this. However, one challenge remains.";
    const result = validatePlainText(text);
    const v = result.violations.find((x) => x.type === "UNMARKED_ASSERTION");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("WARNING");
  });

  it("does not flag UNMARKED_ASSERTION when HIGH tags have source attribution", () => {
    const text =
      "[HIGH] This is true according to the docs. However, there is a challenge here.";
    const result = validatePlainText(text);
    const types = result.violations.map((v) => v.type);
    expect(types).not.toContain("UNMARKED_ASSERTION");
  });

  it("reports untagged count in MISSING_CONFIDENCE_TAG location string", () => {
    const text =
      "This is a long untagged sentence with no tag at all. However, we note it.";
    const result = validatePlainText(text);
    const v = result.violations.find((x) => x.type === "MISSING_CONFIDENCE_TAG");
    expect(v?.location).toMatch(/untagged/);
  });

  it("returns confidence_distribution reflecting tag counts", () => {
    const text =
      "[HIGH] First claim. [INFERRED] Second claim. [UNCERTAIN] Third. However, countercheck.";
    const result = validatePlainText(text);
    expect(result.confidence_distribution.HIGH).toBeGreaterThanOrEqual(1);
    expect(result.confidence_distribution.INFERRED).toBeGreaterThanOrEqual(1);
  });

  it("returns parse_error as null", () => {
    const result = validatePlainText("some text. However, challenge here.");
    expect(result.parse_error).toBeNull();
  });
});
