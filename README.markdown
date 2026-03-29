# hrp-mcp

**Honest Response Protocol — MCP Server**

An MCP server for Claude Code and VS Code that enforces epistemic discipline in LLM responses. Closes the AI honesty gap by providing structured tools for confidence tagging, evidence-first reasoning, source attribution, and adversarial self-checking.

> Built on the [Adversarial Clarity Framework](https://github.com/dartavion/nova).

---

## The Problem

Standard prompting gives a model permission to say "I don't know" — but doesn't fix miscalibrated confidence. A model can be wrong *and* certain. Existing MCP reasoning servers (sequential-thinking, thinking-patterns) provide process structure without honesty enforcement. This server provides both.

---

## How It Works

The server exposes four tools. The model can call them voluntarily; schema validation catches non-conforming responses as a fallback.

### Tools

#### `hrp_respond`
The primary tool. Wraps a query in the full Honest Response Protocol.

Input:
```json
{
  "query": "string",
  "domain": "string (optional — e.g. 'legal', 'medical', 'engineering')",
  "depth": "standard | deep"
}
```

Output (schema-validated):
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
Validates an existing response against the protocol. Use as a fallback auditor when the model responds without calling `hrp_respond`.

Input:
```json
{
  "response_text": "string"
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
Runs the adversarial self-check (reversal test) on a given claim or response in isolation.

Input:
```json
{
  "claim": "string",
  "depth": "single | double"
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

- **Blank is not failure.** A `[BLANK]` with a reason is the epistemically correct output when evidence is insufficient. The server treats it as a first-class response.
- **Violations surface, they don't block.** The server reports what the model got wrong. It doesn't silently discard responses.
- **Schema over instruction.** Validation is structural, not rhetorical. The model can't satisfy it with plausible-sounding language.
- **Auditable.** Every tool call is logged. The reasoning path is inspectable.

---

## Roadmap

- [ ] Core tool implementations (`hrp_respond`, `hrp_check`, `hrp_adversarial`, `hrp_evidence`)
- [ ] Schema validation layer
- [ ] Confidence distribution reporting
- [ ] Domain-specific tag extensions (legal, medical, engineering)
- [ ] Session persistence (reasoning log across turns)
- [ ] ACF integration — full framework as optional deep mode

---

## License

MIT

---

## Known Limitations

This is `v0.1.0-alpha`. The protocol is structurally sound; the implementation has honest gaps.

**Session state is in-memory only.**
The `hrp_session` logger resets on server restart. Reasoning chains are not persisted across sessions. If you restart Claude Code or VS Code, the violation history is gone. Session persistence is on the roadmap.

**`hrp_check` plain-text scanning is heuristic.**
When auditing a response that isn't structured JSON, `validatePlainText()` uses pattern matching — looking for confidence tag patterns, countercheck keywords, and source attribution markers. It will miss violations in creatively phrased responses and may flag false positives. The structured JSON path (`validateHrpResponse()`) is deterministic; the plain-text path is not.

**No npm package yet.**
Install from source. `npm publish` is pending test coverage.

**The model can still satisfy the schema rhetorically.**
Schema validation catches structural violations — missing fields, wrong types, empty evidence arrays. It does not catch a model that populates all fields with plausible-sounding but fabricated content. The adversarial self-check is the human's last line of defense, not the server's.

**`hrp_respond` returns a prompt, not a validated response.**
The tool gives the model a structured prompt to respond to. It does not intercept or validate the model's actual output — that requires a follow-up `hrp_check` call. A future version will close this loop automatically.

---
## Related

- [Adversarial Clarity Framework](https://github.com/dartavion/nova)
- [MCP Sequential Thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking)
- OpenAI, *Training LLMs for Honesty via Confessions* (2025)