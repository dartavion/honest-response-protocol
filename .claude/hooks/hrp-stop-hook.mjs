#!/usr/bin/env node
/**
 * HRP Stop hook — structural enforcement of post-hoc audit.
 *
 * Claude Code invokes this when the assistant turn ends. The hook:
 *   1. Reads the transcript path from stdin.
 *   2. Pulls the last assistant message.
 *   3. Runs validator.validateHrpResponse() on it (structured path only —
 *      extractor requires network/API and we keep the hook offline).
 *   4. Emits a JSON payload back on stdout. The hook NEVER blocks: it
 *      surfaces violations as advisory hookSpecificOutput, never as a
 *      decision: "block" response.
 *
 * Advisory-by-design matches HRP's stated philosophy:
 * "Violations surface, they don't block." The hook makes enforcement
 * structural in the sense that it runs on every turn without the model's
 * cooperation — but it still only reports.
 *
 * Requires `pnpm build` to have run — this script imports from ../../build/.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VALIDATOR_PATH = resolve(__dirname, "..", "..", "build", "validator.js");

async function loadValidator() {
  if (!existsSync(VALIDATOR_PATH)) return null;
  try {
    return await import(pathToFileURL(VALIDATOR_PATH).href);
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolveFn) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolveFn(data));
  });
}

function extractLastAssistantText(transcriptPath) {
  if (!existsSync(transcriptPath)) return null;
  const raw = readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  // Transcript is JSONL. The schema varies by Claude Code version, so we
  // scan leniently: any record whose role/type suggests assistant, take the
  // last one, concatenate its text blocks.
  let last = null;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const role = rec.role ?? rec.message?.role ?? rec.type;
      if (role !== "assistant") continue;
      const content = rec.content ?? rec.message?.content;
      if (typeof content === "string") {
        last = content;
      } else if (Array.isArray(content)) {
        const text = content
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text) last = text;
      }
    } catch {
      /* skip malformed line */
    }
  }
  return last;
}

async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = input ? JSON.parse(input) : {};
  } catch {
    payload = {};
  }

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) {
    // Nothing to audit — exit silently, don't block.
    process.exit(0);
  }

  const text = extractLastAssistantText(transcriptPath);
  if (!text || text.trim().length === 0) {
    process.exit(0);
  }

  const validator = await loadValidator();
  if (!validator) {
    // Validator not built yet — advise but don't block.
    console.error(
      "hrp-stop-hook: build/validator.js not found. Run `pnpm build` to enable HRP audit on assistant turns.",
    );
    process.exit(0);
  }

  // Structured path only. Plain prose is expected for most assistant turns,
  // and will emit SCHEMA_VIOLATION — that's informational, not a real failure.
  const result = validator.validateHrpResponse(text);

  const structuredIssues = result.violations.filter(
    (v) => v.type !== "SCHEMA_VIOLATION",
  );

  if (structuredIssues.length === 0) {
    // Either the text was structured and clean, or it was prose (SCHEMA_VIOLATION
    // only). Either way, nothing actionable to surface.
    process.exit(0);
  }

  // Non-blocking advisory output. Claude Code renders `additionalContext`
  // to the user without interrupting the turn.
  const summary = {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext:
        "[HRP audit] " +
        structuredIssues
          .map((v) => `${v.severity}:${v.type} — ${v.suggestion}`)
          .join(" | "),
    },
  };

  process.stdout.write(JSON.stringify(summary));
  process.exit(0);
}

main().catch((err) => {
  // Never block on hook error.
  console.error("hrp-stop-hook error:", err?.message ?? String(err));
  process.exit(0);
});
