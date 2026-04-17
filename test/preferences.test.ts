import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPreferences, resetPreferencesCache } from "../src/preferences.js";

describe("loadPreferences", () => {
  let scratch: string;
  let globalPath: string;
  let localPath: string;

  const savedEnv = { ...process.env };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "hrp-prefs-"));
    mkdirSync(join(scratch, "global"), { recursive: true });
    mkdirSync(join(scratch, "local"), { recursive: true });
    globalPath = join(scratch, "global", "preferences.json");
    localPath = join(scratch, "local", "hrp.preferences.json");
    // Strip relevant env so tests are deterministic unless a case sets them.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HRP_API_KEY;
    delete process.env.HRP_JUDGE_MODEL;
    delete process.env.HRP_EXTRACTOR_MODEL;
    delete process.env.HRP_SESSION_PATH;
    delete process.env.HRP_JUDGE_ENABLED;
    delete process.env.HRP_EXTRACTOR_ENABLED;
    resetPreferencesCache();
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    process.env = { ...savedEnv };
    resetPreferencesCache();
  });

  it("returns defaults when no files and no env present", () => {
    const prefs = loadPreferences({ globalPath, localPath });
    expect(prefs.judge.enabled).toBe(true);
    expect(prefs.judge.model).toBe("claude-sonnet-4-6");
    expect(prefs.extractor.model).toBe("claude-haiku-4-5-20251001");
    expect(prefs.apiKey).toBeNull();
    expect(prefs.session.persistPath).toBeNull();
  });

  it("reads local file and applies overrides", () => {
    writeFileSync(
      localPath,
      JSON.stringify({ judge: { model: "claude-opus-4-6" }, apiKey: "sk-test" }),
    );
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.judge.model).toBe("claude-opus-4-6");
    expect(prefs.apiKey).toBe("sk-test");
    // Extractor untouched by local file, keeps defaults
    expect(prefs.extractor.model).toBe("claude-haiku-4-5-20251001");
  });

  it("local overrides global", () => {
    writeFileSync(globalPath, JSON.stringify({ judge: { model: "claude-sonnet-4-6" } }));
    writeFileSync(localPath, JSON.stringify({ judge: { model: "claude-opus-4-6" } }));
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.judge.model).toBe("claude-opus-4-6");
  });

  it("env overrides file when enabled", () => {
    writeFileSync(localPath, JSON.stringify({ apiKey: "sk-from-file" }));
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    process.env.HRP_JUDGE_MODEL = "claude-from-env";
    const prefs = loadPreferences({ globalPath, localPath });
    expect(prefs.apiKey).toBe("sk-from-env");
    expect(prefs.judge.model).toBe("claude-from-env");
  });

  it("HRP_API_KEY is accepted if ANTHROPIC_API_KEY absent", () => {
    process.env.HRP_API_KEY = "sk-hrp";
    const prefs = loadPreferences({ globalPath, localPath });
    expect(prefs.apiKey).toBe("sk-hrp");
  });

  it("HRP_JUDGE_ENABLED=false disables judge", () => {
    process.env.HRP_JUDGE_ENABLED = "false";
    const prefs = loadPreferences({ globalPath, localPath });
    expect(prefs.judge.enabled).toBe(false);
  });

  it("env=false disables env overrides even if set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ignore-me";
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.apiKey).toBeNull();
  });

  it("malformed JSON falls back to defaults without throwing", () => {
    writeFileSync(localPath, "{ this is not json");
    expect(() => loadPreferences({ globalPath, localPath, env: false })).not.toThrow();
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.judge.model).toBe("claude-sonnet-4-6");
  });

  it("schema violation in prefs file falls back to defaults", () => {
    writeFileSync(localPath, JSON.stringify({ judge: { model: 42, enabled: "yes" } }));
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.judge.model).toBe("claude-sonnet-4-6");
    expect(prefs.judge.enabled).toBe(true);
  });

  it("deep-merges nested fields", () => {
    writeFileSync(globalPath, JSON.stringify({ judge: { model: "claude-global", maxTokens: 1024 } }));
    writeFileSync(localPath, JSON.stringify({ judge: { model: "claude-local" } }));
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.judge.model).toBe("claude-local");
    // global's maxTokens should survive the local override (which didn't set it)
    expect(prefs.judge.maxTokens).toBe(1024);
  });

  it("respects session.persistPath from local file", () => {
    writeFileSync(
      localPath,
      JSON.stringify({ session: { persistPath: "/tmp/hrp-session.jsonl" } }),
    );
    const prefs = loadPreferences({ globalPath, localPath, env: false });
    expect(prefs.session.persistPath).toBe("/tmp/hrp-session.jsonl");
  });

  it("HRP_SESSION_PATH env overrides session.persistPath", () => {
    writeFileSync(
      localPath,
      JSON.stringify({ session: { persistPath: "/tmp/from-file.jsonl" } }),
    );
    process.env.HRP_SESSION_PATH = "/tmp/from-env.jsonl";
    const prefs = loadPreferences({ globalPath, localPath });
    expect(prefs.session.persistPath).toBe("/tmp/from-env.jsonl");
  });
});
