import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock @anthropic-ai/sdk before importing the module under test ────────────
//
// The judge makes a real API call in production. Tests intercept at the SDK
// boundary so we exercise the code path without a network call.

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: messagesCreate };
      constructor(_opts: { apiKey: string }) {}
    },
  };
});

import { runJudge, _resetJudgeClientForTests } from "../src/judge.js";
import { resetPreferencesCache } from "../src/preferences.js";

const baseInput = {
  query: "What caused the 2008 crisis?",
  response_text: "The Fed's rate cuts caused the housing bubble.",
  domain_label: "Financial",
  evidence_standard: "Audited filings, peer-reviewed research.",
  source_expectation: "Cite filing or research paper for HIGH claims.",
  high_requires: "Verifiable historical data from official filings.",
  adversarial_framing: "What market conditions would invalidate this?",
};

const conformantVerdict = {
  evidence: ["Housing starts peaked in 2005."],
  response: {
    claims: [
      {
        text: "Multiple factors contributed; rate policy was one input among many.",
        confidence: "INFERRED",
        source: null,
      },
    ],
  },
  countercheck: {
    challenges: ["Would the bubble have formed without the rate cuts?"],
    survives: true,
    residual: "Rate policy contributed but was not the sole cause.",
  },
  blank: false,
  blank_reason: null,
};

describe("runJudge", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    _resetJudgeClientForTests();
    resetPreferencesCache();
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.HRP_JUDGE_ENABLED = "true";
  });

  it("returns invoked:false when no API key is present", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HRP_API_KEY;
    resetPreferencesCache();
    _resetJudgeClientForTests();
    const result = await runJudge(baseInput);
    expect(result.invoked).toBe(false);
    expect(result.validation.valid).toBe(false);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("returns invoked:false when judge is disabled via env", async () => {
    process.env.HRP_JUDGE_ENABLED = "false";
    resetPreferencesCache();
    const result = await runJudge(baseInput);
    expect(result.invoked).toBe(false);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("invokes SDK and returns a parsed, validated verdict on clean output", async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(conformantVerdict) }],
    });
    const result = await runJudge(baseInput);
    expect(result.invoked).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.verdict).not.toBeNull();
    expect(result.error).toBeNull();
    expect(messagesCreate).toHaveBeenCalledOnce();
  });

  it("strips markdown fences from judge output", async () => {
    messagesCreate.mockResolvedValue({
      content: [
        { type: "text", text: "```json\n" + JSON.stringify(conformantVerdict) + "\n```" },
      ],
    });
    const result = await runJudge(baseInput);
    expect(result.validation.valid).toBe(true);
    expect(result.verdict).not.toBeNull();
  });

  it("flags schema violation when judge returns non-conformant output", async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "{\"foo\": \"bar\"}" }],
    });
    const result = await runJudge(baseInput);
    expect(result.invoked).toBe(true);
    expect(result.validation.valid).toBe(false);
    expect(result.verdict).toBeNull();
    expect(result.validation.violations[0].type).toBe("SCHEMA_VIOLATION");
  });

  it("surfaces API errors cleanly", async () => {
    messagesCreate.mockRejectedValue(new Error("network down"));
    const result = await runJudge(baseInput);
    expect(result.invoked).toBe(true);
    expect(result.error).toBe("network down");
    expect(result.validation.valid).toBe(false);
  });

  it("passes the configured judge model to the SDK", async () => {
    process.env.HRP_JUDGE_MODEL = "claude-opus-4-6";
    resetPreferencesCache();
    _resetJudgeClientForTests();
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(conformantVerdict) }],
    });
    await runJudge(baseInput);
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-4-6");
  });

  it("concatenates multiple text blocks in the response", async () => {
    messagesCreate.mockResolvedValue({
      content: [
        { type: "text", text: JSON.stringify(conformantVerdict).slice(0, 40) },
        { type: "text", text: JSON.stringify(conformantVerdict).slice(40) },
      ],
    });
    const result = await runJudge(baseInput);
    expect(result.validation.valid).toBe(true);
  });
});
