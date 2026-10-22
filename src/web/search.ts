// One hybrid search and one fetch (docs/web-search-design.md §4): every chosen source at once, each
// with its own timeout, merged by fuse.ts, written for the model with today's date at the top and each
// result's date first. A source that fails is named with its reason; the search fails only when all do.
import { ago, type DateRange, describeNow, describeRange, isImplausible, normalizeDate, type PageDate, recencyRange, type Recency, startDay } from "./dates.js";
import { fuse, type MergedHit, type SourceHit, urlKey } from "./fuse.js";
import { type FetchedPage, SourceError, type WebSource } from "./sources.js";

const SOURCE_TIMEOUT_MS = 15_000;
const SUMMARY_MAX = 800;
const TOTAL_MAX = 8_000;
const FETCH_MAX = 40_000;

export interface SearchParams {
  query: string;
  count?: number | undefined;
  sources?: string[] | undefined;
  after?: string | undefined;
  before?: string | undefined;
  recency?: Recency | undefined;
  sort?: "relevance" | "newest" | undefined;
  sites?: string[] | undefined;
}

export class WebParamError extends Error {}

interface SourceRun {
  id: string;
  ms: number;
  hits?: number;
  error?: string;
}

interface ShownHit {
  url: string;
  title: string;
  sources: string[];
  /** `YYYY-MM-DD` (or `YYYY`), when known. */
  date?: string | undefined;
  ago?: string | undefined;
  /** `exa: 2026-06-03`: another source's date, more than a day off. */
  otherDates?: string[];
  dateLooksWrong?: boolean;
}

/** What the call row, the expanded view and /trace draw (the tool result's `details`). */
export interface SearchDetails {
  kind: "search";
  query: string;
  range: DateRange;
  sort: "relevance" | "newest";
  today: string;
  runs: SourceRun[];
  hits: ShownHit[];
  outOfRange: number;
  /** Earliest and latest known dates among the hits. */
  span?: [string, string];
}

interface SearchOutcome {
  text: string;
  details: SearchDetails;
  failed: boolean;
}

/** `after`/`before`/`recency` as one range in local days; a parameter error names what is wrong. */
export function resolveRange(params: Pick<SearchParams, "after" | "before" | "recency">, now: number): DateRange {
  if (params.recency !== undefined && params.after !== undefined) throw new WebParamError("give either recency or after, not both");
  const range: DateRange = params.recency === undefined ? {} : recencyRange(params.recency, now);
  if (params.after !== undefined) {
    const after = startDay(params.after);
    if (after === undefined) throw new WebParamError(`after: "${params.after}" is not YYYY, YYYY-MM or YYYY-MM-DD`);
    range.after = after;
  }
  if (params.before !== undefined) {
    // `before 2026-06` excludes June: it is the first day of the span named.
    const before = startDay(params.before);
    if (before === undefined) throw new WebParamError(`before: "${params.before}" is not YYYY, YYYY-MM or YYYY-MM-DD`);
    range.before = before;
  }
  if (range.after !== undefined && range.before !== undefined && range.after >= range.before) {
    throw new WebParamError(`the range is empty: after ${range.after} is not before ${range.before}`);
  }
  return range;
}

/** The sources a call uses: all of them, or the ones it names (each must exist and be usable). */
export function chooseSources(available: readonly WebSource[], names: readonly string[] | undefined, configured: readonly string[]): WebSource[] {
  if (names === undefined || names.length === 0) return [...available];
  const chosen: WebSource[] = [];
  for (const name of new Set(names)) {
    const source = available.find((candidate) => candidate.id === name);
    if (source === undefined) {
      const why = configured.includes(name) ? "is turned off or has no key" : "is not a configured source";
      throw new WebParamError(`sources: "${name}" ${why}; available: ${available.map((candidate) => candidate.id).join(", ") || "none"}`);
    }
    chosen.push(source);
  }
  return chosen;
}

