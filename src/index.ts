#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { validateHrpResponse, validatePlainText } from "./validator.js";
import { session } from "./session.js";

// ─── Confidence Types ─────────────────────────────────────────────────────────

const ConfidenceLevel = z.enum(["HIGH", "INFERRED", "UNCERTAIN", "BLANK"]);
type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

const HrpRespondInput = z.object({
  query: z.string().describe("The question or prompt to respond to"),
  domain: z.string().optional().describe("Optional domain context (e.g. legal, medical, engineering)"),
  depth: z.enum(["standard", "deep"]).default("standard"),
});

const HrpCheckInput = z.object({
  response_text: z.string().describe("The response text to audit against the protocol"),
});

const HrpAdversarialInput = z.object({
  claim: z.string().describe("The claim to challenge"),
  depth: z.enum(["single", "double"]).default("single")
    .describe("single: one reversal pass. double: assume counterargument also fails."),
});

const HrpEvidenceInput = z.object({
  conclusion: z.string().describe("The conclusion requiring evidence before it can be stated"),
});

// ─── Protocol Engine ──────────────────────────────────────────────────────────

function buildRespondPrompt(query: string, domain?: string, depth?: string): string {
  const domainNote = domain ? `\nDomain context: ${domain}` : "";
  const deepNote = depth === "deep"
    ? "\nDepth: DEEP — apply double adversarial pass. Assume counterargument also fails and report what remains standing."
    : "";

  return `You must follow the Honest Response Protocol strictly.${domainNote}${deepNote}

STEP 1 — EVIDENCE FIRST
List all evidence supporting your answer BEFORE stating any conclusion.
If you cannot produce supporting evidence, set blank: true and provide blank_reason. Stop.

STEP 2 — SOURCE OR FLAG
For every factual claim: name a verifiable source, OR mark it [INFERRED].
No unmarked assertions permitted.

STEP 3 — CONFIDENCE TAGGING
Tag every claim:
- HIGH: well-established, sourced, or directly verifiable
- INFERRED: logical inference from known facts, not directly sourced
- UNCERTAIN: low confidence, conflicting info, or knowledge gap
- BLANK: insufficient basis to answer — return this with a reason, nothing else

STEP 4 — ADVERSARIAL SELF-CHECK
After drafting your response, argue against it.
What would have to be true for your conclusion to be wrong?
State this under countercheck.challenges.
Does your answer survive? Set survives: true/false.
If it survives partially, state what remains in residual.

Query: ${query}

Respond ONLY as a JSON object matching this exact structure:
{
  "evidence": ["string"],
  "response": {
    "claims": [
      { "text": "string", "confidence": "HIGH|INFERRED|UNCERTAIN|BLANK", "source": "string|null" }
    ]
  },
  "countercheck": {
    "challenges": ["string"],
    "survives": true,
    "residual": "string|null"
  },
  "blank": false,
  "blank_reason": null
}

If blank is true: set all other fields to null except blank_reason.`;
}

function buildCheckPrompt(responseText: string): string {
  return `Audit the following response against the Honest Response Protocol.

Check for:
1. MISSING_CONFIDENCE_TAG — claims that lack [HIGH], [INFERRED], [UNCERTAIN], or [BLANK] tags
2. UNMARKED_ASSERTION — factual claims with no source and no [INFERRED] marker
3. NO_EVIDENCE — conclusion stated without preceding evidence
4. NO_COUNTERCHECK — no adversarial self-check present

Response to audit:
---
${responseText}
---

Respond ONLY as a JSON object:
{
  "valid": true,
  "violations": [
    { "type": "VIOLATION_TYPE", "location": "quote or description", "suggestion": "how to fix" }
  ],
  "confidence_distribution": {
    "HIGH": 0,
    "INFERRED": 0,
    "UNCERTAIN": 0,
    "BLANK": 0,
    "UNTAGGED": 0
  }
}`;
}

function buildAdversarialPrompt(claim: string, depth: string): string {
  const doublePass = depth === "double"
    ? "\nThen: assume your counterargument is ALSO wrong. What part of the original claim, if any, still stands? Set residual to that surviving kernel, or null if nothing survives."
    : "";

  return `Apply an adversarial reversal test to the following claim.

Claim: "${claim}"

Ask: What would have to be true for this claim to be wrong?
Generate 2–4 concrete challenges. Be specific — not "it could be wrong" but exactly what conditions or evidence would falsify it.${doublePass}

Respond ONLY as a JSON object:
{
  "original_claim": "${claim}",
  "challenges": ["string"],
  "residual_confidence": "HIGH|INFERRED|UNCERTAIN|BLANK",
  "survives": true
}`;
}

