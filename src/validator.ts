import { z } from "zod";

// ─── Output Schemas ───────────────────────────────────────────────────────────

export const ClaimSchema = z.object({
  text: z.string(),
  confidence: z.enum(["HIGH", "INFERRED", "UNCERTAIN", "BLANK"]),
  source: z.string().nullable(),
});

export const HrpResponseSchema = z.object({
  evidence: z.array(z.string()),
  response: z.object({
    claims: z.array(ClaimSchema),
  }),
  countercheck: z.object({
    challenges: z.array(z.string()),
    survives: z.boolean(),
    residual: z.string().nullable(),
  }),
  blank: z.boolean(),
  blank_reason: z.string().nullable(),
});

export const HrpCheckOutputSchema = z.object({
  valid: z.boolean(),
  violations: z.array(z.object({
    type: z.enum([
      "MISSING_CONFIDENCE_TAG",
      "UNMARKED_ASSERTION",
      "NO_EVIDENCE",
      "NO_COUNTERCHECK",
    ]),
    location: z.string(),
    suggestion: z.string(),
  })),
  confidence_distribution: z.object({
    HIGH: z.number(),
    INFERRED: z.number(),
    UNCERTAIN: z.number(),
    BLANK: z.number(),
    UNTAGGED: z.number(),
  }),
});

export const HrpAdversarialOutputSchema = z.object({
  original_claim: z.string(),
  challenges: z.array(z.string()),
  residual_confidence: z.enum(["HIGH", "INFERRED", "UNCERTAIN", "BLANK"]),
  survives: z.boolean(),
});

export const HrpEvidenceOutputSchema = z.object({
  evidence_required: z.literal(true),
  evidence: z.array(z.string()),
  gate: z.enum(["OPEN", "BLOCKED"]),
  prompt: z.string(),
});

// ─── Violation Types ──────────────────────────────────────────────────────────

export type ViolationType =
  | "MISSING_CONFIDENCE_TAG"
  | "UNMARKED_ASSERTION"
  | "NO_EVIDENCE"
  | "NO_COUNTERCHECK"
  | "SCHEMA_VIOLATION"
  | "BLANK_WITHOUT_REASON"
  | "EVIDENCE_GATE_BLOCKED";

export interface Violation {
  type: ViolationType;
  location: string;
  suggestion: string;
  severity: "ERROR" | "WARNING";
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  confidence_distribution: Record<string, number>;
  parse_error: string | null;
}

// ─── Confidence Tag Scanner ───────────────────────────────────────────────────

const CONFIDENCE_TAG_PATTERN = /\[(HIGH|INFERRED|UNCERTAIN|BLANK)\]/g;
const SENTENCE_PATTERN = /[^.!?]+[.!?]+/g;

function scanConfidenceTags(text: string): {
  tagged: number;
  untagged: number;
  distribution: Record<string, number>;
} {
  const distribution: Record<string, number> = {
    HIGH: 0, INFERRED: 0, UNCERTAIN: 0, BLANK: 0, UNTAGGED: 0,
  };

  const sentences = text.match(SENTENCE_PATTERN) || [];
  let tagged = 0;
  let untagged = 0;

  for (const sentence of sentences) {
    const tags = sentence.match(CONFIDENCE_TAG_PATTERN);
    if (tags) {
      tagged++;
      for (const tag of tags) {
        const key = tag.replace(/[\[\]]/g, "");
        distribution[key] = (distribution[key] || 0) + 1;
      }
    } else {
      // Ignore short sentences and headings
      if (sentence.trim().length > 20) {
        untagged++;
        distribution.UNTAGGED++;
      }
    }
  }

  return { tagged, untagged, distribution };
}

// ─── Structural Validators ────────────────────────────────────────────────────

