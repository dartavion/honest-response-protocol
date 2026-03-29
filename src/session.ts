import { readFileSync, appendFileSync, writeFileSync } from "fs";
import type { ValidationResult, ViolationType } from "./validator.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TurnRecord {
  turn: number;
  timestamp: string;
  tool: string;
  query: string;
  validation: ValidationResult | null;
  blank: boolean;
}

export interface SessionSummary {
  session_id: string;
  started: string;
  turns: number;
  total_violations: number;
  violation_breakdown: Record<ViolationType, number>;
  blank_rate: number;
  confidence_totals: Record<string, number>;
  health: "CLEAN" | "DEGRADED" | "COMPROMISED";
  health_reason: string | null;
}

// ─── Session Store ────────────────────────────────────────────────────────────

export class SessionLogger {
  private sessionId: string;
  private started: string;
  private turns: TurnRecord[] = [];
  private persistPath: string | null;

  constructor(sessionId?: string, persistPath?: string) {
    this.sessionId = sessionId ?? `hrp-${Date.now()}`;
    this.started = new Date().toISOString();
    this.persistPath = persistPath ?? null;
    if (this.persistPath) this.replay();
  }

  private replay(): void {
    try {
      const lines = readFileSync(this.persistPath!, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          this.turns.push(JSON.parse(line) as TurnRecord);
        } catch {
          // skip malformed lines
        }
      }
      if (this.turns.length > 0) {
        this.started = this.turns[0].timestamp;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // ─── Record a turn ──────────────────────────────────────────────────────────

  record(tool: string, query: string, validation: ValidationResult | null, blank = false): TurnRecord {
    const record: TurnRecord = {
      turn: this.turns.length + 1,
      timestamp: new Date().toISOString(),
      tool,
      query: query.slice(0, 200), // truncate for storage
      validation,
      blank,
    };
    this.turns.push(record);
    if (this.persistPath) {
      appendFileSync(this.persistPath, JSON.stringify(record) + "\n", "utf-8");
    }
    return record;
  }

  // ─── Session Summary ────────────────────────────────────────────────────────

  summary(): SessionSummary {
    const violationBreakdown: Record<string, number> = {};
    const confidenceTotals: Record<string, number> = {
      HIGH: 0, INFERRED: 0, UNCERTAIN: 0, BLANK: 0, UNTAGGED: 0,
    };

    let totalViolations = 0;
    let blankCount = 0;

    for (const turn of this.turns) {
      if (turn.blank) blankCount++;

      if (turn.validation) {
        totalViolations += turn.validation.violations.length;

        for (const v of turn.validation.violations) {
          violationBreakdown[v.type] = (violationBreakdown[v.type] || 0) + 1;
        }

        for (const [key, count] of Object.entries(turn.validation.confidence_distribution)) {
          confidenceTotals[key] = (confidenceTotals[key] || 0) + count;
        }
      }
    }

    const health = this.assessHealth(totalViolations, blankCount);

    return {
      session_id: this.sessionId,
      started: this.started,
      turns: this.turns.length,
      total_violations: totalViolations,
      violation_breakdown: violationBreakdown as Record<ViolationType, number>,
      blank_rate: this.turns.length > 0 ? blankCount / this.turns.length : 0,
      confidence_totals: confidenceTotals,
      health: health.status,
      health_reason: health.reason,
    };
  }

  // ─── Health Assessment ──────────────────────────────────────────────────────

  private assessHealth(totalViolations: number, blankCount: number): {
    status: "CLEAN" | "DEGRADED" | "COMPROMISED";
    reason: string | null;
  } {
    if (this.turns.length === 0) {
      return { status: "CLEAN", reason: null };
    }

    const violationRate = totalViolations / this.turns.length;
    const errorViolations = this.turns
      .flatMap(t => t.validation?.violations ?? [])
      .filter(v => v.severity === "ERROR").length;

    if (errorViolations >= 3) {
      return {
        status: "COMPROMISED",
        reason: `${errorViolations} ERROR-level violations detected. Responses are structurally non-conformant.`,
      };
    }

    if (violationRate > 1.5) {
      return {
        status: "DEGRADED",
        reason: `${violationRate.toFixed(1)} average violations per turn. Consider reinforcing the system prompt.`,
      };
    }

    return { status: "CLEAN", reason: null };
  }

  // ─── Turn History ───────────────────────────────────────────────────────────

  history(): TurnRecord[] {
    return [...this.turns];
  }

  // ─── Last Turn ──────────────────────────────────────────────────────────────

  last(): TurnRecord | null {
    return this.turns[this.turns.length - 1] ?? null;
  }

  // ─── Violation Trend ────────────────────────────────────────────────────────
  // Returns true if violations are increasing across the last N turns

  violationTrend(window = 3): "IMPROVING" | "STABLE" | "WORSENING" {
    if (this.turns.length < window * 2) return "STABLE";

    const recent = this.turns.slice(-window);
    const prior = this.turns.slice(-window * 2, -window);

    const recentAvg = recent.reduce((sum, t) => sum + (t.validation?.violations.length ?? 0), 0) / window;
    const priorAvg = prior.reduce((sum, t) => sum + (t.validation?.violations.length ?? 0), 0) / window;

    if (recentAvg > priorAvg + 0.5) return "WORSENING";
    if (recentAvg < priorAvg - 0.5) return "IMPROVING";
    return "STABLE";
  }

  // ─── Reset ──────────────────────────────────────────────────────────────────

  reset(): void {
    this.turns = [];
    this.started = new Date().toISOString();
    if (this.persistPath) {
      writeFileSync(this.persistPath, "", "utf-8");
    }
  }

  getId(): string {
    return this.sessionId;
  }
}

// ─── Singleton session (one per server process) ───────────────────────────────

export const session = new SessionLogger();