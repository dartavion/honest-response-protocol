import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { z } from "zod";

// ─── Schema ───────────────────────────────────────────────────────────────────
//
// Preferences are LOCAL-ONLY. They are not committed. They configure things the
// HRP author cannot decide for the user: which model to use for the judge pass,
// which API key to use, whether enforcement is enabled, etc.
//
// Resolution order (later wins):
//   1. Built-in defaults (below)
//   2. ~/.config/hrp/preferences.json   (user global)
//   3. ./hrp.preferences.json           (project local, gitignored)
//   4. Environment variables            (ANTHROPIC_API_KEY, HRP_JUDGE_MODEL, ...)
//
// No network calls. No persistence. Loaded once at server startup.

const ModelPrefSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1),
  maxTokens: z.number().int().positive().max(8192).default(2048),
});

const PreferencesSchema = z.object({
  judge: ModelPrefSchema.default({
    enabled: true,
    model: "claude-sonnet-4-6",
    maxTokens: 2048,
  }),
  extractor: ModelPrefSchema.default({
    enabled: true,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 2048,
  }),
  apiKey: z.string().nullable().default(null),
  session: z
    .object({
      persistPath: z.string().nullable().default(null),
    })
    .default({ persistPath: null }),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

// ─── Loader ───────────────────────────────────────────────────────────────────

const USER_GLOBAL_PATH = join(homedir(), ".config", "hrp", "preferences.json");
const PROJECT_LOCAL_PATH = resolve(process.cwd(), "hrp.preferences.json");

function readJsonIfExists(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Malformed prefs file → ignore, fall back to defaults. We do NOT throw
    // because a server that refuses to start on a bad prefs file is a worse
    // failure mode than one that runs with defaults and logs a warning.
    return null;
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function applyEnvOverrides(prefs: Preferences): Preferences {
  const out = structuredClone(prefs);
  const envApiKey = process.env.ANTHROPIC_API_KEY ?? process.env.HRP_API_KEY;
  if (envApiKey) out.apiKey = envApiKey;
  const judgeModel = process.env.HRP_JUDGE_MODEL;
  if (judgeModel) out.judge.model = judgeModel;
  const extractorModel = process.env.HRP_EXTRACTOR_MODEL;
  if (extractorModel) out.extractor.model = extractorModel;
  const sessionPath = process.env.HRP_SESSION_PATH;
  if (sessionPath) out.session.persistPath = sessionPath;
  if (process.env.HRP_JUDGE_ENABLED === "false") out.judge.enabled = false;
  if (process.env.HRP_EXTRACTOR_ENABLED === "false") out.extractor.enabled = false;
  return out;
}

export function loadPreferences(
  opts: { globalPath?: string; localPath?: string; env?: boolean } = {},
): Preferences {
  const globalPath = opts.globalPath ?? USER_GLOBAL_PATH;
  const localPath = opts.localPath ?? PROJECT_LOCAL_PATH;
  const applyEnv = opts.env !== false;

  const layers: Record<string, unknown>[] = [];
  const globalFile = readJsonIfExists(globalPath);
  if (globalFile) layers.push(globalFile);
  const localFile = readJsonIfExists(localPath);
  if (localFile) layers.push(localFile);

  // Start from an empty object so Zod fills in defaults, then merge file layers.
  let merged: Record<string, unknown> = {};
  for (const layer of layers) merged = deepMerge(merged, layer);

  const parsed = PreferencesSchema.safeParse(merged);
  if (!parsed.success) {
    // Invalid prefs → log to stderr and fall back to pure defaults.
    process.stderr.write(
      `hrp: preferences invalid (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}) — using defaults\n`,
    );
    const defaults = PreferencesSchema.parse({});
    return applyEnv ? applyEnvOverrides(defaults) : defaults;
  }

  return applyEnv ? applyEnvOverrides(parsed.data) : parsed.data;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _preferences: Preferences | null = null;

export function preferences(): Preferences {
  if (!_preferences) _preferences = loadPreferences();
  return _preferences;
}

/** Testing hook: reset the cached singleton so the next `preferences()` call re-reads. */
export function resetPreferencesCache(): void {
  _preferences = null;
}
