import { describe, expect, it } from "vitest";
import { adverseCatalystReason, bestCatalyst, classifyCatalyst, meetsQuality } from "./catalyst";

describe("classifyCatalyst", () => {
  it("grades events that change forward estimates as high", () => {
    for (const [text, type] of [
      ["Acme raises full-year guidance after strong quarter", "guidance"],
      ["FDA approves Biogen therapy for rare disease", "regulatory"],
      ["Acme receives FDA approval for rare disease therapy", "regulatory"],
      ["FDA grants orphan drug designation to Acme therapy", "regulatory"],
      ["Acme granted breakthrough therapy designation", "regulatory"],
      ["Phase 3 trial meets primary endpoint", "regulatory"],
      ["Acme phase III trial reports positive topline results", "regulatory"],
      ["Palantir wins $480 million defense contract", "contract"],
      ["Nvidia tops Q3 earnings estimates", "earnings"],
    ] as const) {
      const c = classifyCatalyst(text);
      expect(c?.type, text).toBe(type);
      expect(c?.quality, text).toBe("high");
    }
  });

  it("grades capped or unproven events as medium", () => {
    expect(classifyCatalyst("XYZ agrees to acquire ABC in merger agreement")?.quality).toBe("medium");
    expect(classifyCatalyst("Company announces strategic partnership with Microsoft")?.quality).toBe("medium");
  });

  it("grades attention without fundamentals as low", () => {
    expect(classifyCatalyst("Analyst upgrades Ford to buy")?.quality).toBe("low");
    expect(classifyCatalyst("This AI play is rallying today")?.quality).toBe("low");
    expect(classifyCatalyst("High short interest sparks a short squeeze")?.quality).toBe("low");
  });

  it.each([
    "FDA approval denied for experimental drug",
    "Company did not meet primary endpoint",
    "Phase 3 trial failed to meet primary endpoint",
    "Company didn't meet primary endpoint",
    "Company didn’t meet primary endpoint",
    "FDA approval was not granted",
    "FDA denies approval after positive phase 3 results",
    "Company reports negative results after phase 3 trial met primary endpoint",
    "Company raises guidance but misses earnings expectations",
    "Company wins contract that government subsequently canceled",
    "Company no longer raises guidance",
    "Phase 3 trial did not succeed",
    "Company did not unveil product",
    "Company does not agree to acquire Acme",
    "Company did not boost guidance",
  ])("rejects adverse or negated outcomes: %s", (headline) => {
    expect(classifyCatalyst(headline)).toBeNull();
    expect(adverseCatalystReason(headline)).toBeTruthy();
  });

  it.each([
    "Company awaits PDUFA decision next week",
    "FDA approval expected next month",
    "Company could meet primary endpoint",
    "Analysts expect FDA approves therapy next week",
    "Company will raise guidance next quarter",
    "Company plans strategic partnership with Microsoft",
    "Rumored takeover of Acme",
    "Will Acme beat earnings expectations?",
    "Phase 3 topline data due tomorrow",
    "Acme PDUFA decision date set",
    "Acme seeks orphan drug designation",
    "Acme applies for FDA clearance",
    "Acme explores multi-year government contract",
    "Acme in talks over acquisition of Beta",
    "Acme receives FDA review for therapy",
    "Acme raises guidance according to unconfirmed reports",
    "Acme discusses partnership and agrees to acquire Beta in tentative deal",
  ])("does not promote anticipated or unspecified outcomes: %s", (headline) => {
    expect(classifyCatalyst(headline)).toBeNull();
  });

  it("disqualifies adverse language even alongside a genuine catalyst", () => {
    // The single most important case: a contract win announced with a raise.
    expect(classifyCatalyst("Acme wins $200M contract but announces dilutive secondary offering")).toBeNull();
    expect(classifyCatalyst("Beats earnings; CEO resigns amid SEC investigation")).toBeNull();
    expect(classifyCatalyst("Raises guidance, then withdraws guidance weeks later")).toBeNull();
  });

  it("returns null for filler and malformed input", () => {
    expect(classifyCatalyst("Here's How Much $1000 Invested In Texas Instruments Would Be Worth")).toBeNull();
    expect(classifyCatalyst("Stocks close mixed on the session")).toBeNull();
    expect(classifyCatalyst("")).toBeNull();
    expect(classifyCatalyst(undefined as unknown as string)).toBeNull();
  });

  it("prefers the higher-quality reading when a headline names two events", () => {
    const c = classifyCatalyst("Acme raises guidance; analyst upgrades to buy");
    expect(c?.type).toBe("guidance");
  });
});

describe("meetsQuality and bestCatalyst", () => {
  it("ranks quality tiers", () => {
    expect(meetsQuality("high", "medium")).toBe(true);
    expect(meetsQuality("medium", "medium")).toBe(true);
    expect(meetsQuality("low", "medium")).toBe(false);
  });

  it("picks the strongest catalyst from a set", () => {
    const hits = [
      { type: "analyst", quality: "low", matched: "upgrades" },
      { type: "guidance", quality: "high", matched: "raises guidance" },
      { type: "partnership", quality: "medium", matched: "partnership" },
    ] as const;
    expect(bestCatalyst([...hits])?.type).toBe("guidance");
    expect(bestCatalyst([])).toBeNull();
    expect(bestCatalyst(undefined)).toBeNull();
  });
});
