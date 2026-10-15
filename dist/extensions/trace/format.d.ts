/** A duration the way the list and the inspector show it: sub-millisecond, milliseconds, seconds,
 * minutes. Zero and missing are different answers and are not spelled the same. */
export declare function formatDuration(ms: number | undefined): string;
/** A wall-clock instant as local HH:MM:SS, or "—". */
export declare function formatClock(atMs: number | undefined): string;
/** An offset from the timeline's start, as "+1.2s" (or "+0ms"). */
export declare function formatOffset(atMs: number | undefined, startMs: number | undefined): string;
/** Pretty JSON that survives values JSON cannot represent (BigInt, cycles, functions). Unknown keys
 * are kept: the inspector shows what was recorded, not a whitelist. */
export declare function safeJson(value: unknown, maxChars?: number): string;
export interface UsageLine {
    label: string;
    value: string;
    /** True when this value is already included in another line and must not be added again. */
    subset?: boolean;
}
/** Usage and cost broken into named lines (docs/trace-design.md §5): `reasoning` is a subset of
 * `output`, `cacheWrite1h` a subset of `cacheWrite`; both are labelled rather than re-added. */
export declare function usageLines(usage: unknown): UsageLine[];
/** One line per tool-result content block. Images become metadata, never the base64 payload. */
export declare function contentLines(content: unknown): string[];
//# sourceMappingURL=format.d.ts.map