function buildEvidencePrompt(conclusion: string): string {
  return `A conclusion has been presented. Before it can be stated, evidence must be produced.

Conclusion: "${conclusion}"

List all evidence that directly supports this conclusion.
If you cannot produce at least one piece of supporting evidence, respond with gate: BLOCKED.
If evidence exists, respond with gate: OPEN and list it.

Respond ONLY as a JSON object:
{
  "evidence_required": true,
  "evidence": ["string"],
  "gate": "OPEN|BLOCKED",
  "prompt": "If BLOCKED: one-sentence explanation of why the conclusion cannot be supported. If OPEN: empty string."
}`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "hrp-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "hrp_respond",
      description:
        "Wraps a query in the full Honest Response Protocol: evidence-first, confidence tagging, source-or-flag, and adversarial self-check. Returns a schema-validated structured response. Use for any substantive factual or analytical query where epistemic discipline matters.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The question or prompt to respond to" },
          domain: { type: "string", description: "Optional domain context (e.g. legal, medical, engineering)" },
          depth: { type: "string", enum: ["standard", "deep"], default: "standard" },
        },
        required: ["query"],
      },
    },
    {
      name: "hrp_check",
      description:
        "Audits an existing response for protocol violations: missing confidence tags, unmarked assertions, missing evidence, missing countercheck. Returns violation list and confidence distribution. Use as a fallback when a response was generated without hrp_respond.",
      inputSchema: {
        type: "object",
        properties: {
          response_text: { type: "string", description: "The response text to audit" },
        },
        required: ["response_text"],
      },
    },
    {
      name: "hrp_adversarial",
      description:
        "Runs an adversarial reversal test on a single claim. Produces concrete falsification conditions and assesses whether the claim survives. Use when you need to stress-test a specific conclusion without running the full protocol.",
      inputSchema: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The claim to challenge" },
          depth: {
            type: "string",
            enum: ["single", "double"],
            default: "single",
            description: "single: one reversal pass. double: assume counterargument also fails.",
          },
        },
        required: ["claim"],
      },
    },
    {
      name: "hrp_evidence",
      description:
        "Evidence gate: requires the model to produce supporting evidence before a conclusion is permitted. Returns OPEN if evidence exists, BLOCKED if it does not. Use to enforce evidence-before-conclusion at any point in a reasoning chain.",
      inputSchema: {
        type: "object",
        properties: {
          conclusion: { type: "string", description: "The conclusion requiring evidence" },
        },
        required: ["conclusion"],
      },
    },
    {
      name: "hrp_session",
      description:
        "Returns a summary of the current session: total turns, violations, confidence distribution, health status (CLEAN/DEGRADED/COMPROMISED), and violation trend. Use to audit the full conversation, not just individual responses.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["summary", "history", "reset"],
            default: "summary",
          },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "hrp_respond": {
        const input = HrpRespondInput.parse(args);
        const prompt = buildRespondPrompt(input.query, input.domain, input.depth);
        // Record turn with no validation yet — validation happens when response comes back via hrp_check
        session.record("hrp_respond", input.query, null, false);
        return {
          content: [{ type: "text", text: prompt }],
          _meta: { protocol: "hrp", tool: "respond", version: "0.1.0" },
        };
      }

      case "hrp_check": {
        const input = HrpCheckInput.parse(args);
        // Try structured JSON validation first, fall back to plain text scan
        let validation;
        try {
          validation = validateHrpResponse(input.response_text);
        } catch {
          validation = validatePlainText(input.response_text);
        }
        session.record("hrp_check", input.response_text.slice(0, 100), validation, false);
        const trend = session.violationTrend();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...validation, session_trend: trend }, null, 2),
          }],
          _meta: { protocol: "hrp", tool: "check", version: "0.1.0" },
        };
      }

      case "hrp_adversarial": {
        const input = HrpAdversarialInput.parse(args);
        const prompt = buildAdversarialPrompt(input.claim, input.depth);
        session.record("hrp_adversarial", input.claim, null, false);
        return {
          content: [{ type: "text", text: prompt }],
          _meta: { protocol: "hrp", tool: "adversarial", version: "0.1.0" },
        };
      }

      case "hrp_evidence": {
        const input = HrpEvidenceInput.parse(args);
        const prompt = buildEvidencePrompt(input.conclusion);
        session.record("hrp_evidence", input.conclusion, null, false);
        return {
          content: [{ type: "text", text: prompt }],
          _meta: { protocol: "hrp", tool: "evidence", version: "0.1.0" },
        };
      }

      case "hrp_session": {
        const action = (args as Record<string, string>)?.action ?? "summary";
        if (action === "reset") {
          session.reset();
          return { content: [{ type: "text", text: JSON.stringify({ reset: true, session_id: session.getId() }) }] };
        }
        if (action === "history") {
          return { content: [{ type: "text", text: JSON.stringify(session.history(), null, 2) }] };
        }
        // Default: summary
        return {
          content: [{ type: "text", text: JSON.stringify(session.summary(), null, 2) }],
          _meta: { protocol: "hrp", tool: "session", version: "0.1.0" },
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `HRP error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Transport ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("hrp-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});