/** `promise` raced against its own timeout and the call's signal, with its own AbortSignal. */
async function runSource<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new SourceError(`no answer in ${SOURCE_TIMEOUT_MS / 1000}s`)), SOURCE_TIMEOUT_MS);
  const onAbort = () => controller.abort(new SourceError("cancelled"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof SourceError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

function reason(error: unknown): string {
  return error instanceof SourceError ? error.message : `unexpected error: ${(error as Error)?.message ?? String(error)}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function showDate(hit: MergedHit, now: number): Pick<ShownHit, "date" | "ago" | "otherDates" | "dateLooksWrong"> {
  return {
    ...(hit.date === undefined ? {} : { date: hit.date.date, ago: ago(hit.date, now) }),
    ...(hit.disagrees.length === 0 ? {} : { otherDates: hit.disagrees.map((date) => `${date.from}: ${date.date}`) }),
    ...(hit.dateLooksWrong ? { dateLooksWrong: true } : {}),
  };
}

function dateLabel(hit: ShownHit): string {
  if (hit.date === undefined) return hit.dateLooksWrong ? "date unknown · date looks wrong" : "date unknown";
  const others = hit.otherDates === undefined ? "" : ` (${hit.otherDates.join(", ")})`;
  return `${hit.date}${others} · ${hit.ago}`;
}

function header(details: SearchDetails): string {
  const parts = [`Searched ${details.today}`];
  const range = describeRange(details.range);
  if (range !== "") parts.push(range);
  if (details.sort === "newest") parts.push("newest first");
  parts.push(details.runs.map((run) => (run.error === undefined ? `${run.id} ${run.hits}` : `${run.id} failed`)).join(", "));
  if (details.outOfRange > 0) parts.push(`${details.outOfRange} outside the date range`);
  return parts.join(" · ");
}

/** The model-facing text: today and what was searched, each source's failure, then the results. */
function searchText(details: SearchDetails, merged: readonly MergedHit[]): string {
  const lines = [header(details)];
  for (const run of details.runs) if (run.error !== undefined) lines.push(`${run.id}: ${run.error}`);
  if (merged.length === 0) {
    lines.push("No results.");
    return lines.join("\n");
  }
  let total = 0;
  let cut = 0;
  merged.forEach((hit, index) => {
    const shown = details.hits[index]!;
    const entry = [`${index + 1}. [${dateLabel(shown)}] ${hit.title} — ${hit.url} [${hit.sources.join(", ")}]`];
    if (hit.text !== "") entry.push(`   ${clip(hit.text, SUMMARY_MAX)}`);
    const text = entry.join("\n");
    if (total + text.length > TOTAL_MAX && index > 0) {
      cut += 1;
      return;
    }
    total += text.length;
    lines.push(text);
  });
  if (cut > 0) lines.push(`(${cut} more results left out: over ${TOTAL_MAX} characters)`);
  return lines.join("\n");
}

function span(hits: readonly ShownHit[]): [string, string] | undefined {
  const dates = hits.flatMap((hit) => (hit.date === undefined ? [] : [hit.date])).sort();
  return dates.length === 0 ? undefined : [dates[0]!, dates[dates.length - 1]!];
}

interface SearchContext {
  sources: readonly WebSource[];
  signal: AbortSignal;
  now: number;
}

/** Runs one search over `context.sources` (already chosen) and writes the result. */
export async function hybridSearch(params: SearchParams, range: DateRange, count: number, context: SearchContext): Promise<SearchOutcome> {
  const { sources, signal, now } = context;
  const sites = (params.sites ?? []).map((site) => site.trim()).filter((site) => site !== "");
  const request = { query: params.query, count, range, sites, now };
  const runs: SourceRun[] = [];
  const bySource = new Map<string, SourceHit[]>();
  await Promise.all(sources.map(async (source, index) => {
    const started = Date.now();
    try {
      const hits = await runSource(signal, (own) => source.search(request, own));
      runs[index] = { id: source.id, ms: Date.now() - started, hits: hits.length };
      bySource.set(source.id, hits);
    } catch (error) {
      runs[index] = { id: source.id, ms: Date.now() - started, error: reason(error) };
    }
  }));
  // Source order, not finishing order: the merge's tie-breaks follow the configuration.
  const ordered = new Map(sources.flatMap((source) => (bySource.has(source.id) ? [[source.id, bySource.get(source.id)!] as const] : [])));
  const sort = params.sort ?? "relevance";
  const fused = fuse(ordered, { range, sort, now });
  const merged = fused.hits.slice(0, count);
  const hits: ShownHit[] = merged.map((hit) => ({ url: hit.url, title: hit.title, sources: hit.sources, ...showDate(hit, now) }));
  const details: SearchDetails = { kind: "search", query: params.query, range, sort, today: describeNow(now), runs, hits, outOfRange: fused.outOfRange, ...(span(hits) === undefined ? {} : { span: span(hits)! }) };
  const failed = runs.every((run) => run.error !== undefined);
  return { text: searchText(details, merged), details, failed };
}

/** What a search earlier this session said about a page's date, for a fetch that has none (§4.3). */
export class SeenDates {
  private readonly dates = new Map<string, PageDate>();

  note(details: SearchDetails): void {
    for (const hit of details.hits) {
      if (hit.date === undefined) continue;
      const date = normalizeDate(hit.date, hit.sources[0] ?? "search");
      if (date !== undefined) this.dates.set(urlKey(hit.url), date);
    }
  }

  get(url: string): PageDate | undefined {
    return this.dates.get(urlKey(url));
  }

  clear(): void {
    this.dates.clear();
  }
}

export interface FetchDetails {
  kind: "fetch";
  url: string;
  title: string;
  today: string;
  runs: SourceRun[];
  /** Which source's page this is. */
  from?: string;
  date?: string;
  ago?: string;
  /** Where the date came from: the page's source, or an earlier search result. */
  dateFrom?: string;
  lines?: number;
}

interface FetchOutcome {
  text: string;
  details: FetchDetails;
  failed: boolean;
}

function pageDate(page: FetchedPage, source: string, url: string, seen: SeenDates, now: number): { date?: PageDate; from?: string } {
  const own = normalizeDate(page.date, source);
  if (own !== undefined && !isImplausible(own, now)) return { date: own, from: source };
  const earlier = seen.get(url);
  return earlier === undefined ? {} : { date: earlier, from: "an earlier search result" };
}

/** Fetches `url` from the sources in order; the next is tried only when one fails, and each failure
 * is written into the result (§4.4: a configured order, not a silent fallback). */
export async function fetchPage(url: string, fresh: boolean, sources: readonly WebSource[], seen: SeenDates, context: Omit<SearchContext, "sources">): Promise<FetchOutcome> {
  const { signal, now } = context;
  const runs: SourceRun[] = [];
  for (const source of sources) {
    const started = Date.now();
    try {
      const page = await runSource(signal, (own) => source.fetch!(url, { fresh }, own));
      runs.push({ id: source.id, ms: Date.now() - started });
      const { date, from } = pageDate(page, source.id, url, seen, now);
      let content = page.content.trim();
      const lines = content === "" ? 0 : content.split("\n").length;
      const cut = content.length > FETCH_MAX;
      if (cut) content = `${content.slice(0, FETCH_MAX)}\n\n(cut at ${FETCH_MAX} of ${page.content.length} characters)`;
      const details: FetchDetails = { kind: "fetch", url, title: page.title, today: describeNow(now), runs, from: source.id, lines, ...(date === undefined ? {} : { date: date.date, ago: ago(date, now), dateFrom: from! }) };
      const failures = runs.filter((run) => run.error !== undefined).map((run) => `${run.id}: ${run.error}`);
      const dateLine = date === undefined ? "date unknown" : `${date.date} · ${ago(date, now)}${from === source.id ? "" : ` (from ${from})`}`;
      const head = [`Fetched ${details.today} · ${source.id}${failures.length > 0 ? ` (after ${failures.join("; ")})` : ""}`, `[${dateLine}] ${page.title || url} — ${url}`];
      return { text: `${head.join("\n")}\n\n${content}`, details, failed: false };
    } catch (error) {
      runs.push({ id: source.id, ms: Date.now() - started, error: reason(error) });
      if (signal.aborted) break;
    }
  }
  const details: FetchDetails = { kind: "fetch", url, title: "", today: describeNow(now), runs };
  return { text: `Could not fetch ${url}:\n${runs.map((run) => `${run.id}: ${run.error}`).join("\n")}`, details, failed: true };
}
