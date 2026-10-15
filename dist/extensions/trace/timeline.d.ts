import type { TraceBar, TraceSummary } from "./types.js";
export interface Timeline {
    startMs: number;
    endMs: number;
    bars: TraceBar[];
    /** Evenly spaced labels along the axis. */
    ticks: Array<{
        atMs: number;
        label: string;
    }>;
    /** Nothing has any timing to show. */
    empty: boolean;
}
export interface TimelineOptions {
    /** Wall clock "now", so a still-running span can reach the right edge honestly. */
    nowMs?: number;
    /** How many axis labels to aim for. */
    tickCount?: number;
}
/** Bars and markers for a projection. User and event steps contribute markers on the nearest lane;
 * they never get a fabricated duration. */
export declare function buildTimeline(summary: TraceSummary, options?: TimelineOptions): Timeline;
/** Bars as drawn in one lane: each character is a cell in [0, width). A bar shorter than a cell is
 * a `•`/`●` marker so a 4 ms tool is still visible. Returns a string of exactly `width` cells. */
export declare function laneRow(timeline: Timeline, lane: "model" | "tools", width: number, glyphs: {
    empty: string;
    bar: string;
    marker: string;
}): string;
/** The axis label row, with each tick's label placed as close to its column as possible. */
export declare function axisRow(timeline: Timeline, width: number): string;
export declare function timelineRange(timeline: Timeline): string;
//# sourceMappingURL=timeline.d.ts.map