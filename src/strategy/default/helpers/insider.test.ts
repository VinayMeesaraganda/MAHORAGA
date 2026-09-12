import { describe, expect, it } from "vitest";
import { buildClusters, type InsiderTransaction, isSeniorOfficer, MIN_CLUSTER_USD, parseForm4 } from "./insider";

const now = Date.parse("2026-09-12T14:00:00Z");
const DAY = 86_400_000;

/** Minimal Form 4 shaped like the real filings, which are rigidly structured. */
function form4(o: {
  symbol?: string;
  name?: string;
  officer?: boolean;
  director?: boolean;
  title?: string;
  code?: string;
  shares?: number;
  price?: number;
  ad?: string;
}) {
  return `<ownershipDocument>
    <issuer><issuerTradingSymbol>${o.symbol ?? "ACME"}</issuerTradingSymbol></issuer>
    <reportingOwner>
      <reportingOwnerId><rptOwnerName>${o.name ?? "SMITH JANE"}</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship>
        <isDirector>${o.director ? "1" : "0"}</isDirector>
        <isOfficer>${o.officer ? "1" : "0"}</isOfficer>
        ${o.title ? `<officerTitle>${o.title}</officerTitle>` : ""}
      </reportingOwnerRelationship>
    </reportingOwner>
    <nonDerivativeTable><nonDerivativeTransaction>
      <transactionAmounts>
        <transactionShares><value>${o.shares ?? 10000}</value></transactionShares>
        <transactionPricePerShare><value>${o.price ?? 20}</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>${o.ad ?? "A"}</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <transactionCoding><transactionCode>${o.code ?? "P"}</transactionCode></transactionCoding>
    </nonDerivativeTransaction></nonDerivativeTable>
  </ownershipDocument>`;
}

describe("parseForm4", () => {
  it("extracts an open-market purchase with its value", () => {
    const [t] = parseForm4(form4({ shares: 5000, price: 12.5 }), now);
    expect(t?.symbol).toBe("ACME");
    expect(t?.shares).toBe(5000);
    expect(t?.value_usd).toBe(62_500);
  });

  it("keeps only code P — the rest is compensation, not conviction", () => {
    // M is an option exercise and A is a grant. Both dominate Form 4 volume and
    // neither says anything about what the insider thinks the stock is worth.
    expect(parseForm4(form4({ code: "M" }), now)).toHaveLength(0);
    expect(parseForm4(form4({ code: "A" }), now)).toHaveLength(0);
    expect(parseForm4(form4({ code: "S", ad: "D" }), now)).toHaveLength(0);
    expect(parseForm4(form4({ code: "P" }), now)).toHaveLength(1);
  });

  it("rejects a purchase code marked as a disposal", () => {
    // Both fields must agree; a P marked disposed is a data error.
    expect(parseForm4(form4({ code: "P", ad: "D" }), now)).toHaveLength(0);
  });

  it("records officer status and title for weighting", () => {
    const [t] = parseForm4(form4({ officer: true, title: "Chief Executive Officer" }), now);
    expect(t?.is_officer).toBe(true);
    expect(isSeniorOfficer(t!)).toBe(true);
    const [d] = parseForm4(form4({ director: true, title: "" }), now);
    expect(isSeniorOfficer(d!)).toBe(false);
  });

  it("returns nothing for malformed input or an unresolvable ticker", () => {
    expect(parseForm4("", now)).toEqual([]);
    expect(parseForm4("<ownershipDocument></ownershipDocument>", now)).toEqual([]);
    expect(parseForm4(form4({ symbol: "" }), now)).toEqual([]);
    expect(parseForm4(form4({ shares: 0 }), now)).toEqual([]);
  });
});

describe("buildClusters", () => {
  const tx = (o: Partial<InsiderTransaction>): InsiderTransaction => ({
    symbol: "ACME",
    insider: "SMITH JANE",
    title: null,
    is_officer: false,
    is_director: true,
    shares: 5000,
    price: 20,
    value_usd: 100_000,
    filed_at: now - DAY,
    ...o,
  });

  it("grades several buyers including an officer as high", () => {
    const [c] = buildClusters(
      [tx({ insider: "SMITH JANE", is_officer: true, title: "Chief Financial Officer" }), tx({ insider: "JONES BOB" })],
      7 * DAY,
      now
    );
    expect(c?.quality).toBe("high");
    expect(c?.insiders).toBe(2);
    expect(c?.total_usd).toBe(200_000);
  });

  it("counts distinct people, not filings", () => {
    // One person filing three times in a day is one buyer. Counting filings
    // would manufacture clusters out of paperwork.
    const [c] = buildClusters([tx({}), tx({}), tx({})], 7 * DAY, now);
    expect(c?.insiders).toBe(1);
    expect(c?.quality).toBe("low");
  });

  it("promotes a lone senior officer above a lone director", () => {
    const [officer] = buildClusters([tx({ is_officer: true, title: "President" })], 7 * DAY, now);
    expect(officer?.quality).toBe("medium");
    const [director] = buildClusters([tx({})], 7 * DAY, now);
    expect(director?.quality).toBe("low");
  });

  it("discards gestures below the dollar floor", () => {
    expect(buildClusters([tx({ value_usd: MIN_CLUSTER_USD - 1 })], 7 * DAY, now)).toEqual([]);
  });

  it("excludes transactions outside the window or dated in the future", () => {
    expect(buildClusters([tx({ filed_at: now - 30 * DAY })], 7 * DAY, now)).toEqual([]);
    expect(buildClusters([tx({ filed_at: now + DAY })], 7 * DAY, now)).toEqual([]);
  });

  it("ranks issuers by dollars committed", () => {
    const c = buildClusters(
      [tx({ symbol: "SMALL", value_usd: 60_000 }), tx({ symbol: "BIG", value_usd: 900_000 })],
      7 * DAY,
      now
    );
    expect(c.map((x) => x.symbol)).toEqual(["BIG", "SMALL"]);
  });
});
