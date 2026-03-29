# CONTEXT.md

## What this repo is

`honest-response-protocol` is an MCP server for Claude Code and VS Code that enforces epistemic discipline in LLM responses. It addresses a structural problem: existing reasoning servers (sequential-thinking, thinking-patterns) provide process structure but not honesty enforcement. A model can follow a structured reasoning process and still produce confident wrong answers. This server adds a layer that makes epistemic violations visible.

## Conceptual foundation

Built on the [Adversarial Clarity Framework](https://github.com/dartavion/nova) (ACF) — a structured analytical process covering claim extraction, incentive scanning, constraint mapping, reversal testing, and confidence assessment. The four HRP tools map directly to ACF primitives:

- `hrp_respond` — full protocol wrapper (claim extraction + confidence assessment)
- `hrp_check` — post-hoc audit (constraint mapping)
- `hrp_adversarial` — reversal test in isolation
- `hrp_evidence` — evidence gate (cost/benefit location before conclusion)
- `hrp_session` — session health tracking across turns

## Key design decisions

**Blank is a first-class response.** A `blank: true` with a `blank_reason` is the correct output when evidence is insufficient. The server treats silence as epistemically valid, not as failure.

**Violations surface, they don't block.** The server reports what the model got away with. It doesn't silently discard non-conforming responses. The user sees the audit trail.

**Schema over instruction.** Zod validates inputs. Structural output validation happens in `src/validator.ts` — not by asking the model to self-audit, which would reintroduce the honesty gap the server is designed to close.

**Voluntary with fallback.** The model can call `hrp_respond` voluntarily. If it responds inline without calling the tool, `hrp_check` can audit the response post-hoc.

## Current state

`v0.1.0-alpha`. Three source files:

- `src/index.ts` — MCP server, five tools, prompt builders
- `src/validator.ts` — structured JSON validator + plain-text heuristic fallback
- `src/session.ts` — in-memory session logger, health assessment, violation trend

No test suite yet. No npm publish yet.

## Open issues (priority order)

**Issue 1 — `test: validator coverage`**
Write `test/validator.test.ts` covering `validateHrpResponse()` and `validatePlainText()`. Key cases: valid conformant response, blank with/without reason, missing evidence, missing countercheck, HIGH claim without source, malformed JSON, schema mismatch.

**Issue 2 — `test: session health thresholds`**
Write `test/session.test.ts` covering `SessionLogger`: turn recording, summary aggregation, health threshold logic (CLEAN/DEGRADED/COMPROMISED), violation trend sliding window, reset.

**Issue 3 — `feat: session persistence`**
Add optional `persistPath` to `SessionLogger`. Append `TurnRecord` to JSONL on each `record()` call. Replay on construction. Default in-memory behavior unchanged.

## Suggested first task for Claude Code

```
Build the Vitest test suite for src/validator.ts and src/session.ts per Issues 1 and 2.
Use pnpm. Add vitest to devDependencies. Write test/validator.test.ts and test/session.test.ts.
Run the suite and fix any type or logic errors before finishing.
```

## Known limitations (honest)

- Session state resets on server restart (Issue 3 addresses this)
- `validatePlainText()` is heuristic — will miss creative violations and may flag false positives
- `hrp_respond` returns a structured prompt, not a validated response — closing this loop is a future task
- The model can still satisfy the schema rhetorically; the adversarial self-check is the human's last line of defense