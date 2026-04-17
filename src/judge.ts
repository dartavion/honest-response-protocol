import Anthropic from "@anthropic-ai/sdk";
import { HrpResponseSchema, validateHrpResponse } from "./validator.js";
import type { ValidationResult } from "./validator.js";
import { preferences } from "./preferences.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JudgeInput {
  query: string;
  response_text: string;
  domain_label: string;
  evidence_standard: string;
  source_expectation: string;
  high_requires: string;
  adversarial_framing: string;
}

export interface JudgeOutput {
  /** The HRP JSON the judge produced for this response, if parseable. */
  verdict: unknown | null;
  /** Structural validation of the verdict. */
  validation: ValidationResult;
  /** Raw text the judge returned (for debugging / audit). */
  raw: string;
  /** Model that produced the verdict. */
  model: string;
  /** Whether the judge was invoked at all (false if disabled or no API key). */
  invoked: boolean;
  /** If invoked and failed, the error message. */
  error: string | null;
}

// ─── Client ───────────────────────────────────────────────────────────────────
//
// The judge runs in a SEPARATE context from the generator. It is given only
// the final response and the domain config — never the generator's chain of
// thought. This is the structural separation the Nova preface describes:
// the observer is not the generator.
//
// Ideally the judge runs on a different model family than the generator.
// The user controls which model via preferences. Default is sonnet.

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (_client) return _client;
  const prefs = preferences();
  const apiKey = prefs.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Test hook: reset the cached SDK client. */
export function _resetJudgeClientForTests(): void {
  _client = null;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildJudgePrompt(input: JudgeInput): string {
  return `You are the OBSERVER for the Honest Response Protocol. You are not the author of the response. You audit the response against the protocol.

Domain: ${input.domain_label}
Evidence standard: ${input.evidence_standard}
Source expectation: ${input.source_expectation}
HIGH requires: ${input.high_requires}
Adversarial framing for this domain: ${input.adversarial_framing}

ORIGINAL QUERY:
${input.query}

RESPONSE TO AUDIT:
---
${input.response_text}
---

Produce a HRP-conformant JSON verdict describing what the response SHOULD have said under the protocol. Extract the claims the response actually made, tag each with the confidence level it deserves given the sourcing, and run the adversarial pass on the strongest claim.

Respond with ONLY this JSON shape — no prose, no fences:
{
  "evidence": ["string"],
  "response": {
    "claims": [
      { "text": "string", "confidence": "HIGH|INFERRED|UNCERTAIN|BLANK", "source": "string|null" }
    ]
  },
  "countercheck": {
    "challenges": ["string"],
    "survives": true,
    "residual": "string|null"
  },
  "blank": false,
  "blank_reason": null
}

If the response provides no answer or is refusal-only, set blank: true, set all other fields to null except blank_reason, and explain why in blank_reason. A HIGH tag requires a source that meets the domain's source expectation; if no such source is present in the response, downgrade to INFERRED. Do not fabricate sources.`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runJudge(input: JudgeInput): Promise<JudgeOutput> {
  const prefs = preferences();

  const disabled: JudgeOutput = {
    verdict: null,
    validation: {
      valid: false,
      violations: [
        {
          type: "SCHEMA_VIOLATION",
          location: "judge",
          suggestion:
            "Judge is disabled in preferences or no ANTHROPIC_API_KEY is configured. Set apiKey in hrp.preferences.json or export ANTHROPIC_API_KEY.",
          severity: "WARNING",
        },
      ],
      confidence_distribution: { HIGH: 0, INFERRED: 0, UNCERTAIN: 0, BLANK: 0, UNTAGGED: 0 },
      parse_error: null,
    },
    raw: "",
    model: prefs.judge.model,
    invoked: false,
    error: null,
  };

  if (!prefs.judge.enabled) return disabled;
  const api = client();
  if (!api) return disabled;

  const prompt = buildJudgePrompt(input);

  try {
    const res = await api.messages.create({
      model: prefs.judge.model,
      max_tokens: prefs.judge.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    // The judge output goes through the same structural validator as any HRP
    // response. If it doesn't conform, the judge itself is flagged.
    const validation = validateHrpResponse(raw);

    // Best-effort parse for callers that want the raw verdict object.
    let verdict: unknown | null = null;
    try {
      verdict = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
      const schema = HrpResponseSchema.safeParse(verdict);
      if (!schema.success) verdict = null;
    } catch {
      verdict = null;
    }

    return {
      verdict,
      validation,
      raw,
      model: prefs.judge.model,
      invoked: true,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: null,
      validation: {
        valid: false,
        violations: [
          {
            type: "SCHEMA_VIOLATION",
            location: "judge",
            suggestion: `Judge call failed: ${msg}`,
            severity: "ERROR",
          },
        ],
        confidence_distribution: { HIGH: 0, INFERRED: 0, UNCERTAIN: 0, BLANK: 0, UNTAGGED: 0 },
        parse_error: msg,
      },
      raw: "",
      model: prefs.judge.model,
      invoked: true,
      error: msg,
    };
  }
}
