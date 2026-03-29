import { describe, it, expect, beforeEach } from "vitest";
import { SessionLogger } from "../src/session.js";
import type { ValidationResult } from "../src/validator.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeValidation(
  errorCount = 0,
  warningCount = 0,
  distribution: Record<string, number> = {}
): ValidationResult {
  const violations = [
    ...Array.from({ length: errorCount }, (_, i) => ({
      type: "NO_EVIDENCE" as const,
      location: `location-${i}`,
      suggestion: "add evidence",
      severity: "ERROR" as const,
    })),
    ...Array.from({ length: warningCount }, (_, i) => ({
      type: "UNMARKED_ASSERTION" as const,
      location: `warning-${i}`,
      suggestion: "add source",
      severity: "WARNING" as const,
    })),
  ];
  return {
    valid: errorCount === 0,
    violations,
    confidence_distribution: {
      HIGH: 0, INFERRED: 0, UNCERTAIN: 0, BLANK: 0, UNTAGGED: 0,
      ...distribution,
    },
    parse_error: null,
  };
}

// ─── SessionLogger ────────────────────────────────────────────────────────────

describe("SessionLogger", () => {
  let logger: SessionLogger;

  beforeEach(() => {
    logger = new SessionLogger("test-session");
  });

  // ─── Construction ───────────────────────────────────────────────────────────

  it("accepts an explicit session ID", () => {
    expect(logger.getId()).toBe("test-session");
  });

  it("generates an ID when none is provided", () => {
    const auto = new SessionLogger();
    expect(auto.getId()).toMatch(/^hrp-\d+$/);
  });

  // ─── record() ───────────────────────────────────────────────────────────────

  it("records a turn and returns the TurnRecord", () => {
    const record = logger.record("hrp_respond", "What is X?", null);
    expect(record.turn).toBe(1);
    expect(record.tool).toBe("hrp_respond");
    expect(record.query).toBe("What is X?");
    expect(record.blank).toBe(false);
    expect(record.validation).toBeNull();
  });

  it("increments turn numbers sequentially", () => {
    const r1 = logger.record("hrp_respond", "Q1", null);
    const r2 = logger.record("hrp_check", "Q2", null);
    const r3 = logger.record("hrp_adversarial", "Q3", null);
    expect(r1.turn).toBe(1);
    expect(r2.turn).toBe(2);
    expect(r3.turn).toBe(3);
  });

  it("truncates queries longer than 200 characters", () => {
    const long = "a".repeat(300);
    const record = logger.record("hrp_respond", long, null);
    expect(record.query.length).toBe(200);
  });

  it("records blank flag correctly", () => {
    const record = logger.record("hrp_respond", "Q", null, true);
    expect(record.blank).toBe(true);
  });

  it("stores a timestamp as ISO string", () => {
    const record = logger.record("hrp_respond", "Q", null);
    expect(() => new Date(record.timestamp)).not.toThrow();
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ─── summary() ──────────────────────────────────────────────────────────────

  it("returns CLEAN health and zero counts for empty session", () => {
    const s = logger.summary();
    expect(s.turns).toBe(0);
    expect(s.total_violations).toBe(0);
    expect(s.blank_rate).toBe(0);
    expect(s.health).toBe("CLEAN");
    expect(s.health_reason).toBeNull();
  });

  it("aggregates total violations across turns", () => {
    logger.record("hrp_respond", "Q1", makeValidation(1, 2));
    logger.record("hrp_respond", "Q2", makeValidation(0, 1));
    const s = logger.summary();
    expect(s.total_violations).toBe(4); // 3 + 1
  });

  it("builds violation_breakdown by type", () => {
    logger.record("hrp_respond", "Q1", makeValidation(2, 0)); // 2 NO_EVIDENCE errors
    logger.record("hrp_respond", "Q2", makeValidation(0, 1)); // 1 UNMARKED_ASSERTION warning
    const s = logger.summary();
    expect(s.violation_breakdown.NO_EVIDENCE).toBe(2);
    expect(s.violation_breakdown.UNMARKED_ASSERTION).toBe(1);
  });

  it("sums confidence_totals across turns", () => {
    logger.record("hrp_respond", "Q1", makeValidation(0, 0, { HIGH: 2, INFERRED: 1 }));
    logger.record("hrp_respond", "Q2", makeValidation(0, 0, { HIGH: 1, UNCERTAIN: 3 }));
    const s = logger.summary();
    expect(s.confidence_totals.HIGH).toBe(3);
    expect(s.confidence_totals.INFERRED).toBe(1);
    expect(s.confidence_totals.UNCERTAIN).toBe(3);
  });

  it("computes blank_rate correctly", () => {
    logger.record("hrp_respond", "Q1", null, true);
    logger.record("hrp_respond", "Q2", null, false);
    logger.record("hrp_respond", "Q3", null, true);
    const s = logger.summary();
    expect(s.blank_rate).toBeCloseTo(2 / 3);
  });

  it("includes session_id and started in summary", () => {
    const s = logger.summary();
    expect(s.session_id).toBe("test-session");
    expect(s.started).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips turns with null validation in aggregation", () => {
    logger.record("hrp_respond", "Q1", null);
    logger.record("hrp_respond", "Q2", makeValidation(1, 0));
    const s = logger.summary();
    expect(s.total_violations).toBe(1);
  });

  // ─── Health: CLEAN ──────────────────────────────────────────────────────────

  it("reports CLEAN when violations are infrequent and errors < 3", () => {
    logger.record("hrp_respond", "Q1", makeValidation(0, 1));
    logger.record("hrp_respond", "Q2", makeValidation(0, 0));
    const s = logger.summary();
    expect(s.health).toBe("CLEAN");
    expect(s.health_reason).toBeNull();
  });

  // ─── Health: DEGRADED ───────────────────────────────────────────────────────

  it("reports DEGRADED when violation rate > 1.5 and error count < 3", () => {
    // 2 turns, each with 2 WARNING violations → rate = 2.0 > 1.5, errors = 0
    logger.record("hrp_respond", "Q1", makeValidation(0, 2));
    logger.record("hrp_respond", "Q2", makeValidation(0, 2));
    const s = logger.summary();
    expect(s.health).toBe("DEGRADED");
    expect(s.health_reason).not.toBeNull();
  });

  it("includes violation rate in DEGRADED health_reason", () => {
    logger.record("hrp_respond", "Q1", makeValidation(0, 2));
    logger.record("hrp_respond", "Q2", makeValidation(0, 2));
    const s = logger.summary();
    expect(s.health_reason).toMatch(/violation/i);
  });

  // ─── Health: COMPROMISED ────────────────────────────────────────────────────

  it("reports COMPROMISED when ERROR-level violations reach 3", () => {
    // 3 turns each with 1 ERROR → errorViolations = 3
    logger.record("hrp_respond", "Q1", makeValidation(1, 0));
    logger.record("hrp_respond", "Q2", makeValidation(1, 0));
    logger.record("hrp_respond", "Q3", makeValidation(1, 0));
    const s = logger.summary();
    expect(s.health).toBe("COMPROMISED");
    expect(s.health_reason).toMatch(/ERROR/);
  });

  it("COMPROMISED takes priority over DEGRADED rate check", () => {
    // Each turn: 1 error + 3 warnings → errorViolations=3, rate=4 > 1.5
    logger.record("hrp_respond", "Q1", makeValidation(1, 3));
    logger.record("hrp_respond", "Q2", makeValidation(1, 3));
    logger.record("hrp_respond", "Q3", makeValidation(1, 3));
    const s = logger.summary();
    expect(s.health).toBe("COMPROMISED");
  });

  // ─── violationTrend() ───────────────────────────────────────────────────────

  it("returns STABLE when fewer than 6 turns (default window=3)", () => {
    logger.record("hrp_respond", "Q", makeValidation(1, 0));
    logger.record("hrp_respond", "Q", makeValidation(1, 0));
    expect(logger.violationTrend()).toBe("STABLE");
  });

  it("returns STABLE when recent and prior averages are within 0.5", () => {
    for (let i = 0; i < 6; i++) {
      logger.record("hrp_respond", "Q", makeValidation(1, 0)); // 1 violation each
    }
    expect(logger.violationTrend()).toBe("STABLE");
  });

  it("returns WORSENING when recent violations clearly exceed prior", () => {
    // prior 3 turns: 0 violations each
    for (let i = 0; i < 3; i++) {
      logger.record("hrp_respond", "Q", makeValidation(0, 0));
    }
    // recent 3 turns: 2 violations each → recentAvg=2 > priorAvg+0.5
    for (let i = 0; i < 3; i++) {
      logger.record("hrp_respond", "Q", makeValidation(0, 2));
    }
    expect(logger.violationTrend()).toBe("WORSENING");
  });

  it("returns IMPROVING when recent violations clearly below prior", () => {
    // prior 3 turns: 2 violations each
    for (let i = 0; i < 3; i++) {
      logger.record("hrp_respond", "Q", makeValidation(0, 2));
    }
    // recent 3 turns: 0 violations each → recentAvg=0 < priorAvg-0.5
    for (let i = 0; i < 3; i++) {
      logger.record("hrp_respond", "Q", makeValidation(0, 0));
    }
    expect(logger.violationTrend()).toBe("IMPROVING");
  });

  it("respects custom window size", () => {
    // Need window*2 = 4 turns for window=2
    logger.record("hrp_respond", "Q", makeValidation(0, 2)); // prior
    logger.record("hrp_respond", "Q", makeValidation(0, 2)); // prior
    logger.record("hrp_respond", "Q", makeValidation(0, 0)); // recent
    logger.record("hrp_respond", "Q", makeValidation(0, 0)); // recent
    expect(logger.violationTrend(2)).toBe("IMPROVING");
  });

  // ─── history() ──────────────────────────────────────────────────────────────

  it("returns a copy of all recorded turns", () => {
    logger.record("hrp_respond", "Q1", null);
    logger.record("hrp_check", "Q2", null);
    const h = logger.history();
    expect(h).toHaveLength(2);
    expect(h[0].tool).toBe("hrp_respond");
    expect(h[1].tool).toBe("hrp_check");
  });

  it("history() returns a copy, not the internal array", () => {
    logger.record("hrp_respond", "Q", null);
    const h = logger.history();
    h.push({} as never);
    expect(logger.history()).toHaveLength(1);
  });

  // ─── last() ─────────────────────────────────────────────────────────────────

  it("returns null when no turns recorded", () => {
    expect(logger.last()).toBeNull();
  });

  it("returns the most recently recorded turn", () => {
    logger.record("hrp_respond", "Q1", null);
    logger.record("hrp_check", "Q2", null);
    expect(logger.last()!.tool).toBe("hrp_check");
    expect(logger.last()!.turn).toBe(2);
  });

  // ─── reset() ────────────────────────────────────────────────────────────────

  it("clears all turns on reset", () => {
    logger.record("hrp_respond", "Q", null);
    logger.record("hrp_respond", "Q", null);
    logger.reset();
    expect(logger.history()).toHaveLength(0);
    expect(logger.last()).toBeNull();
  });

  it("resets turn counter so next record starts at 1", () => {
    logger.record("hrp_respond", "Q", null);
    logger.reset();
    const r = logger.record("hrp_respond", "Q2", null);
    expect(r.turn).toBe(1);
  });

  it("summary after reset reports CLEAN with zero counts", () => {
    logger.record("hrp_respond", "Q", makeValidation(1, 1));
    logger.reset();
    const s = logger.summary();
    expect(s.turns).toBe(0);
    expect(s.total_violations).toBe(0);
    expect(s.health).toBe("CLEAN");
  });

  it("updates started timestamp on reset", async () => {
    const before = logger.summary().started;
    await new Promise((r) => setTimeout(r, 5));
    logger.reset();
    const after = logger.summary().started;
    expect(after).not.toBe(before);
  });
});
