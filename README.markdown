# hrp-mcp

**Honest Response Protocol — MCP Server**

An MCP server for Claude Code and VS Code that implements the [Nova observer architecture](https://github.com/dartavion/nova) for LLM responses. Provides structural tools for closing the honesty gap: evidence-first reasoning, domain-calibrated confidence tagging, source attribution, and adversarial self-checking.

> Built on [Nova — Observer Architecture for Honest AI](https://github.com/dartavion/nova).

---

## The Problem

A model can be wrong and certain at the same time.

Standard prompting gives a model permission to say "I don't know" — but it doesn't fix miscalibrated confidence. A model without an observer layer becomes its output: swept into the momentum of fluent generation, with no mechanism to ask *do I actually know this, or am I performing knowing?*

This is the **honesty gap** — the distance between what a model actually knows and what it presents. Existing MCP reasoning servers provide process structure without honesty enforcement. HRP provides the observer layer that makes the gap visible.

What counts as sufficient evidence varies by domain. A peer-reviewed study is the floor for medical claims; a binding statute is the floor for legal ones; a spec or measured result is the floor for engineering. Generic confidence enforcement treats all domains the same — too loose for high-stakes fields, too strict for informal ones. HRP calibrates to the domain.

---

## Domain Registry

The `domain` parameter is accepted by `hrp_respond`, `hrp_check`, and `hrp_adversarial`. When provided, it calibrates evidence standards, source expectations, the HIGH confidence threshold, domain-specific caution notes, and adversarial falsification framing.

| Domain | Evidence floor | HIGH requires |
|--------|---------------|---------------|
| `medical` | Peer-reviewed studies, clinical guidelines (NICE, WHO, CDC), FDA approvals | Published, peer-reviewed study or established guideline |
| `legal` | Statutes, binding case law, regulations in the stated jurisdiction | Binding authority in jurisdiction; persuasive authority is INFERRED |
| `engineering` | Published specs, standards (ISO, ANSI, IEEE, ASTM), empirical test data | Specification, standard, or empirically measured result |
| `scientific` | Peer-reviewed, replicated research; preprints are INFERRED | Replicated finding or scientific consensus |
| `financial` | Audited filings (SEC/EDGAR), official market data, peer-reviewed economic research | Verifiable historical data from official filings or data sources |
| `historical` | Primary sources, scholarly secondary sources, historiographical consensus | Primary source documentation or strong scholarly consensus |
| `civic` | Official government records, peer-reviewed political science, electoral/census data | Official primary source or peer-reviewed research; normative claims are never HIGH |
| `general` | Credible primary or secondary sources | Well-established, directly verifiable claim with a nameable source |

Any unrecognized domain string falls back to `general` standards.

---

## How It Works

The server exposes six tools. Five can be called voluntarily by the model; `hrp_judge` runs a separate model in a separate context to audit a response — structural separation between author and observer. A Claude Code Stop hook provides runtime enforcement that does not require the model to cooperate.

### Tools

#### `hrp_respond`
The primary tool. Returns a structured prompt that instructs the model to respond under the full Honest Response Protocol. The model's reply should then be validated with `hrp_check`.

Input:
```json
{
  "query": "string",
  "domain": "string (optional — medical | legal | engineering | scientific | financial | historical | civic | general)",
  "depth": "standard | deep"
}
```

The expected response shape (validated by `hrp_check`):
```json
{
  "evidence": ["string"],
  "response": {
    "claims": [
      {
        "text": "string",
        "confidence": "HIGH | INFERRED | UNCERTAIN | BLANK",
        "source": "string | null"
      }
    ]
  },
  "countercheck": {
    "challenges": ["string"],
    "survives": "boolean",
    "residual": "string | null"
  },
  "blank": "boolean",
  "blank_reason": "string | null"
}
```

If `blank: true`, all other fields except `blank_reason` are null. No inference dressed as fact.

---

#### `hrp_check`
Validates an existing response against the protocol. Applies domain-calibrated evidence standards when `domain` is provided. Use as a fallback auditor when the model responds without calling `hrp_respond`.

Input:
```json
{
  "response_text": "string",
  "domain": "string (optional — same domain used when the response was generated)"
}
```

Output:
```json
{
  "valid": "boolean",
  "violations": [
    {
      "type": "MISSING_CONFIDENCE_TAG | UNMARKED_ASSERTION | NO_EVIDENCE | NO_COUNTERCHECK",
      "location": "string",
      "suggestion": "string"
    }
  ],
  "confidence_distribution": {
    "HIGH": "number",
    "INFERRED": "number",
    "UNCERTAIN": "number",
    "BLANK": "number",
    "UNTAGGED": "number"
  }
}
```

---

#### `hrp_adversarial`
Runs a domain-calibrated adversarial reversal test on a given claim. Falsification framing adapts to the domain — engineering challenges target failure modes and tolerances; legal challenges target jurisdiction and conflicting authority; medical challenges target population variance and study design.

Input:
```json
{
  "claim": "string",
  "depth": "single | double",
  "domain": "string (optional)"
}
```

`single` — What would have to be true for this to be wrong?  
`double` — Assume the counterargument is also wrong. What remains standing?

Output:
```json
{
  "original_claim": "string",
  "challenges": ["string"],
  "residual_confidence": "HIGH | INFERRED | UNCERTAIN | BLANK",
  "survives": "boolean"
}
```

---

#### `hrp_evidence`
Evidence-before-conclusion gate. Requires the model to produce supporting evidence before a conclusion is permitted.

Input:
```json
{
  "conclusion": "string"
}
```

Output:
```json
{
  "evidence_required": true,
  "prompt": "string",
  "gate": "OPEN | BLOCKED"
}
```

Returns `BLOCKED` with a structured prompt if the model cannot produce evidence. Forces the reasoning path before the conclusion token.

---

#### `hrp_judge`
Separate-observer audit. Invokes a **different model in a fresh context** to judge a response against the protocol. The judge never sees the generator's chain of thought — only the final response — which is the structural separation the observer architecture has been describing. Use this when you want real separation between author and observer, not author-auditing-itself.

Input:
```json
{
  "query": "string",
  "response_text": "string",
  "domain": "string (optional)"
}
```

Output includes the judge's verdict (HRP-shaped JSON), structural validation of that verdict, and the model that was used. Requires an Anthropic API key — configure via [local preferences](#local-preferences) or the `ANTHROPIC_API_KEY` env var.

---

#### `hrp_session`
Returns session-level audit data across all turns. Use to inspect accumulated violations and session health, not just individual responses.

Input:
```json
{
  "action": "summary | history | reset"
}
```

`summary` (default) returns:
```json
{
  "session_id": "string",
  "started": "ISO timestamp",
  "turns": "number",
  "total_violations": "number",
  "violation_breakdown": { "NO_EVIDENCE": "number", "...": "number" },
  "blank_rate": "number",
  "confidence_totals": { "HIGH": "number", "INFERRED": "number", "..." : "number" },
  "health": "CLEAN | DEGRADED | COMPROMISED",
  "health_reason": "string | null"
}
```

`history` returns the full array of `TurnRecord` objects.
`reset` clears the session log and returns `{ reset: true, session_id: "string" }`.

Health thresholds: `COMPROMISED` if ≥ 3 ERROR-level violations; `DEGRADED` if average violations per turn exceeds 1.5; `CLEAN` otherwise.

---

## Enforcement Model

```
User query
    │
    ▼
Model calls hrp_respond voluntarily
    │
    ├── Schema validates output
    │       └── Violation? → hrp_check flags it, returns to model for correction
    │
    └── Model responds inline without hrp_respond
            └── Fallback: hrp_check audits the response post-hoc
                    └── Violations surfaced to user with confidence_distribution
```

The server does not block responses — it surfaces violations with structured feedback. The user sees what the model got away with.

---

## Local Preferences

Per-user configuration is read from `hrp.preferences.json` in the project root. This file is **gitignored** — it holds your API key and model choices and is not shared across the team. Copy `hrp.preferences.example.json` to start.

```json
{
  "judge": { "enabled": true, "model": "claude-sonnet-4-6", "maxTokens": 2048 },
  "extractor": { "enabled": true, "model": "claude-haiku-4-5-20251001", "maxTokens": 2048 },
  "apiKey": null,
  "session": { "persistPath": null }
}
```

Resolution order (later wins):

1. Built-in defaults
2. `~/.config/hrp/preferences.json` (user global)
3. `./hrp.preferences.json` (project local, gitignored)
4. Env: `ANTHROPIC_API_KEY`, `HRP_JUDGE_MODEL`, `HRP_EXTRACTOR_MODEL`, `HRP_SESSION_PATH`, `HRP_JUDGE_ENABLED`, `HRP_EXTRACTOR_ENABLED`

If no API key is configured, `hrp_judge` and the extractor fallback in `hrp_check` return `invoked: false` with a descriptive message instead of failing. The rest of the protocol still works.

---

## Stop Hook — Runtime Enforcement in Claude Code

`hrp_check`, `hrp_respond`, and `hrp_adversarial` are voluntary — the model chooses whether to call them. That's the weakest link in the original design. To close it, this repo ships a Claude Code Stop hook at `.claude/hooks/hrp-stop-hook.mjs` that runs on every assistant turn and pipes the final response through `validateHrpResponse`. The hook is **advisory, not blocking** — it surfaces violations via `additionalContext` and never interrupts the turn — which matches the project's "violations surface, they don't block" principle, but it does so structurally: the model has no way to opt out.

The hook runs offline (no API calls) — it uses the structural JSON validator only. For deeper audit on prose responses, call `hrp_judge` explicitly.

To disable, remove the `hooks.Stop` entry from `.claude/settings.json`.

---

## Installation

```bash
npm install -g hrp-mcp
```

### VS Code (`.vscode/mcp.json`)
```json
{
  "servers": {
    "hrp": {
      "command": "npx",
      "args": ["-y", "hrp-mcp"]
    }
  }
}
```

### Claude Code (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "hrp": {
      "command": "npx",
      "args": ["-y", "hrp-mcp"]
    }
  }
}
```

---

## Usage

You can invoke the protocol explicitly or let it run as background audit.

**Explicit invocation:**
```
Use hrp_respond to answer: What caused the 2008 financial crisis?
```

**Adversarial check only:**
```
Use hrp_adversarial on this claim: "The Fed's rate cuts caused the housing bubble."
```

**Post-hoc audit:**
```
Use hrp_check to validate the last response.
```

---

## Design Principles

- **The observer is structural, not rhetorical.** Asking a model to be honest is not the same as making it honest. HRP validates structure — evidence fields, source attribution, adversarial checks — so the gap has somewhere to show up.
- **Blank is a first-class response.** A `[BLANK]` with a reason is the epistemically correct output when evidence is insufficient. Silence with explanation is more honest than a confident wrong answer.
- **Forthcoming by design.** The observer surfaces what the model does not know, not just what it does. It does not wait for the human to probe.
- **Violations surface, they don't block.** The server reports what the model got away with. The user sees the audit trail.
- **Auditable.** Every tool call is logged. The reasoning path is inspectable.

---

## Roadmap

- [x] Core tool implementations (`hrp_respond`, `hrp_check`, `hrp_adversarial`, `hrp_evidence`, `hrp_session`)
- [x] Schema validation layer
- [x] Confidence distribution reporting
- [x] Session persistence (JSONL append, replay on construction, reset)
- [x] Domain registry — medical, legal, engineering, scientific, financial, historical, civic, general
- [x] Domain-adaptive prompt builders (evidence standards, source expectations, adversarial framing)
- [x] `hrp_judge` — separate-observer tool (different model, fresh context)
- [x] Extractor-backed `hrp_check` fallback (replaces gameable plaintext regex)
- [x] Claude Code Stop hook — runtime enforcement without model cooperation
- [x] Per-user preferences (`hrp.preferences.json`, gitignored)
- [ ] Domain-aware structural validator (source pattern matching per domain in `validateHrpResponse`)
- [ ] WIPf signing + hash-chained ledger entries
- [ ] Confidence ontology rework: split provenance / confidence / answerability

---

## License

MIT

---

## Known Limitations

This is `v0.2.0-alpha`. The protocol is structurally sound; the implementation has honest gaps.

**Domain-aware validation is prompt-level only.**
`validateHrpResponse()` and `validatePlainText()` apply generic structural rules regardless of domain. Domain calibration currently lives in the prompt builders — the validator does not yet apply domain-specific source pattern matching (e.g. checking that a HIGH medical claim cites a DOI or guideline name). This is the next structural gap to close.

**`hrp_check` plain-text scanning is heuristic.**
When auditing a response that isn't structured JSON, `validatePlainText()` uses pattern matching. It will miss violations in creatively phrased responses and may flag false positives. The structured JSON path (`validateHrpResponse()`) is deterministic; the plain-text path is not.

**The model can still satisfy the schema rhetorically.**
Schema validation catches structural violations — missing fields, wrong types, empty evidence arrays. It does not catch a model that populates all fields with plausible-sounding but fabricated content. The adversarial self-check is the human's last line of defense, not the server's.

**`hrp_respond` returns a prompt, not a validated response.**
The tool gives the model a structured prompt to respond to. It does not intercept or validate the model's actual output — that requires a follow-up `hrp_check` call.

---
## Related

- [Adversarial Clarity Framework](https://github.com/dartavion/nova)
- [MCP Sequential Thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking)
- OpenAI, *Training LLMs for Honesty via Confessions* (2025)