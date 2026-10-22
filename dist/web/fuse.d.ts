import { type DateRange, type PageDate } from "./dates.js";
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
/** A URL reduced to what decides whether two results are the same page: no scheme, no `www.`, no
 * fragment, no tracking parameters, no trailing slash, lowercase host. Unparseable: as given. */
export declare function urlKey(url: string): string;
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
/** Merges each source's ranked hits (`bySource`, in source order): dedupe by `urlKey`, RRF, the
 * date recheck, then the order. Within a date range a result of unknown date is kept, after the dated
 * ones (§8 #5). */
export declare function fuse(bySource: ReadonlyMap<string, readonly SourceHit[]>, options: FuseOptions): Fused;
export {};
//# sourceMappingURL=fuse.d.ts.map