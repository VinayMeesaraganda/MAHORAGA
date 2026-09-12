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

describe("adverse detection against a real trade that went wrong", () => {
  // From a live example: entered on a cyberattack headline assuming production
  // was unaffected; days later the company said it would miss the quarter. The
  // original pattern list only matched a literal "cuts guidance", so five of
  // seven ordinary phrasings of that same event were missed.
  const sameEventDifferentWords = [
    "Boston Scientific cuts guidance after cyberattack disrupts production",
    "Boston Scientific withdraws guidance citing cyberattack",
    "Boston Scientific says cyberattack will cause it to miss Q4 targets",
    "Boston Scientific warns fourth-quarter revenue will fall short of expectations",
    "Boston Scientific lowers full-year outlook on attack-related disruption",
    "BSX expects production shortfall to weigh on next quarter results",
    "Boston Scientific: attack to have material impact on Q4 revenue",
    "Boston Scientific confirms cybersecurity incident, says operations continuing",
  ];

  it("catches a forward guidance cut however it is worded", () => {
    for (const h of sameEventDifferentWords) {
      expect(adverseCatalystReason(h), h).toBeTruthy();
    }
  });

  it("catches the phrasings that do not use the word guidance", () => {
    expect(adverseCatalystReason("Acme lowers full-year outlook")).toBeTruthy();
    expect(adverseCatalystReason("Acme trims its revenue forecast")).toBeTruthy();
    expect(adverseCatalystReason("Acme suspends guidance")).toBeTruthy();
    expect(adverseCatalystReason("Acme warns results will be below consensus")).toBeTruthy();
    expect(adverseCatalystReason("Acme flags a production shortfall")).toBeTruthy();
  });

  it("treats a security incident as adverse for a name already held", () => {
    for (const h of [
      "Acme confirms cybersecurity incident",
      "Acme discloses ransomware attack",
      "Acme reports data breach affecting customers",
    ]) {
      expect(adverseCatalystReason(h), h).toBeTruthy();
    }
  });

  it("does not turn favourable events adverse", () => {
    // The widened patterns must not swallow the catalysts they sit beside.
    for (const [h, type] of [
      ["Acme raises full-year guidance after strong quarter", "guidance"],
      ["Nvidia tops Q3 earnings estimates", "earnings"],
      ["Palantir wins $480 million defense contract", "contract"],
      ["FDA approves Biogen therapy for rare disease", "regulatory"],
      ["XYZ agrees to acquire ABC in merger agreement", "m_and_a"],
    ] as const) {
      expect(adverseCatalystReason(h), h).toBeNull();
      expect(classifyCatalyst(h)?.type, h).toBe(type);
    }
  });
});

describe("a legal overhang clearing is not the overhang", () => {
  // From a live trade: entered after litigation was settled, on the view that
  // the threat was removed. The adverse list matched the noun "class action"
  // and would have read that entry thesis as a reason to sell.
  it("reads a settled or dismissed proceeding as favourable, not adverse", () => {
    for (const h of [
      "Meta settles antitrust class action, removing a major overhang",
      "Meta reaches settlement resolving FTC investigation",
      "Meta wins dismissal of shareholder lawsuit",
      "Judge dismisses class action against Meta",
      "Meta agrees to settle privacy litigation for $1.4 billion",
    ]) {
      expect(adverseCatalystReason(h), h).toBeNull();
      expect(classifyCatalyst(h)?.type, h).toBe("regulatory");
    }
  });

  it("still treats a proceeding being opened or widened as adverse", () => {
    for (const h of [
      "Meta faces new antitrust class action",
      "SEC opens investigation into Meta",
      "Meta hit with shareholder lawsuit over disclosures",
      "Regulators widen probe into Meta advertising practices",
    ]) {
      expect(adverseCatalystReason(h), h).toBeTruthy();
    }
  });

  it("does not let one resolution clear a separate live problem", () => {
    // Every adverse match is considered, not just the first. Otherwise a
    // settled lawsuit in the same sentence would clear a dilutive offering.
    expect(adverseCatalystReason("Acme settles lawsuit and announces dilutive secondary offering")).toMatch(/dilut/i);
    expect(adverseCatalystReason("Acme resolves probe but cuts full-year guidance")).toMatch(/guidance/i);
    expect(adverseCatalystReason("Meta settles one case but faces a new SEC investigation")).toBeTruthy();
  });

  it("confines the exemption to proceedings", () => {
    // "Settles" must not rescue events that are not pending proceedings.
    expect(adverseCatalystReason("Acme settles on a dilutive secondary offering")).toBeTruthy();
    expect(adverseCatalystReason("Acme resolves to withdraw guidance")).toBeTruthy();
  });
});
