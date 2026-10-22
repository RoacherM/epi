import { type DateRange, type PageDate, type Recency } from "./dates.js";
import { type WebSource } from "./sources.js";
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
export declare class WebParamError extends Error {
}
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
export declare function resolveRange(params: Pick<SearchParams, "after" | "before" | "recency">, now: number): DateRange;
/** The sources a call uses: all of them, or the ones it names (each must exist and be usable). */
export declare function chooseSources(available: readonly WebSource[], names: readonly string[] | undefined, configured: readonly string[]): WebSource[];
interface SearchContext {
    sources: readonly WebSource[];
    signal: AbortSignal;
    now: number;
}
/** Runs one search over `context.sources` (already chosen) and writes the result. */
export declare function hybridSearch(params: SearchParams, range: DateRange, count: number, context: SearchContext): Promise<SearchOutcome>;
/** What a search earlier this session said about a page's date, for a fetch that has none (§4.3). */
export declare class SeenDates {
    private readonly dates;
    note(details: SearchDetails): void;
    get(url: string): PageDate | undefined;
    clear(): void;
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
/** Fetches `url` from the sources in order; the next is tried only when one fails, and each failure
 * is written into the result (§4.4: a configured order, not a silent fallback). */
export declare function fetchPage(url: string, fresh: boolean, sources: readonly WebSource[], seen: SeenDates, context: Omit<SearchContext, "sources">): Promise<FetchOutcome>;
export {};
//# sourceMappingURL=search.d.ts.map