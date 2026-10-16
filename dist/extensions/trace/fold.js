// Folding for /trace's dot matrix: a session's visible steps can be separated by long idle gaps
// (a pause between turns, or time with no recorded span), which would leave a wide blank in the
// row. Fold each long gap to a single marked column, give every activity cluster columns in
// proportion to its duration (at least one), and let short gaps take no column at all, so activity
// is never squeezed out by idle. Pure number math, unit-tested directly.
/** Merge overlapping or touching intervals into disjoint ones, in order. */
function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [from, to] of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && from <= last[1] + 1)
            last[1] = Math.max(last[1], to);
        else
            merged.push([from, to]);
    }
    return merged;
}
/** Map activity times onto `units` columns. Gaps longer than `cap` become one marked column; other
 * gaps take no column. The merged intervals span only activity, so nothing is wasted on idle. */
export function foldTimeline(intervals, units, cap = 500) {
    const merged = mergeIntervals(intervals);
    if (merged.length === 0)
        return { columnOf: () => 0, skipped: new Set() };
    const segments = [];
    let previous = merged[0][0];
    for (const [from, to] of merged) {
        if (from > previous)
            segments.push({ kind: "gap", from: previous, to: from, skipped: from - previous > cap });
        segments.push({ kind: "activity", from, to, skipped: false });
        previous = Math.max(previous, to);
    }
    const skippedCount = segments.filter((segment) => segment.kind === "gap" && segment.skipped).length;
    const free = Math.max(1, units - skippedCount);
    const activeDuration = segments.reduce((sum, segment) => (segment.kind === "activity" ? sum + (segment.to - segment.from) : sum), 0) || 1;
    const ranges = [];
    const skipped = new Set();
    let column = 0;
    for (const segment of segments) {
        if (segment.kind === "gap" && !segment.skipped) {
            ranges.push({ segment, start: column, end: column });
            continue;
        }
        const width = segment.kind === "gap" ? 1 : Math.max(1, Math.round(((segment.to - segment.from) / activeDuration) * free));
        const start = column;
        const end = Math.max(start + 1, Math.min(units, column + width));
        ranges.push({ segment, start, end });
        if (segment.kind === "gap")
            skipped.add(start);
        column = end;
    }
    const mapActivity = (range, atMs) => {
        const width = range.segment.to - range.segment.from || 1;
        const span = range.end - range.start || 1;
        const offset = Math.min(span - 1, Math.max(0, Math.floor(((atMs - range.segment.from) / width) * span)));
        return Math.max(0, Math.min(units - 1, range.start + offset));
    };
    const columnOf = (atMs) => {
        for (let index = 0; index < ranges.length; index += 1) {
            const range = ranges[index];
            const last = index === ranges.length - 1;
            if (range.segment.kind === "gap") {
                // A gap owns only the times strictly inside it; its end belongs to the next activity.
                if (atMs < range.segment.to)
                    return Math.max(0, Math.min(units - 1, range.start));
                continue;
            }
            if (atMs <= range.segment.to || last)
                return mapActivity(range, Math.min(atMs, range.segment.to));
        }
        return units - 1;
    };
    return { columnOf, skipped };
}
//# sourceMappingURL=fold.js.map