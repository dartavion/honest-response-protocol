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

// ─── Domain Registry ──────────────────────────────────────────────────────────

interface DomainConfig {
  label: string;
  evidenceStandard: string;
  sourceExpectation: string;
  highRequires: string;
  cautionNote: string;
  adversarialFraming: string;
}

const DOMAIN_REGISTRY: Record<string, DomainConfig> = {
  medical: {
    label: "Medical / Clinical",
    evidenceStandard:
      "Peer-reviewed studies, systematic reviews, meta-analyses, clinical guidelines (e.g. NICE, WHO, CDC), or FDA/regulatory approvals. Case reports and expert opinion are INFERRED at best.",
    sourceExpectation:
      "Cite journal (PubMed ID, DOI, or guideline name) for HIGH claims. Anecdotal or single-study evidence is INFERRED.",
    highRequires:
      "Published, peer-reviewed study or established clinical guideline. Reproducibility matters.",
    cautionNote:
      "Patient safety is at stake. Prefer BLANK or UNCERTAIN over speculation. Never extrapolate beyond the evidence base. Contraindications and population-specific variance must be noted.",
    adversarialFraming:
      "Challenge: What patient population, dosage range, comorbidity, or study design limitation would make this wrong? Are there conflicting trials?",
  },
  legal: {
    label: "Legal",
    evidenceStandard:
      "Statutes, regulations, binding case law, or legal precedent in the relevant jurisdiction. Secondary sources (law review, treatises) are INFERRED. Jurisdiction must be specified.",
    sourceExpectation:
      "Cite statute (e.g. 42 U.S.C. § 1983), case (e.g. Marbury v. Madison, 1803), or regulation (e.g. 17 CFR § 240.10b-5) for HIGH claims.",
    highRequires:
      "Binding authority in the stated jurisdiction. Persuasive authority (other jurisdictions, dicta) is INFERRED.",
    cautionNote:
      "Jurisdiction governs everything. A claim valid in one jurisdiction may be inapplicable or wrong in another. Flag jurisdictional scope explicitly. This is not legal advice.",
    adversarialFraming:
      "Challenge: Would this hold in a different jurisdiction? Has this been overturned or distinguished? Is there a circuit split or conflicting authority?",
  },
  engineering: {
    label: "Engineering / Technical",
    evidenceStandard:
      "Published specifications, standards (ISO, ANSI, IEEE, ASTM, NIST), empirical test data, or peer-reviewed technical literature. Manufacturer specs are HIGH only if independently verified.",
    sourceExpectation:
      "Cite standard number, specification document, or test methodology for HIGH claims. Theoretical derivations are INFERRED if not empirically validated.",
    highRequires:
      "Specification, standard, or empirically measured result. Theoretical claims without test validation are INFERRED.",
    cautionNote:
      "Safety-critical claims require conservative confidence. Failure modes, tolerances, and edge cases must be noted. Do not omit material limits.",
    adversarialFraming:
      "Challenge: What failure mode, tolerance stack, environmental condition, or edge case would invalidate this? Does this hold outside nominal operating parameters?",
  },
  scientific: {
    label: "Scientific / Research",
    evidenceStandard:
      "Peer-reviewed, published research with replication record. Preprints are INFERRED. Single studies are INFERRED unless independently replicated. Scientific consensus is HIGH.",
    sourceExpectation:
      "Cite publication (DOI, journal, year) for HIGH claims. Distinguish between consensus, emerging evidence, and contested findings.",
    highRequires:
      "Replicated finding or scientific consensus. A single study, even high-quality, is INFERRED unless reproduced.",
    cautionNote:
      "Distinguish empirical findings from theoretical models. Note sample size, methodology limitations, and replication status. Emerging fields carry higher uncertainty.",
    adversarialFraming:
      "Challenge: Has this been independently replicated? What methodological limitations could undermine it? Is this consensus or an outlier finding?",
  },
  financial: {
    label: "Financial",
    evidenceStandard:
      "Audited financial statements, regulatory filings (SEC, EDGAR), official market data, or peer-reviewed economic research. Analyst estimates and forecasts are INFERRED.",
    sourceExpectation:
      "Cite filing (e.g. 10-K, 10-Q), data source (Bloomberg, FRED, official statistics), or research paper for HIGH claims. Projections are always INFERRED.",
    highRequires:
      "Verifiable historical data from official filings or established data sources. Forward-looking claims are INFERRED at best.",
    cautionNote:
      "Past performance does not guarantee future results. This is not financial advice. Distinguish between historical fact, current data, and forecasts explicitly.",
    adversarialFraming:
      "Challenge: What market conditions, assumptions, or time horizons would invalidate this? Is this based on historical data, current data, or a projection?",
  },
  historical: {
    label: "Historical",
    evidenceStandard:
      "Primary sources (contemporaneous documents, records, artifacts), scholarly secondary sources, or established historiographical consensus. Popular histories are INFERRED.",
    sourceExpectation:
      "Cite primary source, archive, or scholarly work (author, year) for HIGH claims. Distinguish between documented fact and historical interpretation.",
    highRequires:
      "Primary source documentation or strong scholarly consensus. Interpretive claims are INFERRED even with evidence.",
    cautionNote:
      "Distinguish between documented events and historical interpretation. Note when sources conflict, when evidence is sparse, or when the historical record is contested.",
    adversarialFraming:
      "Challenge: Do primary sources support this, or is it a later interpretation? Are there conflicting accounts or revisionist scholarship that challenges this?",
  },
  civic: {
    label: "Civic / Political Science",
    evidenceStandard:
      "Official government records, peer-reviewed political science research, verified primary sources, or electoral/census data from official bodies. Opinion polling is INFERRED.",
    sourceExpectation:
      "Cite official record (legislation, court ruling, census), verified data source, or peer-reviewed research for HIGH claims. Policy positions and interpretations are INFERRED.",
    highRequires:
      "Official primary source or peer-reviewed political science research. Normative claims (what should happen) are never HIGH — only descriptive claims can be.",
    cautionNote:
      "Distinguish empirical claims (what is) from normative claims (what should be). Note partisan framing. Electoral predictions and polling are INFERRED. Contested interpretations must be surfaced.",
    adversarialFraming:
      "Challenge: Is this an empirical claim or a normative one? What does the opposing political or academic interpretation say? Are there conflicting official records?",
  },
  general: {
    label: "General",
    evidenceStandard:
      "Verifiable, sourced information from credible primary or secondary sources. Anecdote, hearsay, and unverified claims are INFERRED or UNCERTAIN.",
    sourceExpectation:
      "Name a verifiable source for HIGH claims. If no source can be named, mark as INFERRED.",
    highRequires:
      "Well-established, directly verifiable claim with a nameable source.",
    cautionNote: "",
    adversarialFraming:
      "Challenge: What would have to be true for this to be wrong? What evidence would falsify it?",
  },
};

