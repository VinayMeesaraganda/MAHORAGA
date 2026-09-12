/**
 * Catalyst classification.
 *
 * Conservative headline evidence for a catalyst-conditioned strategy hypothesis.
 * These patterns recognize reported favorable events; they do not verify the
 * source, issuer economics, event date, or profitability. Unknown, adverse and
 * anticipated events cannot qualify a long entry. Social attention is low quality.
 */

export type CatalystType =
  | "guidance"
  | "regulatory"
  | "earnings"
  | "contract"
  | "m_and_a"
  | "partnership"
  | "product"
  | "analyst"
  | "theme"
  | "squeeze";

export type CatalystQuality = "high" | "medium" | "low";

export interface CatalystHit {
  type: CatalystType;
  quality: CatalystQuality;
  /** The phrase that matched, for the log and the prompt. */
  matched: string;
}

interface Rule {
  type: CatalystType;
  quality: CatalystQuality;
  pattern: RegExp;
}

/**
 * Ordered by quality: a headline naming both a guidance raise and an analyst
 * upgrade is a guidance event, not an upgrade.
 */
const RULES: Rule[] = [
  // High — changes forward estimates or removes an existential uncertainty.
  {
    type: "guidance",
    quality: "high",
    pattern:
      /\b(raises?|raised|lifts?|boosts?|hikes?)\s+(its\s+)?(full[- ]year\s+|fy\d*\s+|q\d\s+)?(guidance|outlook|forecast|target)\b/i,
  },
  {
    type: "guidance",
    quality: "high",
    pattern: /\bbeat[- ]and[- ]raise\b|\braises?\s+(revenue|earnings|eps|sales)\s+(guidance|outlook|forecast)\b/i,
  },
  {
    type: "regulatory",
    quality: "high",
    pattern:
      /\b(fda|ema|mhra)\s+(approves?|approved|clears?|cleared)\b|\b(approved|cleared)\s+by\s+(the\s+)?(fda|ema|mhra)\b|\b(receives?|received|wins?|won|gains?|gained|obtains?|obtained)\s+(fda|ema|mhra)\s+(approval|clearance)\b/i,
  },
  {
    type: "regulatory",
    quality: "high",
    pattern:
      /\bphase\s*(3|iii)\b.{0,60}\b(successful|succeeds?|positive\s+(topline\s+)?results)\b|\b(meets?|met)\s+(the\s+|its\s+)?(co[- ])?primary\s+endpoints?\b/i,
  },
  {
    type: "regulatory",
    quality: "high",
    pattern:
      /\b(fda|ema|mhra)\s+grants?\s+.{0,60}\b(approval|clearance|breakthrough therapy designation|orphan drug designation)\b|\b(receives?|received|granted|gains?|gained)\s+(fda\s+)?(breakthrough therapy|orphan drug)\s+designation\b/i,
  },
  {
    type: "earnings",
    quality: "high",
    pattern:
      /\b(tops?|beats?|smashes|crushes)\s+(q\d\s+)?(earnings|estimates?|expectations?|revenue|eps|forecasts?)\b/i,
  },
  {
    type: "contract",
    quality: "high",
    pattern:
      /\b(wins?|won|awarded|secures?|secured|lands?|landed|receives?|received|signs?|signed)\s+(a\s+)?(\$[\d.,]+\s*(million|billion|b|m)\s+)?((defense|government|dod|nasa|pentagon|multi[- ]year)\s+)?(contract|order|award|deal|tender|agreement)\b/i,
  },

  // Medium — real, but the upside is capped or unproven.
  {
    type: "m_and_a",
    quality: "medium",
    pattern:
      /\b(agrees? to (acquire|buy|merge)|agreed to (acquire|buy|merge)|acquires?|acquired|signs? (a\s+)?(definitive\s+)?merger agreement|announces? (a\s+)?(takeover|buyout|tender offer))\b/i,
  },
  {
    type: "partnership",
    quality: "medium",
    pattern:
      /\b(announces?|announced|signs?|signed|enters?|entered|forms?|formed)\s+(a\s+)?(strategic\s+)?(partnership|collaboration|joint venture|alliance)\b|\bteams? up with\b/i,
  },
  {
    type: "product",
    quality: "medium",
    pattern:
      /\b(launch\w*|unveil\w*|introduc\w*|debut\w*)\s+(a\s+|its\s+|new\s+)?(product|platform|chip|device|service|model)\b/i,
  },
  { type: "squeeze", quality: "low", pattern: /\bshort squeeze\b|\bsqueez\w+\s+higher\b|\bhigh short interest\b/i },

  // Low — attention without a change in fundamentals.
  {
    type: "analyst",
    quality: "low",
    pattern: /\b(upgrad\w+|initiat\w+\s+(coverage|at)|price target (raise|hike|increase)|raises? price target)\b/i,
  },
  {
    type: "theme",
    quality: "low",
    pattern:
      /\b(ai|artificial intelligence|quantum|crypto|bitcoin|nuclear|space|robotic\w*|ev|electric vehicle|defense)\s+(play|stock|theme|rally|boom|hype)\b/i,
  },
];

