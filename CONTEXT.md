# CONTEXT.md

## What this repo is

`honest-response-protocol` is an MCP server for Claude Code and VS Code that implements the [Nova observer architecture](https://github.com/dartavion/nova) for LLM responses. It addresses a structural problem: existing reasoning servers (sequential-thinking, thinking-patterns) provide process structure but not honesty enforcement. A model can follow a structured reasoning process and still produce confident wrong answers. This server adds the observer layer that makes the honesty gap visible — across any domain.

## Conceptual foundation

Built on [Nova — Observer Architecture for Honest AI](https://github.com/dartavion/nova). Nova defines the observer layer: a structural mechanism that watches AI reasoning as it forms and surfaces what was assumed, inferred without source, or unsupported by evidence — grounded in the witness principle from Michael A. Singer's *The Untethered Soul*.

Six HRP tools now map to Nova's observer architecture:

- `hrp_respond` — full observer wrapper (evidence gate + confidence tagging + adversarial check)
- `hrp_check` — post-hoc audit of an existing response (extractor-backed when input is prose)
- `hrp_adversarial` — adversarial check in isolation (reversal test, domain-calibrated)
- `hrp_evidence` — evidence gate in isolation (blocks conclusion without supporting evidence)
- `hrp_session` — session health tracking (observer ledger summary across turns)
- `hrp_judge` — **separate-observer** audit: invokes a different model in a fresh context. This is the structural separation Nova's preface describes (observer ≠ generator), now implemented as a real process boundary rather than a prompt instruction.

A Claude Code **Stop hook** (`.claude/hooks/hrp-stop-hook.mjs`) provides runtime enforcement without model cooperation — it pipes every assistant turn through the validator and surfaces violations as advisory context. The model cannot route around it.

## Domain registry

The protocol is domain-agnostic by design. Epistemic failures look different in different fields: a HIGH-confidence medical claim requires a peer-reviewed study; a HIGH-confidence legal claim requires a binding statute or precedent; a HIGH-confidence engineering claim requires a spec or measured result.

The `domain` parameter is accepted by `hrp_respond`, `hrp_check`, `hrp_adversarial`, and `hrp_judge`. When provided, it calibrates:

- **Evidence standard** — what qualifies as sufficient evidence in this field
- **Source expectation** — what a valid source looks like and how it should be cited
- **HIGH threshold** — what a claim must clear to be tagged HIGH (not just plausible)
- **Caution note** — domain-specific risks injected into the prompt (e.g. patient safety, jurisdiction scope)
- **Adversarial framing** — domain-specific falsification challenges

Built-in domains (defined in `src/index.ts` → `DOMAIN_REGISTRY`):

| Key | Label |
|-----|-------|
| `medical` | Medical / Clinical |
| `legal` | Legal |
| `engineering` | Engineering / Technical |
| `scientific` | Scientific / Research |
| `financial` | Financial |
| `historical` | Historical |
| `civic` | Civic / Political Science |
| `general` | General (fallback) |

Any unrecognized domain string falls back to general standards with the label surfaced.

## Per-user preferences

`hrp.preferences.json` at the project root is **gitignored** and holds local-only config — API key, judge/extractor model choices, session persistence path. Resolution order: defaults → `~/.config/hrp/preferences.json` → `./hrp.preferences.json` → env vars (`ANTHROPIC_API_KEY`, `HRP_JUDGE_MODEL`, `HRP_EXTRACTOR_MODEL`, `HRP_SESSION_PATH`, etc.). Missing API key disables judge/extractor gracefully; the rest of the protocol still works. See `hrp.preferences.example.json` for the template.

## Key design decisions

**Domain-adaptive, not domain-locked.** The domain parameter adjusts evidence standards and adversarial framing — it does not restrict what queries the protocol accepts. A medical query with no domain specified still runs; it just uses general standards.

**Blank is a first-class response.** A `blank: true` with a `blank_reason` is the correct output when evidence is insufficient. The server treats silence as epistemically valid, not as failure.

**Violations surface, they don't block.** Both `hrp_check` and the Stop hook report without interrupting. The user sees the audit trail.

**Schema over instruction.** Zod validates inputs. Structural output validation happens in `src/validator.ts` — not by asking the model to self-audit, which would reintroduce the honesty gap the server is designed to close.

**Observer ≠ generator.** `hrp_judge` runs a separate model (configurable per user) in a fresh context. This is the structural separation the Nova philosophy has always described; the rest of the protocol approximates it in-context, but the judge tool is the real thing.

**Voluntary + fallback + enforced.** The model can call `hrp_respond` voluntarily. `hrp_check` can audit post-hoc. The Claude Code Stop hook runs unconditionally on every assistant turn. Three layers; progressively less dependent on model cooperation.

## Current state

`v0.2.0-alpha`. Source files:

- `src/index.ts` — MCP server, six tools, domain registry, domain-adaptive prompt builders
- `src/validator.ts` — structured JSON validator + plain-text heuristic fallback
- `src/session.ts` — session logger with optional JSONL persistence, health assessment, violation trend
- `src/judge.ts` — `hrp_judge` implementation (separate-model API call, validates own output)
- `src/extractor.ts` — prose → HRP JSON extraction for `hrp_check` on unstructured responses
- `src/preferences.ts` — layered config loader (defaults / global / local / env)
- `.claude/hooks/hrp-stop-hook.mjs` — advisory Stop hook

Tests: `test/validator.test.ts`, `test/session.test.ts`, `test/preferences.test.ts`, `test/judge.test.ts`, `test/extractor.test.ts`. Judge and extractor tests mock `@anthropic-ai/sdk` at the import boundary.

## Open work (priority order)

**Issue 1 — Domain-aware structural validator**
`validateHrpResponse()` still applies generic rules. Pass `domain` config into the validator so that, e.g., HIGH claims in the `medical` domain require a journal-citation pattern, and HIGH claims in `legal` require a statute/case-citation pattern.

**Issue 2 — WIPf signing and hash-chained ledger**
Nova spec requires cryptographic proofs and tamper-evident ledger entries. Current session logger is plain JSONL. Implement ed25519 signing and `prev` hash chaining.

**Issue 3 — Confidence ontology rework**
`HIGH | INFERRED | UNCERTAIN | BLANK` mixes provenance, confidence, and answerability. Split into three axes before v1.

## Known limitations (honest)

- The Stop hook uses the structural validator only (offline). Prose responses produce `SCHEMA_VIOLATION` and are filtered out of user-facing advisories. Deeper audit requires calling `hrp_judge` explicitly.
- `validatePlainText()` is retained as a last-resort fallback when the extractor is disabled; it remains gameable.
- `hrp_judge` requires an API key. When unavailable, it returns `invoked: false` with a clear reason — not a silent pass.
- The model can still satisfy the schema rhetorically; `hrp_judge`'s separate context makes that harder but not impossible. A dissenting judge verdict is a signal, not a refutation.