function resolveDomain(raw?: string): DomainConfig {
  if (!raw) return DOMAIN_REGISTRY.general;
  const key = raw.toLowerCase().trim();
  // Exact match
  if (DOMAIN_REGISTRY[key]) return DOMAIN_REGISTRY[key];
  // Fuzzy match
  for (const [k, v] of Object.entries(DOMAIN_REGISTRY)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  // Unknown domain — use general but surface the label
  return { ...DOMAIN_REGISTRY.general, label: raw };
}

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

const DOMAIN_ENUM = z.enum([
  "medical", "legal", "engineering", "scientific",
  "financial", "historical", "civic", "general",
]);

const HrpRespondInput = z.object({
  query: z.string().describe("The question or prompt to respond to"),
  domain: z.string().optional().describe(
    "Domain context for calibrated evidence standards. Known domains: medical, legal, engineering, scientific, financial, historical, civic. Leave blank for general."
  ),
  depth: z.enum(["standard", "deep"]).default("standard"),
});

const HrpCheckInput = z.object({
  response_text: z.string().describe("The response text to audit against the protocol"),
  domain: z.string().optional().describe(
    "Domain context used when the original response was generated. Calibrates what counts as a violation."
  ),
});

const HrpAdversarialInput = z.object({
  claim: z.string().describe("The claim to challenge"),
  depth: z.enum(["single", "double"]).default("single")
    .describe("single: one reversal pass. double: assume counterargument also fails."),
  domain: z.string().optional().describe(
    "Domain context for calibrated adversarial framing (e.g. medical, legal, engineering)."
  ),
});

const HrpEvidenceInput = z.object({
  conclusion: z.string().describe("The conclusion requiring evidence before it can be stated"),
});

// ─── Protocol Engine ──────────────────────────────────────────────────────────

function buildRespondPrompt(query: string, domain?: string, depth?: string): string {
  const cfg = resolveDomain(domain);
  const deepNote = depth === "deep"
    ? "\nDepth: DEEP — apply double adversarial pass. Assume the counterargument also fails. Report what, if anything, still stands."
    : "";

  const cautionBlock = cfg.cautionNote
    ? `\nDomain caution: ${cfg.cautionNote}`
    : "";

  return `You must follow the Honest Response Protocol strictly.
Domain: ${cfg.label}${deepNote}${cautionBlock}

STEP 1 — EVIDENCE FIRST
List all evidence supporting your answer BEFORE stating any conclusion.
Evidence standard for this domain: ${cfg.evidenceStandard}
If you cannot produce supporting evidence that meets this standard, set blank: true and provide blank_reason. Stop.

STEP 2 — SOURCE OR FLAG
For every factual claim: ${cfg.sourceExpectation}
No unmarked assertions permitted.

STEP 3 — CONFIDENCE TAGGING
Tag every claim:
- HIGH: ${cfg.highRequires}
- INFERRED: logical inference from known facts, or below the HIGH threshold for this domain
- UNCERTAIN: low confidence, conflicting information, or knowledge gap
- BLANK: insufficient basis to answer — return this with a reason, nothing else

STEP 4 — ADVERSARIAL SELF-CHECK
${cfg.adversarialFraming}
State challenges under countercheck.challenges.
Does your answer survive? Set survives: true/false.
If it survives partially, state the surviving kernel in residual.

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

function buildCheckPrompt(responseText: string, domain?: string): string {
  const cfg = resolveDomain(domain);
  const domainLine = domain
    ? `Domain context: ${cfg.label}. Evidence standard: ${cfg.evidenceStandard}`
    : "No domain specified — apply general evidence standards.";

  return `Audit the following response against the Honest Response Protocol.
${domainLine}

Check for:
1. MISSING_CONFIDENCE_TAG — claims that lack [HIGH], [INFERRED], [UNCERTAIN], or [BLANK] tags
2. UNMARKED_ASSERTION — factual claims with no source and no [INFERRED] marker; for this domain: ${cfg.sourceExpectation}
3. NO_EVIDENCE — conclusion stated without preceding evidence meeting the domain standard
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

function buildAdversarialPrompt(claim: string, depth: string, domain?: string): string {
  const cfg = resolveDomain(domain);
  const doublePass = depth === "double"
    ? "\nThen: assume your counterargument is ALSO wrong. What part of the original claim, if any, still stands? Set residual to that surviving kernel, or null if nothing survives."
    : "";

  return `Apply an adversarial reversal test to the following claim.
Domain: ${cfg.label}

Claim: "${claim}"

${cfg.adversarialFraming}
Generate 2–4 concrete, domain-specific challenges. Not "it could be wrong" — state exactly what conditions, evidence, or counterexamples would falsify it.${doublePass}

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
        "Wraps a query in the full Honest Response Protocol: evidence-first reasoning, domain-calibrated confidence tagging, source-or-flag attribution, and adversarial self-check. Evidence standards, source expectations, and adversarial framing adapt to the specified domain. Use for any substantive factual or analytical query where epistemic discipline matters.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The question or prompt to respond to" },
          domain: {
            type: "string",
            description: "Domain context — calibrates evidence standards, source expectations, and adversarial framing. Known domains: medical, legal, engineering, scientific, financial, historical, civic. Any other value uses general standards.",
          },
          depth: { type: "string", enum: ["standard", "deep"], default: "standard" },
        },
        required: ["query"],
      },
    },
    {
      name: "hrp_check",
      description:
        "Audits an existing response for protocol violations: missing confidence tags, unmarked assertions, missing evidence, missing countercheck. Applies domain-calibrated evidence standards when domain is provided. Returns violation list and confidence distribution. Use as a fallback when a response was generated without hrp_respond.",
      inputSchema: {
        type: "object",
        properties: {
          response_text: { type: "string", description: "The response text to audit" },
          domain: { type: "string", description: "Domain context used when the original response was generated (e.g. medical, legal, engineering, scientific, financial, historical, civic)" },
        },
        required: ["response_text"],
      },
    },
    {
      name: "hrp_adversarial",
      description:
        "Runs a domain-calibrated adversarial reversal test on a single claim. Produces concrete, domain-specific falsification conditions and assesses whether the claim survives. Use when you need to stress-test a specific conclusion without running the full protocol.",
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
          domain: {
            type: "string",
            description: "Domain context for calibrated adversarial framing (e.g. medical, legal, engineering, scientific, financial, historical, civic).",
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
        const resolvedDomain = resolveDomain(input.domain).label;
        // Record turn with no validation yet — validation happens when response comes back via hrp_check
        session.record("hrp_respond", input.query, null, false);
        return {
          content: [{ type: "text", text: prompt }],
          _meta: { protocol: "hrp", tool: "respond", version: "0.1.0", domain: resolvedDomain },
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
            text: JSON.stringify({
              ...validation,
              domain: resolveDomain(input.domain).label,
              session_trend: trend,
            }, null, 2),
          }],
          _meta: { protocol: "hrp", tool: "check", version: "0.1.0" },
        };
      }

      case "hrp_adversarial": {
        const input = HrpAdversarialInput.parse(args);
        const prompt = buildAdversarialPrompt(input.claim, input.depth, input.domain);
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