/**
 * Language that disqualifies regardless of any catalyst also present.
 *
 * A dilutive offering announced alongside a contract win is still a dilutive
 * offering. Deliberately overlaps the entry gate's blocking red flags: an
 * adverse event should be caught wherever it first appears.
 */
const DISQUALIFYING =
  /\b(dilut\w+|secondary offering|shelf offering|at[- ]the[- ]market offering|going concern|bankrupt\w*|chapter\s*11|delist\w+|investigation|subpoena|class action|fraud|restat\w+|resign\w+|steps? down|downgrad\w+|cuts? (guidance|outlook|forecast)|withdraws? guidance|denied|denies|reject\w*|fail\w*|misses?|missed|unsuccessful|negative (results|data)|complete response letter|clinical hold|terminat\w*|revok\w*|rescinds?|cancel\w*)\b|\b(not|never|no longer|no|without|didn't|doesn't|hasn't|wasn't|isn't|won't|can't)\b.{0,50}\b(approv\w*|clear\w*|grant\w*|meet|met|beat\w*|rais\w*|lift\w*|boost\w*|hike\w*|tops?|smash\w*|crush\w*|win\w*|won|secur\w*|receiv\w*|land\w*|award\w*|sign\w*|launch\w*|unveil\w*|introduc\w*|debut\w*|positive|success\w*|succeed\w*|partner\w*|acquir\w*|agre\w*|buy|merge\w*|announc\w*|form\w*|teams?)\b/i;

// A scheduled binary event or prediction is not the event's favorable outcome.
// Whole-headline rejection intentionally sacrifices coverage when the wording
// mixes an actual event with unresolved event risk.
const UNCONFIRMED =
  /\b(await\w*|pending|upcoming|scheduled|expects?|expected|anticipat\w*|seeks?|seeking|applies?|applied|submits?|submitted|could|may|might|will|would|plans?|planned|poised|potential|rumou?r\w*|unconfirmed|unverified|tentative|reportedly|consider\w*|explor\w*|discuss\w*|talks|hopes?|likely|if)\b|\?/i;

const QUALITY_RANK: Record<CatalystQuality, number> = { low: 1, medium: 2, high: 3 };

/** True when the text carries language that disqualifies a long regardless of any catalyst. */
export function isDisqualifying(text: string): boolean {
  return typeof text === "string" && DISQUALIFYING.test(text);
}

/** Classify a headline. Returns null when nothing qualifies or the text disqualifies it. */
export function classifyCatalyst(text: string): CatalystHit | null {
  if (!text || typeof text !== "string") return null;
  if (adverseCatalystReason(text) || UNCONFIRMED.test(text)) return null;

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) return { type: rule.type, quality: rule.quality, matched: match[0].slice(0, 60) };
  }
  return null;
}

/** Issuer-specific adverse evidence invalidates earlier cached favorable events. */
export function adverseCatalystReason(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  return DISQUALIFYING.exec(text.replace(/[’‘]/g, "'"))?.[0].slice(0, 100) ?? null;
}

/** True when `quality` is at least `minimum`. */
export function meetsQuality(quality: CatalystQuality, minimum: CatalystQuality): boolean {
  return QUALITY_RANK[quality] >= QUALITY_RANK[minimum];
}

/** Best catalyst in a set, or null. */
export function bestCatalyst(hits: CatalystHit[] | undefined): CatalystHit | null {
  if (!hits?.length) return null;
  return hits.reduce((best, h) => (QUALITY_RANK[h.quality] > QUALITY_RANK[best.quality] ? h : best));
}
