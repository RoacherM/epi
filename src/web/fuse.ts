// Merging what several sources found (docs/web-search-design.md §4.2): one entry per page, ranked by
// Reciprocal Rank Fusion over each source's own order (their scores are not comparable), each date
// normalized and rechecked against the requested range.
import { type DateRange, inRange, isImplausible, normalizeDate, type PageDate, pickDate } from "./dates.js";

/** One result as a source returned it, in that source's rank order. */
export interface SourceHit {
  url: string;
  title?: string | undefined;
  /** A long summary written for a model (DeepSeek's `summary`). */
  summary?: string | undefined;
  /** Shorter excerpts (DeepSeek's `snippet`, Exa's `highlights`). */
  snippet?: string | undefined;
  /** The source's raw publication date. */
  date?: unknown;
  /** DeepSeek's authority tier (0–4), a tie-breaker. */
  authority?: number | undefined;
}

export interface MergedHit {
  url: string;
  key: string;
  title: string;
  text: string;
  /** The sources that found it, in source order. */
  sources: string[];
  score: number;
  date: PageDate | undefined;
  /** Other sources' dates more than a day off. */
  disagrees: PageDate[];
  /** A source gave a date later than tomorrow, which was dropped. */
  dateLooksWrong: boolean;
  authority: number;
}

// RRF's usual constant: a page ranked 1st by one source and 10th by another beats one ranked 2nd by
// only one, without the top ranks swamping the rest.
const RRF_K = 60;
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|ref|ref_src)$/i;

/** A URL reduced to what decides whether two results are the same page: no scheme, no `www.`, no
 * fragment, no tracking parameters, no trailing slash, lowercase host. Unparseable: as given. */
export function urlKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim();
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name));
  const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
  const path = parsed.pathname.replace(/\/+$/, "");
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `${host}${port}${path}${query}`;
}

interface FuseOptions {
  range: DateRange;
  sort: "relevance" | "newest";
  now: number;
}

interface Fused {
  hits: MergedHit[];
  /** Results with a known date outside the range, dropped. */
  outOfRange: number;
}

function firstText(hits: readonly SourceHit[], pick: (hit: SourceHit) => string | undefined): string {
  for (const hit of hits) {
    const text = pick(hit)?.trim();
    if (text) return text;
  }
  return "";
}

interface Collected {
  url: string;
  sources: string[];
  hits: SourceHit[];
  score: number;
}

/** Each page once, with the sources that found it and its RRF score. */
function collect(bySource: ReadonlyMap<string, readonly SourceHit[]>): Map<string, Collected> {
  const merged = new Map<string, Collected>();
  for (const [source, hits] of bySource) {
    const seen = new Set<string>();
    hits.forEach((hit, index) => {
      const key = urlKey(hit.url);
      // A source listing one page twice ranks it once, at its best place.
      if (seen.has(key)) return;
      seen.add(key);
      const entry = merged.get(key) ?? { url: hit.url, sources: [], hits: [], score: 0 };
      entry.sources.push(source);
      entry.hits.push(hit);
      entry.score += 1 / (RRF_K + index + 1);
      merged.set(key, entry);
    });
  }
  return merged;
}

function toMerged(key: string, entry: Collected, now: number): MergedHit {
  let dateLooksWrong = false;
  const dates: PageDate[] = [];
  entry.hits.forEach((hit, index) => {
    const date = normalizeDate(hit.date, entry.sources[index]!);
    if (date === undefined) return;
    if (isImplausible(date, now)) dateLooksWrong = true;
    else dates.push(date);
  });
  const { date, disagrees } = pickDate(dates);
  return {
    url: entry.url,
    key,
    title: firstText(entry.hits, (hit) => hit.title) || entry.url,
    // §4.2-5: DeepSeek's summary is written for a model; otherwise the excerpts.
    text: firstText(entry.hits, (hit) => hit.summary) || firstText(entry.hits, (hit) => hit.snippet),
    sources: entry.sources,
    score: entry.score,
    date,
    disagrees,
    dateLooksWrong,
    authority: Math.max(-1, ...entry.hits.map((hit) => hit.authority ?? -1)),
  };
}

function dateKey(hit: MergedHit): string {
  if (hit.date === undefined) return "";
  return hit.date.precision === "year" ? `${hit.date.date}-00-00` : hit.date.date;
}

function byRelevance(a: MergedHit, b: MergedHit): number {
  return b.score - a.score || dateKey(b).localeCompare(dateKey(a)) || b.authority - a.authority;
}

/** Merges each source's ranked hits (`bySource`, in source order): dedupe by `urlKey`, RRF, the
 * date recheck, then the order. Within a date range a result of unknown date is kept, after the dated
 * ones (§8 #5). */
export function fuse(bySource: ReadonlyMap<string, readonly SourceHit[]>, options: FuseOptions): Fused {
  const merged = [...collect(bySource)].map(([key, entry]) => toMerged(key, entry, options.now));
  const ranged = options.range.after !== undefined || options.range.before !== undefined;
  let outOfRange = 0;
  const kept = merged.filter((hit) => {
    if (!ranged || hit.date === undefined || inRange(hit.date, options.range)) return true;
    outOfRange += 1;
    return false;
  });
  kept.sort((a, b) => {
    if ((ranged || options.sort === "newest") && (a.date === undefined) !== (b.date === undefined)) return a.date === undefined ? 1 : -1;
    if (options.sort === "newest") return dateKey(b).localeCompare(dateKey(a)) || byRelevance(a, b);
    return byRelevance(a, b);
  });
  return { hits: kept, outOfRange };
}
