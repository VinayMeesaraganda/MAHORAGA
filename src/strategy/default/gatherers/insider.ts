/**
 * Form 4 insider-purchase gatherer.
 *
 * `sec_4` has carried a source weight since before this work while the SEC
 * gatherer only ever requested 8-K, so insider filings were configured and
 * never fetched. This closes that.
 *
 * The feed gives filer names, not transactions, so each filing needs its index
 * page and then its XML. That is two requests per filing, which is why
 * accession numbers already seen are remembered and only a small number of new
 * ones are fetched per pass. SEC asks for a declared User-Agent and no more
 * than ten requests a second; both are respected.
 *
 * Emits catalysts rather than sentiment signals: an insider buying is a
 * discrete event that changes what the company is worth to the people who know
 * it best, which is the definition the entry gate already uses.
 */

import type { Signal } from "../../../core/types";
import type { Gatherer, StrategyContext } from "../../types";
import { buildClusters, type InsiderTransaction, parseForm4 } from "../helpers/insider";

const FEED =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=40&output=atom";
/** SEC requires a declared agent with contact details. */
const UA = "Mahoraga trading research (contact via repository issues)";
/** Two requests per filing, so this bounds the pass rather than the feed. */
const MAX_NEW_FILINGS_PER_PASS = 8;
/** How long a purchase stays relevant. Drift from insider buying is measured in weeks. */
const CLUSTER_WINDOW_MS = 14 * 86_400_000;

async function get(url: string, ctx: StrategyContext): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) ctx.log("Insider", "source_unavailable", { status: res.status });
      return null;
    }
    return await res.text();
  } catch {
    return null;
  }
}

async function gatherInsider(ctx: StrategyContext): Promise<Signal[]> {
  const now = Date.now();

  const feed = await get(FEED, ctx);
  if (!feed) return [];

  // SEC publishes one index page per party to a filing — the reporting owner and
  // the issuer each get their own URL for the same document. Deduplicating on
  // the URL counts a single purchase two or three times, which inflates the
  // dollar total that decides the cluster grade. The accession number is the
  // filing's real identity, so dedupe on that.
  const byAccession = new Map<string, string>();
  for (const m of feed.matchAll(/https:\/\/www\.sec\.gov\/Archives[^<"]*?(\d{10}-\d{2}-\d{6})-index\.htm/g)) {
    if (!byAccession.has(m[1]!)) byAccession.set(m[1]!, m[0]);
  }
  const seen = ctx.state.get<Record<string, number>>("processedForm4") ?? {};
  const fresh = [...byAccession].filter(([accession]) => !seen[accession]).slice(0, MAX_NEW_FILINGS_PER_PASS);

  const stored = ctx.state.get<InsiderTransaction[]>("insiderTransactions") ?? [];
  const collected: InsiderTransaction[] = [];

  for (const [accession, indexUrl] of fresh) {
    const page = await get(indexUrl, ctx);
    seen[accession] = now;
    if (!page) continue;
    // Skip the XSL-rendered view; the raw document is the parseable one.
    const xmlPath = [...page.matchAll(/\/Archives\/[^"']*\.xml/g)].map((m) => m[0]).find((p) => !p.includes("xslF"));
    if (!xmlPath) continue;
    const xml = await get(`https://www.sec.gov${xmlPath}`, ctx);
    if (!xml) continue;
    collected.push(...parseForm4(xml, now));
    await ctx.sleep(150); // stay well inside SEC's rate limit
  }

  // Keep a rolling record: a cluster forms across filings and days, not within
  // one pass, and the feed only shows what was filed most recently.
  const merged = [...stored, ...collected].filter((t) => now - t.filed_at <= CLUSTER_WINDOW_MS);
  ctx.state.set("insiderTransactions", merged.slice(-400));
  // Prune the accession record on the same horizon so it cannot grow unbounded.
  for (const [accession, at] of Object.entries(seen)) if (now - at > CLUSTER_WINDOW_MS) delete seen[accession];
  ctx.state.set("processedForm4", seen);

  const clusters = buildClusters(merged, CLUSTER_WINDOW_MS, now);

  // Publish as catalysts, alongside the news gatherer's, so the entry gate
  // treats every source identically.
  const catalystCache = ctx.state.get<Record<string, Array<Record<string, unknown>>>>("catalystCache") ?? {};
  let published = 0;
  for (const c of clusters) {
    if (c.quality === "low") continue; // a lone director buying is real but weak
    const list = (catalystCache[c.symbol] ??= []);
    if (list.some((h) => h.headline === c.summary)) continue;
    list.push({
      type: "insider",
      quality: c.quality,
      matched: "open-market purchase",
      headline: c.summary,
      symbol: c.symbol,
      at: c.newest_at,
    });
    if (list.length > 5) list.shift();
    published++;
  }
  ctx.state.set("catalystCache", catalystCache);

  ctx.log("Insider", "gathered", {
    filings_seen: byAccession.size,
    fetched: fresh.length,
    purchases: collected.length,
    clusters: clusters.length,
    published,
  });

  // Context only — the catalyst is the output, not a sentiment score.
  return [];
}

export const insiderGatherer: Gatherer = {
  name: "insider",
  gather: gatherInsider,
};
