import type { CandidateInput } from "./rules";

export function candidate(): CandidateInput {
  const released = "2026-09-10T20:15:00.000Z",
    at = "2026-09-14T14:05:00.000Z";
  const evidence = (published = released) => ({
    source_url: "https://issuer.example/earnings",
    content_hash: "a".repeat(64),
    excerpt: "source-backed value",
    published_at: published,
    first_observed_at: published,
  });
  const metric = (value: number, published = released) => ({
    value,
    period: "2026Q3",
    basis: "adjusted_diluted",
    currency: "USD",
    unit: "per_share" as const,
    evidence: evidence(published),
  });
  const sessions = [];
  for (let n = 0; n < 65; n++) {
    const day = new Date(Date.parse("2026-08-01T12:00:00Z") + n * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    if ([0, 6].includes(day.getUTCDay()) || date === "2026-09-07") continue;
    sessions.push({ date, open: `${date}T13:30:00.000Z`, close: `${date}T20:00:00.000Z` });
  }
  const bars = sessions
    .filter((s) => s.date <= "2026-09-11")
    .slice(-21)
    .map((s) => ({
      date: s.date,
      open: 101,
      high: 102,
      low: 100,
      close: 101,
      volume: 1_000_000,
      dollars: 101_000_000,
      feed: "sip" as const,
      session: "regular" as const,
      available_at: s.close,
    }));
  Object.assign(bars.at(-1)!, { high: 104, close: 103 });
  return {
    at,
    event: {
      event_key: "issuer:2026Q3",
      version: "1",
      issuer_id: "issuer",
      symbol: "TEST",
      fiscal_period: "2026Q3",
      released_at: released,
      actual_eps: metric(2),
      consensus_eps: metric(1.8, "2026-09-09T20:00:00.000Z"),
      consensus_snapshot_at: "2026-09-09T20:00:00.000Z",
      actual_revenue: { ...metric(1000), basis: "GAAP", unit: "millions" },
      consensus_revenue: null,
      previous_guidance: {
        low: 4000,
        high: 4200,
        period: "2026FY",
        basis: "GAAP",
        currency: "USD",
        unit: "millions",
        evidence: evidence("2026-08-01T00:00:00.000Z"),
      },
      new_guidance: {
        low: 4400,
        high: 4600,
        period: "2026FY",
        basis: "GAAP",
        currency: "USD",
        unit: "millions",
        evidence: evidence(),
      },
      guidance_metric: "revenue",
      extraction_version: "operator-v1",
      model_version: null,
      review: {
        state: "verified",
        method: "operator",
        reason: "Release compared with prior release",
        evidence: [evidence()],
        reviewed_at: "2026-09-11T10:00:00.000Z",
      },
    },
    sessions,
    bars,
    asset: { type: "common_stock", active: true, tradable: true, exchange: "NASDAQ", sector: "Technology" },
    quote: { bid: 103, ask: 103.01, bid_size: 100, ask_size: 100, at, feed: "iex" },
    calendar: {
      checked_at: "2026-09-14T10:00:00.000Z",
      from: "2026-09-14T00:00:00.000Z",
      through: "2026-09-15T00:00:00.000Z",
      complete: true,
      sources: ["https://www.bls.gov/schedule/", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"],
      events: [],
    },
    news: { complete: true, from: released, through: at },
    optional_features: { fcf: null, relative_volume: null },
  };
}
