/**
 * Form 4 insider transactions.
 *
 * The evidence here is asymmetric and the asymmetries are the whole signal:
 *
 * - **Purchases predict; sales do not.** Insiders sell for diversification,
 *   taxes and liquidity. They buy for one reason. Treating the two
 *   symmetrically adds noise to one side and throws away signal on the other.
 * - **Only open-market purchases count.** Transaction code `P`. Codes `M`
 *   (option exercise) and `A` (grant) are compensation, not conviction, and
 *   they are the bulk of Form 4 volume — a feed that does not separate them is
 *   mostly reporting payroll.
 * - **Clusters beat singles.** Several distinct insiders buying inside a window
 *   is materially stronger than one, and far harder to explain away.
 * - **Role matters.** A chief executive or finance officer outranks a director.
 *
 * Parsing is deliberately regex-based rather than a DOM parse: Form 4 XML is
 * small, rigidly structured, and this runs in a Worker where a parser
 * dependency costs more than it returns.
 */

/** Open-market purchase. The only code that carries information. */
export const PURCHASE_CODE = "P";

export interface InsiderTransaction {
  symbol: string;
  insider: string;
  /** Officer title when one is stated, for weighting a chief executive above a director. */
  title: string | null;
  is_officer: boolean;
  is_director: boolean;
  shares: number;
  price: number;
  /** Total dollars committed, the figure that separates a gesture from conviction. */
  value_usd: number;
  filed_at: number;
}

export interface InsiderCluster {
  symbol: string;
  /** Distinct people, not filings — one person filing three times is not a cluster. */
  insiders: number;
  officers: number;
  total_usd: number;
  newest_at: number;
  quality: "high" | "medium" | "low";
  summary: string;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]!.replace(/<[^>]+>/g, "").trim() : null;
}

function repeated(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>\\s*(?:<value>)?([^<]*)`, "g"))].map((m) => m[1]!.trim());
}

/**
 * Extract open-market purchases from one Form 4 document.
 *
 * Returns an empty array for a sale, an option exercise, a grant, or anything
 * without a resolvable ticker — all of which are the common case.
 */
export function parseForm4(xml: string, filedAt: number): InsiderTransaction[] {
  if (!xml || typeof xml !== "string") return [];

  const symbol = tag(xml, "issuerTradingSymbol")?.toUpperCase() ?? null;
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return [];

  const insider = tag(xml, "rptOwnerName") ?? "unknown";
  const isOfficer = tag(xml, "isOfficer") === "1" || tag(xml, "isOfficer")?.toLowerCase() === "true";
  const isDirector = tag(xml, "isDirector") === "1" || tag(xml, "isDirector")?.toLowerCase() === "true";
  const title = tag(xml, "officerTitle");

  const codes = repeated(xml, "transactionCode");
  const shares = repeated(xml, "transactionShares").map(Number);
  const prices = repeated(xml, "transactionPricePerShare").map(Number);
  const acquired = repeated(xml, "transactionAcquiredDisposedCode");

  const out: InsiderTransaction[] = [];
  for (let i = 0; i < codes.length; i++) {
    // Both must agree: an open-market code and an acquisition. A `P` marked
    // disposed is a data error, not a purchase.
    if (codes[i] !== PURCHASE_CODE || acquired[i] !== "A") continue;
    const qty = shares[i] ?? Number.NaN;
    const px = prices[i] ?? Number.NaN;
    if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) continue;
    out.push({
      symbol,
      insider,
      title,
      is_officer: isOfficer,
      is_director: isDirector,
      shares: qty,
      price: px,
      value_usd: qty * px,
      filed_at: filedAt,
    });
  }
  return out;
}

/** A chief executive or finance officer buying is the strongest single form. */
export function isSeniorOfficer(t: InsiderTransaction): boolean {
  return t.is_officer && /chief exec|^ceo\b|chief financial|^cfo\b|president|chairman/i.test(t.title ?? "");
}

/** Dollars below this read as a gesture rather than conviction. */
export const MIN_CLUSTER_USD = 50_000;

/**
 * Group transactions per issuer into clusters.
 *
 * Counts distinct people rather than filings: one insider filing three times in
 * a day is one buyer, and treating it as three would manufacture clusters out
 * of paperwork.
 */
export function buildClusters(
  transactions: InsiderTransaction[],
  windowMs: number,
  now = Date.now()
): InsiderCluster[] {
  const bySymbol = new Map<string, InsiderTransaction[]>();
  for (const t of transactions) {
    if (!Number.isFinite(t.filed_at) || now - t.filed_at > windowMs || t.filed_at > now) continue;
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  const clusters: InsiderCluster[] = [];
  for (const [symbol, txs] of bySymbol) {
    const people = new Set(txs.map((t) => t.insider.toUpperCase()));
    const officers = new Set(txs.filter((t) => t.is_officer).map((t) => t.insider.toUpperCase()));
    const senior = txs.some(isSeniorOfficer);
    const total = txs.reduce((s, t) => s + t.value_usd, 0);
    if (total < MIN_CLUSTER_USD) continue;

    // Several buyers, or one senior officer, is the bar. A lone director buying
    // is real but weak, and is graded accordingly rather than discarded.
    let quality: InsiderCluster["quality"];
    if (people.size >= 2 && officers.size >= 1) quality = "high";
    else if (people.size >= 2 || senior) quality = "medium";
    else quality = "low";

    const lead = txs.reduce((a, b) => (b.value_usd > a.value_usd ? b : a));
    clusters.push({
      symbol,
      insiders: people.size,
      officers: officers.size,
      total_usd: total,
      newest_at: Math.max(...txs.map((t) => t.filed_at)),
      quality,
      summary:
        `${people.size} insider${people.size === 1 ? "" : "s"} bought $${Math.round(total).toLocaleString()} ` +
        `on the open market (largest: ${lead.insider}${lead.title ? `, ${lead.title}` : ""})`,
    });
  }
  return clusters.sort((a, b) => b.total_usd - a.total_usd);
}
