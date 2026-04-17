import { describe, it, expect, beforeEach, vi } from "vitest";

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: messagesCreate };
      constructor(_opts: { apiKey: string }) {}
    },
  };
});

import { extractToHrpJson, _resetExtractorClientForTests } from "../src/extractor.js";
import { resetPreferencesCache } from "../src/preferences.js";

const conformant = {
  evidence: ["Sky appears blue due to Rayleigh scattering."],
  response: {
    claims: [{ text: "The sky is blue.", confidence: "HIGH", source: "optics textbook" }],
  },
  countercheck: {
    challenges: ["Could appear gray when overcast."],
    survives: true,
    residual: null,
  },
  blank: false,
  blank_reason: null,
};

describe("extractToHrpJson", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    _resetExtractorClientForTests();
    resetPreferencesCache();
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.HRP_EXTRACTOR_ENABLED = "true";
  });

  it("returns invoked:false when no API key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HRP_API_KEY;
    resetPreferencesCache();
    _resetExtractorClientForTests();
    const result = await extractToHrpJson("The sky is blue.");
    expect(result.invoked).toBe(false);
    expect(result.error).toMatch(/API key/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("returns invoked:false when extractor is disabled", async () => {
    process.env.HRP_EXTRACTOR_ENABLED = "false";
    resetPreferencesCache();
    const result = await extractToHrpJson("The sky is blue.");
    expect(result.invoked).toBe(false);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("returns extracted JSON on clean output", async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(conformant) }],
    });
    const result = await extractToHrpJson("The sky is blue.");
    expect(result.invoked).toBe(true);
    expect(result.error).toBeNull();
    expect(JSON.parse(result.json)).toEqual(conformant);
  });

  it("strips markdown fences from extractor output", async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "```json\n" + JSON.stringify(conformant) + "\n```" }],
    });
    const result = await extractToHrpJson("The sky is blue.");
    expect(() => JSON.parse(result.json)).not.toThrow();
  });

  it("returns the raw string even if schema invalid — downstream validator catches it", async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "{\"not\": \"hrp\"}" }],
    });
    const result = await extractToHrpJson("plain text");
    expect(result.invoked).toBe(true);
    expect(result.json).toBe("{\"not\": \"hrp\"}");
  });

  it("surfaces API errors", async () => {
    messagesCreate.mockRejectedValue(new Error("rate limited"));
    const result = await extractToHrpJson("anything");
    expect(result.invoked).toBe(true);
    expect(result.error).toBe("rate limited");
    expect(result.json).toBe("");
  });

  it("uses the configured extractor model", async () => {
    process.env.HRP_EXTRACTOR_MODEL = "claude-haiku-override";
    resetPreferencesCache();
    _resetExtractorClientForTests();
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(conformant) }],
    });
    await extractToHrpJson("text");
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-override");
  });
});
