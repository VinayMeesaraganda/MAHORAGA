import { describe, expect, it } from "vitest";
import { candidate } from "./fixtures.test-helper";
import { allocate, evaluateCandidate, exitReason, type CandidateInput, type Portfolio } from "./rules";

describe("guidance-continuation point-in-time qualification", () => {
  it("qualifies a sourced EPS beat and raised guidance with unknown revenue consensus/FCF/relative volume", () => {
    const result = evaluateCandidate(candidate());
    expect(result.reasons).toEqual([]);
    expect(result.plan?.limit).toBeGreaterThan(103);
    expect(result.plan!.limit).toBeLessThanOrEqual(103.01 * 1.0005);
  });
  const cases: Array<[string, (x: CandidateInput) => void, string]> = [
    [
      "late EPS consensus",
      (x) => {
        x.event.consensus_eps!.evidence.first_observed_at = x.at;
      },
      "preannouncement_consensus_unverified",
    ],
    [
      "different EPS basis",
      (x) => {
        x.event.consensus_eps!.basis = "GAAP";
      },
      "eps_basis_unknown_or_mismatch",
    ],
    [
      "EPS miss",
      (x) => {
        x.event.actual_eps!.value = 1;
      },
      "no_eps_beat",
    ],
    [
      "guidance reiterated",
      (x) => {
        x.event.new_guidance!.low = 4000;
        x.event.new_guidance!.high = 4200;
      },
      "no_positive_guidance_revision",
    ],
    [
      "guidance different period",
      (x) => {
        x.event.new_guidance!.period = "2027FY";
      },
      "guidance_basis_unknown_or_mismatch",
    ],
    [
      "future evidence",
      (x) => {
        x.event.new_guidance!.evidence.first_observed_at = "2026-09-15T00:00:00Z";
      },
      "evidence_not_available",
    ],
    [
      "ambiguous adverse event",
      (x) => {
        x.event.review.state = "pending";
      },
      "review_pending",
    ],
    [
      "intraday release",
      (x) => {
        x.event.released_at = "2026-09-10T15:00:00Z";
      },
      "intraday_release",
    ],
    [
      "late entry",
      (x) => {
        x.at = "2026-09-14T14:10:00Z";
      },
      "outside_entry_window",
    ],
    [
      "D2 catch-up",
      (x) => {
        x.at = "2026-09-15T14:05:00Z";
      },
      "not_D1_or_calendar_gap",
    ],
    [
      "stale quote",
      (x) => {
        x.quote.at = "2026-09-14T14:04:29Z";
      },
      "quote_unusable",
    ],
    [
      "crossed quote",
      (x) => {
        x.quote.bid = 104;
      },
      "quote_unusable",
    ],
    [
      "future bar",
      (x) => {
        x.bars[0]!.available_at = "2026-09-15T00:00:00Z";
      },
      "invalid_or_future_bars",
    ],
    [
      "missing session",
      (x) => {
        x.bars[0]!.date = "2026-08-01";
      },
      "history_session_gap",
    ],
    [
      "poor liquidity",
      (x) => {
        x.bars.forEach((b) => {
          b.dollars = 1000;
        });
      },
      "insufficient_liquidity",
    ],
    [
      "weak D0 response",
      (x) => {
        x.bars.at(-1)!.close = 101;
      },
      "D0_response_failed",
    ],
    [
      "news outage",
      (x) => {
        x.news.complete = false;
      },
      "news_coverage_unknown",
    ],
    [
      "news interval gap",
      (x) => {
        x.news.from = "2026-09-14T00:00:00Z";
      },
      "news_coverage_unknown",
    ],
    [
      "calendar outage",
      (x) => {
        x.calendar.complete = false;
      },
      "calendar_coverage_unknown",
    ],
    [
      "blackout",
      (x) => {
        x.calendar.events.push({ at: "2026-09-14T14:30:00Z", kind: "cpi" });
      },
      "macro_blackout",
    ],
    [
      "chasing",
      (x) => {
        x.quote.ask = 108;
        x.quote.bid = 107.99;
      },
      "entry_chasing",
    ],
  ];
  it.each(cases)("rejects %s", (_name, change, reason) => {
    const x = candidate();
    change(x);
    expect(evaluateCandidate(x).reasons).toContain(reason);
  });
  it("handles a weekend and the Labor Day gap using supplied sessions", () => {
    expect(evaluateCandidate(candidate()).plan).not.toBeNull();
  });
  it("rejects malformed/unknown fields instead of silently stripping them", () => {
    expect(() => evaluateCandidate({ ...candidate(), confidence: 0.99 })).toThrow();
  });
});

describe("deterministic portfolio allocation", () => {
  const portfolio = (): Portfolio => ({
    equity: 100_000,
    cash: 100_000,
    peakEquity: 100_000,
    paused: false,
    allocations: [],
    attemptedEvents: [],
  });
  const plan = () => ({ ...evaluateCandidate(candidate()).plan!, limit: 100, stop: 95 });
  it("allocates whole shares at the worst permitted fill and reserves capital", () => {
    expect(allocate([plan()], portfolio())[0]?.quantity).toBe(25);
  });
  it("ranks before reserving shared sector capacity", () => {
    const plans = [0, 1, 2].map((i) => ({ ...plan(), issuer: `${i}`, eventKey: `${i}`, rank: i }));
    const result = allocate(plans, portfolio());
    expect(result.map((r) => r.plan.issuer)).toEqual(["2", "1", "0"]);
    expect(result[2]?.reason).toBe("sector_capacity");
  });
  it("includes pending positions and prevents issuer/event re-entry", () => {
    const p = portfolio();
    p.attemptedEvents = [plan().eventKey];
    expect(allocate([plan()], p)[0]?.quantity).toBe(0);
    p.attemptedEvents = [];
    p.allocations = [{ issuer: plan().issuer, sector: "Technology", value: 1000, initialRisk: 50 }];
    expect(allocate([plan()], p)[0]?.reason).toBe("duplicate_event_or_issuer");
  });
  it("keeps an experiment pause latched even after equity recovers", () => {
    const p = portfolio();
    p.paused = true;
    expect(allocate([plan()], p)[0]?.reason).toBe("experiment_paused");
  });
  it("rejects exhausted risk capacity and malformed accounts", () => {
    const p = portfolio();
    p.allocations = [{ issuer: "other", sector: "Other", value: 1000, initialRisk: 625 }];
    expect(allocate([plan()], p)[0]?.quantity).toBe(0);
    p.cash = Number.NaN;
    expect(() => allocate([plan()], p)).toThrow();
  });
});

describe("fixed protection, session horizon and verified invalidation", () => {
  const x = candidate();
  const position = { stop: 95, price: 100, enteredSession: "2026-09-01", invalidation: "pending" as const };
  it("stops without a news verdict", () => {
    expect(exitReason({ ...position, price: 94 }, x.sessions, Date.parse(x.at))).toBe("initial_stop");
  });
  it("does not let pending news authorize an exit", () => {
    expect(exitReason(position, x.sessions, Date.parse(x.at))).toBeNull();
  });
  it("exits at the tenth session's close minus five minutes, including early closes", () => {
    const sessions = structuredClone(x.sessions);
    const tenth = sessions.filter((s) => s.date >= position.enteredSession)[9]!;
    tenth.close = `${tenth.date}T17:00:00Z`;
    expect(exitReason(position, sessions, Date.parse(`${tenth.date}T16:54:59Z`))).toBeNull();
    expect(exitReason(position, sessions, Date.parse(`${tenth.date}T16:55:00Z`))).toBe("session_horizon");
  });
});
