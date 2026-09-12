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
  | "insider"
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
    type: "regulatory",
    quality: "medium",
    pattern:
      /\b(settl\w+|resolv\w+|dismiss\w+|wins? dismissal|clear\w+)\b.{0,50}\b(class action|lawsuit|litigation|investigation|probe|inquiry|antitrust|complaint|suit|case)\b/i,
  },
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
  /\b(dilut\w+|secondary offering|shelf offering|at[- ]the[- ]market offering|going concern|bankrupt\w*|chapter\s*11|delist\w+|investigation|subpoena|class action|lawsuit|litigation|probe|inquiry|fraud|restat\w+|resign\w+|steps? down|downgrad\w+|(cuts?|lowers?|reduces?|trims?|slashes|scales? back|walks? back|pulls?|suspends?|withdraws?)\s+(its\s+)?(full[- ]year\s+|fy\d*\s+|q\d\s+|quarterly\s+|annual\s+|revenue\s+|earnings\s+|profit\s+|sales\s+)?(guidance|outlook|forecast|target|estimates?|projections?)|(guidance|outlook|forecast)\s+(cut|lowered|reduced|withdrawn|suspended|pulled)|denied|denies|reject\w*|fail\w*|misses?|missed|unsuccessful|negative (results|data)|(warns?|warned|warning|cautions?|flags?)\s+.{0,40}\b(short|shortfall|below|miss|weak\w*|declin\w*|impact)|\b(revenue|sales|earnings|eps|results|profit)\b.{0,30}\b(fall short|falls short|below (expectations|estimates|consensus|guidance)|shortfall)|\b(miss|missing)\b.{0,25}\b(target|targets|guidance|estimates?|consensus|expectations)|material (adverse )?impact on\s+(\w+\s+){0,2}(revenue|earnings|results|sales|operations|production|guidance)|(production|supply|shipment|manufacturing)\s+(shortfall|disruption|halt|stoppage|outage)|(cyber\s*attack|cyberattack|ransomware|(cyber\s*security|security|data)\s+(incident|breach|intrusion|compromise))|complete response letter|clinical hold|terminat\w*|revok\w*|rescinds?|cancel\w*)\b|\b(not|never|no longer|no|without|didn't|doesn't|hasn't|wasn't|isn't|won't|can't)\b.{0,50}\b(approv\w*|clear\w*|grant\w*|meet|met|beat\w*|rais\w*|lift\w*|boost\w*|hike\w*|tops?|smash\w*|crush\w*|win\w*|won|secur\w*|receiv\w*|land\w*|award\w*|sign\w*|launch\w*|unveil\w*|introduc\w*|debut\w*|positive|success\w*|succeed\w*|partner\w*|acquir\w*|agre\w*|buy|merge\w*|announc\w*|form\w*|teams?)\b/i;

/**
 * Legal and regulatory matters being resolved rather than opened.
 *
 * The adverse list matches nouns — investigation, class action, lawsuit — and a
 * noun cannot say which direction the event runs. "Settles class action" and
 * "faces class action" are opposite events sharing a phrase, and reading both
 * as adverse means selling a position on the very news that removed its risk.
 * Onset language is checked alongside, because a headline naming both a new
 * case and an old settlement is not a clearance.
 */
const RESOLUTION =
  /\b(settl\w+|resolv\w+|dismiss\w+|dropp?\w*|clear\w+|conclud\w+|finaliz\w+|wins? dismissal|throws? out)\b/i;
const ONSET =
  /\b(faces?|facing|new|opens?|opened|launch\w*|files?|filed|filing|hit with|accused|charged|widen\w*|expand\w*|escalat\w*)\b/i;

/** True when an adverse-sounding matter is being cleared rather than started. */
export function isResolution(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return RESOLUTION.test(text) && !ONSET.test(text);
}

// Cancelling something is adverse only when the thing cancelled was good. A
// terminated contract is a loss; a terminated share-sale plan is the removal of
// supply. `cancel\w*` and `terminat\w*` sit bare in the disqualifying list, so
// without this an insider calling off a scheduled sale — unambiguously welcome
// news — reads as an adverse event and would close a held position on it. Same
// defect as reading a settled case as a pending one, in different clothes.
const CANCELLATION =
  /\b(cancel\w*|terminat\w*|revok\w*|rescinds?|scraps?|scrapped|abandons?|abandoned|calls? off|called off|shelv\w*)\b/i;
/** Plans whose cancellation removes an overhang instead of creating one. */
const UNWELCOME_PLAN =
  /\b((share|stock|equity)\s+sale|sale of (his|her|their|the)\s+(shares?|stake|holdings?)|(plans?|planned|scheduled)\s+(to\s+)?sell|10b5-1|(secondary|share|stock|follow[- ]on)\s+offering|layoffs?|job cuts?|redundanc\w+)\b/i;

// The plan must attach to the cancelling verb, not merely share a sentence with
// it. Only determiners and adjectives may intervene: "cancels the planned
// secondary offering" qualifies, "cancels a contract and announces a secondary
// offering" must not, because there the offering is still happening.
const ATTACHED = new RegExp(
  `${CANCELLATION.source}(\\s+(its|his|her|their|the|a|an|all|any|further|remaining|previously|planned|proposed|scheduled|upcoming|pending|announced))*\\s+(?:${UNWELCOME_PLAN.source.replace(/^\\b|\\b$/g, "")})`,
  "i"
);

/** True when the headline calls off something the market did not want. */
export function cancelsAnOverhang(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return ATTACHED.test(text);
}

// A scheduled binary event or prediction is not the event's favorable outcome.
// Whole-headline rejection intentionally sacrifices coverage when the wording
// mixes an actual event with unresolved event risk.
const UNCONFIRMED =
  /\b(await\w*|pending|upcoming|scheduled|expects?|expected|anticipat\w*|seeks?|seeking|applies?|applied|submits?|submitted|could|may|might|will|would|plans?|planned|poised|potential|rumou?r\w*|unconfirmed|unverified|tentative|reportedly|consider\w*|explor\w*|discuss\w*|talks|hopes?|likely|if)\b|\?/i;

const QUALITY_RANK: Record<CatalystQuality, number> = { low: 1, medium: 2, high: 3 };

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
  const normalised = text.replace(/[’‘]/g, "'");

  // Every adverse match is considered, not just the first. "Settles lawsuit and
  // announces a dilutive offering" would otherwise be cleared on the lawsuit and
  // never reach the dilution — one headline can carry a resolved proceeding and
  // a live problem at the same time.
  const matches = [...normalised.matchAll(new RegExp(DISQUALIFYING.source, "gi"))].map((m) => m[0]);
  if (!matches.length) return null;

  // A proceeding being cleared is not the proceeding. The exemption is confined
  // to pending-proceeding language: "settles" does not rescue a dilutive
  // offering or a guidance cut, which are events in their own right.
  const proceeding = /\b(investigation|subpoena|class action|lawsuit|litigation|probe|inquiry|complaint|suit)\b/i;
  const resolved = isResolution(normalised);
  // Each exemption is scoped to the matches it can legitimately excuse, so a
  // headline carrying both a cancelled share sale and a guidance cut still
  // reports the guidance cut.
  // Both the cancelling verb and the cancelled plan are excused, since
  // "secondary offering" and "layoffs" are independently disqualifying and would
  // otherwise survive the exemption that was meant to clear them.
  const cancelled = cancelsAnOverhang(normalised);
  const live = matches.find(
    (m) => !(resolved && proceeding.test(m)) && !(cancelled && (CANCELLATION.test(m) || UNWELCOME_PLAN.test(m)))
  );
  return live ? live.slice(0, 100) : null;
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
