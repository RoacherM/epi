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
/** One cell of the grid timeline: how many spans are active in that time bucket, and the worst
 * status among them. Rendered as a GitHub-like block when active. */
export interface GridCell {
    active: number;
    tone: "normal" | "running" | "error";
}
export interface GridLane {
    lane: "model" | "tools";
    cells: GridCell[];
}
/** The 0-based grid column an instant falls in. */
export declare function columnOf(timeline: Timeline, atMs: number, columns: number): number;
/** The inclusive column range a span covers (a single column when it is an instant). */
export declare function columnRange(timeline: Timeline, startMs: number, endMs: number, columns: number): [number, number];
/** The timeline as `columns` time buckets per lane, for a grid of filled/empty cells. A bar fills
 * every bucket it overlaps; active counts let the renderer show concurrency as stacked rows. */
export declare function buildGrid(timeline: Timeline, columns: number): GridLane[];
//# sourceMappingURL=timeline.d.ts.map