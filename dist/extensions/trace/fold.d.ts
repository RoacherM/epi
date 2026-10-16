export interface FoldedTimeline {
    /** The column for a time, clamped to [0, units). */
    columnOf: (atMs: number) => number;
    /** Columns that stand for folded (skipped) idle time. */
    skipped: Set<number>;
}
/** Map activity times onto `units` columns. Gaps longer than `cap` become one marked column; other
 * gaps take no column. The merged intervals span only activity, so nothing is wasted on idle. */
export declare function foldTimeline(intervals: ReadonlyArray<[number, number]>, units: number, cap?: number): FoldedTimeline;
//# sourceMappingURL=fold.d.ts.map