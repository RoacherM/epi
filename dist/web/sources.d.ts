import type { SourceConfig } from "./config.js";
import { type DateRange } from "./dates.js";
import type { SourceHit } from "./fuse.js";
interface SearchRequest {
    query: string;
    count: number;
    range: DateRange;
    sites: string[];
    now: number;
}
export interface FetchedPage {
    url: string;
    title: string;
    /** Markdown or text. */
    content: string;
    /** The source's raw publication date, when it has one (Exa does, DeepSeek doesn't). */
    date?: unknown;
}
interface FetchOptions {
    /** Content fetched now, not from a cache (Exa `maxAgeHours: 0`). */
    fresh: boolean;
}
export declare class SourceError extends Error {
}
/** What an MCP source calls its tool through (Pi's `ctx.executeTool`, §4.5). */
export type CallTool = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{
    isError: boolean;
    content: unknown;
    structuredContent?: unknown;
}>;
export interface WebSource {
    readonly id: string;
    readonly canFetch: boolean;
    search(request: SearchRequest, signal: AbortSignal): Promise<SourceHit[]>;
    fetch?(url: string, options: FetchOptions, signal: AbortSignal): Promise<FetchedPage>;
}
/** The query with DeepSeek's operators for the sites and dates (§4.3): `after:` is inclusive of the
 * UTC day DeepSeek reads, so both ends are widened by a day and the local recheck trims the rest. */
export declare function deepseekQuery(request: SearchRequest): string;
export declare function parseMcpResults(result: {
    content: unknown;
    structuredContent?: unknown;
}): SourceHit[];
interface SourceSetup {
    config: SourceConfig;
    /** A built-in source's key; undefined: the source can't run. */
    key?: string | undefined;
}
/** The source for `setup`, or undefined when it can't run (no key). */
export declare function createSource(setup: SourceSetup, callTool: CallTool | undefined): WebSource | undefined;
export {};
//# sourceMappingURL=sources.d.ts.map