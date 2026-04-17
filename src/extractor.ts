import Anthropic from "@anthropic-ai/sdk";
import { HrpResponseSchema } from "./validator.js";
import { preferences } from "./preferences.js";

// ─── Purpose ──────────────────────────────────────────────────────────────────
//
// Replaces the gameable-regex `validatePlainText` path. When hrp_check is
// handed freeform prose (no JSON), this module makes a SEPARATE model call
// whose only job is to convert the prose into an HRP-conformant JSON shape
// — no audit, no opinion, just structural extraction. The result is then
// validated by the same validator.validateHrpResponse() used everywhere else.
//
// The extractor must be strict: it does NOT invent sources, does NOT upgrade
// confidence, does NOT add evidence. It reports exactly what the text said,
// in the schema's shape. That gives downstream validation real teeth.

export interface ExtractResult {
  /** JSON string the extractor produced (may be empty on failure). */
  json: string;
  /** Whether the extractor was invoked. */
  invoked: boolean;
  /** Model used. */
  model: string;
  /** Error message if the call failed. */
  error: string | null;
}

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
export function _resetExtractorClientForTests(): void {
  _client = null;
}

function buildExtractionPrompt(plaintext: string): string {
  return `Convert the following response into Honest Response Protocol JSON. You are an EXTRACTOR, not an author. Report only what the text says. Do not invent sources. Do not upgrade confidence. Do not add evidence the text does not contain.

Rules:
- Each distinct factual claim in the text becomes one object in response.claims.
- A claim's confidence is HIGH only if the text names a verifiable source for it. If no source is present, the claim is INFERRED. If the text hedges or expresses doubt, the claim is UNCERTAIN.
- The evidence array lists whatever the text presented as evidence BEFORE conclusions. If the text jumps to conclusions without evidence, evidence is [].
- The countercheck.challenges array is populated only if the text raises its own counterarguments or caveats. If the text does not, challenges is [] and survives defaults to true.
- If the text provides no answer (pure refusal or deferral), set blank: true, all other fields to null except blank_reason, and summarize the refusal reason.

Respond with ONLY this JSON — no fences, no prose:
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

TEXT TO EXTRACT:
---
${plaintext}
---`;
}

export async function extractToHrpJson(plaintext: string): Promise<ExtractResult> {
  const prefs = preferences();

  if (!prefs.extractor.enabled) {
    return {
      json: "",
      invoked: false,
      model: prefs.extractor.model,
      error: "extractor disabled in preferences",
    };
  }

  const api = client();
  if (!api) {
    return {
      json: "",
      invoked: false,
      model: prefs.extractor.model,
      error: "no API key configured (set apiKey in hrp.preferences.json or export ANTHROPIC_API_KEY)",
    };
  }

  try {
    const res = await api.messages.create({
      model: prefs.extractor.model,
      max_tokens: prefs.extractor.maxTokens,
      messages: [{ role: "user", content: buildExtractionPrompt(plaintext) }],
    });

    const raw = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();

    // Validate that the extractor returned something schema-shaped. If not,
    // surface the raw anyway — validateHrpResponse will catch the schema
    // violation downstream.
    try {
      const parsed = JSON.parse(cleaned);
      HrpResponseSchema.safeParse(parsed);
    } catch {
      /* ignore — downstream validator will report SCHEMA_VIOLATION */
    }

    return {
      json: cleaned,
      invoked: true,
      model: prefs.extractor.model,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      json: "",
      invoked: true,
      model: prefs.extractor.model,
      error: msg,
    };
  }
}
