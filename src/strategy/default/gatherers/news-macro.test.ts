import { describe, expect, it } from "vitest";
import { isMacroHeadline } from "./news";

describe("isMacroHeadline", () => {
  it("catches the event classes that move whole sectors", () => {
    for (const h of [
      "Fed holds rates steady, Powell signals patience",
      "FOMC minutes show divide over a rate cut",
      "CPI inflation came in hotter than expected",
      "Core PCE ticks higher in August",
      "Nonfarm payrolls miss badly; unemployment rate rises",
      "Treasury yields spike as the yield curve steepens",
      "White House announces new tariffs on imports",
      "US expands export controls, adds sanctions",
      "Missile strike escalates conflict; ceasefire talks stall",
      "OPEC signals output cut, crude jumps",
      "Government shutdown looms as debt ceiling talks fail",
      "GDP revision raises recession odds",
    ]) {
      expect(isMacroHeadline(h), h).toBe(true);
    }
  });

  it("ignores single-issuer and filler stories", () => {
    for (const h of [
      "Apple unveils new iPhone lineup",
      "Here's How Much $1000 Invested In Texas Instruments 20 Years Ago Would Be Worth",
      "Nvidia beats on earnings, guides higher",
      "Analyst upgrades Ford to buy",
      "Why This Small-Cap Biotech Is Moving Today",
    ]) {
      expect(isMacroHeadline(h), h).toBe(false);
    }
  });

  it("is case-insensitive and matches inside a sentence", () => {
    expect(isMacroHeadline("stocks fall as TREASURY YIELDS climb")).toBe(true);
    expect(isMacroHeadline("markets steady ahead of the jobs report on Friday")).toBe(true);
  });
});