function validateStructured(parsed: z.infer<typeof HrpResponseSchema>): Violation[] {
  const violations: Violation[] = [];

  // Blank check
  if (parsed.blank) {
    if (!parsed.blank_reason || parsed.blank_reason.trim() === "") {
      violations.push({
        type: "BLANK_WITHOUT_REASON",
        location: "blank_reason",
        suggestion: "A blank response must include a reason explaining why the query cannot be answered.",
        severity: "ERROR",
      });
    }
    return violations; // No further checks needed for blank responses
  }

  // Evidence check
  if (!parsed.evidence || parsed.evidence.length === 0) {
    violations.push({
      type: "NO_EVIDENCE",
      location: "evidence[]",
      suggestion: "At least one piece of supporting evidence must precede any conclusion.",
      severity: "ERROR",
    });
  }

  // Claims check
  for (const claim of parsed.response.claims) {
    if (claim.confidence === "HIGH" && !claim.source) {
      violations.push({
        type: "UNMARKED_ASSERTION",
        location: `claim: "${claim.text.slice(0, 60)}..."`,
        suggestion: "HIGH confidence claims must include a verifiable source.",
        severity: "WARNING",
      });
    }
    if (claim.confidence === "INFERRED" && claim.source) {
      violations.push({
        type: "MISSING_CONFIDENCE_TAG",
        location: `claim: "${claim.text.slice(0, 60)}..."`,
        suggestion: "If a source exists, confidence should be HIGH, not INFERRED.",
        severity: "WARNING",
      });
    }
  }

  // Countercheck check
  if (!parsed.countercheck.challenges || parsed.countercheck.challenges.length === 0) {
    violations.push({
      type: "NO_COUNTERCHECK",
      location: "countercheck.challenges[]",
      suggestion: "At least one adversarial challenge must be provided.",
      severity: "ERROR",
    });
  }

  return violations;
}

// ─── Main Validator ───────────────────────────────────────────────────────────

export function validateHrpResponse(rawText: string): ValidationResult {
  const distribution: Record<string, number> = {
    HIGH: 0, INFERRED: 0, UNCERTAIN: 0, BLANK: 0, UNTAGGED: 0,
  };

  // Attempt JSON parse
  let parsed: unknown;
  try {
    const cleaned = rawText.replace(/```json\n?|\n?```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      valid: false,
      violations: [{
        type: "SCHEMA_VIOLATION",
        location: "root",
        suggestion: "Response is not valid JSON. Use hrp_respond to enforce structured output.",
        severity: "ERROR",
      }],
      confidence_distribution: distribution,
      parse_error: "JSON parse failed",
    };
  }

  // Schema validation
  const schemaResult = HrpResponseSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    return {
      valid: false,
      violations: [{
        type: "SCHEMA_VIOLATION",
        location: "schema",
        suggestion: `Schema mismatch — ${issues}`,
        severity: "ERROR",
      }],
      confidence_distribution: distribution,
      parse_error: issues,
    };
  }

  // Structural validation
  const violations = validateStructured(schemaResult.data);

  // Confidence distribution from claims
  for (const claim of schemaResult.data.response.claims) {
    distribution[claim.confidence] = (distribution[claim.confidence] || 0) + 1;
  }

  return {
    valid: violations.filter(v => v.severity === "ERROR").length === 0,
    violations,
    confidence_distribution: distribution,
    parse_error: null,
  };
}

// ─── Plain Text Validator (for hrp_check fallback) ────────────────────────────

export function validatePlainText(text: string): ValidationResult {
  const violations: Violation[] = [];
  const { distribution } = scanConfidenceTags(text);

  if (distribution.UNTAGGED > 0) {
    violations.push({
      type: "MISSING_CONFIDENCE_TAG",
      location: `${distribution.UNTAGGED} untagged sentence(s)`,
      suggestion: "Tag every substantive claim with [HIGH], [INFERRED], [UNCERTAIN], or [BLANK].",
      severity: "WARNING",
    });
  }

  if (!text.toLowerCase().includes("countercheck") && !text.toLowerCase().includes("however") && !text.toLowerCase().includes("challenge")) {
    violations.push({
      type: "NO_COUNTERCHECK",
      location: "full response",
      suggestion: "No adversarial self-check detected. Add a Countercheck section.",
      severity: "ERROR",
    });
  }

  if (distribution.HIGH > 0 && !text.match(/per |according to |source:|ref:|cited in /i)) {
    violations.push({
      type: "UNMARKED_ASSERTION",
      location: "HIGH confidence claims",
      suggestion: "HIGH confidence claims detected but no source attributions found.",
      severity: "WARNING",
    });
  }

  return {
    valid: violations.filter(v => v.severity === "ERROR").length === 0,
    violations,
    confidence_distribution: distribution,
    parse_error: null,
  };
}