# CONTEXT.md

## What this repo is

`honest-response-protocol` is an MCP server for Claude Code and VS Code that implements the [Nova observer architecture](https://github.com/dartavion/nova) for LLM responses. It addresses a structural problem: existing reasoning servers (sequential-thinking, thinking-patterns) provide process structure but not honesty enforcement. A model can follow a structured reasoning process and still produce confident wrong answers. This server adds the observer layer that makes the honesty gap visible — across any domain.

## Conceptual foundation

Built on [Nova — Observer Architecture for Honest AI](https://github.com/dartavion/nova). Nova defines the observer layer: a structural mechanism that watches AI reasoning as it forms and surfaces what was assumed, inferred without source, or unsupported by evidence — grounded in the witness principle from Michael A. Singer's *The Untethered Soul*.

The five HRP tools map directly to Nova's observer core components (`spec/observer-core.md`):

- `hrp_respond` — full observer wrapper (evidence gate + confidence tagging + adversarial check)
- `hrp_check` — post-hoc audit (observer in audit mode on an existing response)
- `hrp_adversarial` — adversarial check in isolation (reversal test, domain-calibrated)
- `hrp_evidence` — evidence gate in isolation (blocks conclusion without supporting evidence)
- `hrp_session` — session health tracking (observer ledger summary across turns)

## Domain registry

The protocol is domain-agnostic by design. Epistemic failures look different in different fields: a HIGH-confidence medical claim requires a peer-reviewed study; a HIGH-confidence legal claim requires a binding statute or precedent; a HIGH-confidence engineering claim requires a spec or measured result.

The `domain` parameter is accepted by `hrp_respond`, `hrp_check`, and `hrp_adversarial`. When provided, it calibrates:

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

## Key design decisions

**Domain-adaptive, not domain-locked.** The domain parameter adjusts evidence standards and adversarial framing — it does not restrict what queries the protocol accepts. A medical query with no domain specified still runs; it just uses general standards.

**Blank is a first-class response.** A `blank: true` with a `blank_reason` is the correct output when evidence is insufficient. The server treats silence as epistemically valid, not as failure.

**Violations surface, they don't block.** The server reports what the model got away with. It doesn't silently discard non-conforming responses. The user sees the audit trail.

**Schema over instruction.** Zod validates inputs. Structural output validation happens in `src/validator.ts` — not by asking the model to self-audit, which would reintroduce the honesty gap the server is designed to close.

**Voluntary with fallback.** The model can call `hrp_respond` voluntarily. If it responds inline without calling the tool, `hrp_check` can audit the response post-hoc.

## Current state

`v0.2.0-alpha`. Three source files:

- `src/index.ts` — MCP server, five tools, domain registry, domain-adaptive prompt builders
- `src/validator.ts` — structured JSON validator + plain-text heuristic fallback
- `src/session.ts` — session logger with JSONL persistence, health assessment, violation trend

## Open issues (priority order)

**Issue 1 — `test: validator coverage`**
Write `test/validator.test.ts` covering `validateHrpResponse()` and `validatePlainText()`. Key cases: valid conformant response, blank with/without reason, missing evidence, missing countercheck, HIGH claim without source, malformed JSON, schema mismatch.

**Issue 2 — `test: session health thresholds`**
Write `test/session.test.ts` covering `SessionLogger`: turn recording, summary aggregation, health threshold logic (CLEAN/DEGRADED/COMPROMISED), violation trend sliding window, reset, JSONL persistence replay.

**Issue 3 — `feat: domain-aware validator`**
`validateHrpResponse()` and `validatePlainText()` currently apply generic rules. Pass `domain` config into the validator so that, e.g., HIGH claims in the `medical` domain require a journal citation pattern, and HIGH claims in `legal` require a statute or case citation pattern.

## Suggested first task for Claude Code

```
Build the Vitest test suite for src/validator.ts and src/session.ts per Issues 1 and 2.
Use pnpm. Add vitest to devDependencies. Write test/validator.test.ts and test/session.test.ts.
Run the suite and fix any type or logic errors before finishing.
```

## Known limitations (honest)

- `validatePlainText()` is heuristic — will miss creative violations and may flag false positives
- `validateHrpResponse()` does not yet apply domain-specific source pattern matching (Issue 3)
- `hrp_respond` returns a structured prompt, not a validated response — closing this loop is a future task
- The model can still satisfy the schema rhetorically; the adversarial self-check is the human's last line of defense