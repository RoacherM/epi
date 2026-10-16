// Folding for /trace's dot matrix: a session's visible steps can be separated by long idle gaps
// (a pause between turns, or time with no recorded span), which would leave a wide blank in the
// row. Fold each long gap to a single marked column, give every activity cluster columns in
// proportion to its duration (at least one), and let short gaps take no column at all, so activity
// is never squeezed out by idle. Pure number math, unit-tested directly.

export interface FoldedTimeline {
  /** The column for a time, clamped to [0, units). */
  columnOf: (atMs: number) => number;
  /** Columns that stand for folded (skipped) idle time. */
  skipped: Set<number>;
}

interface Segment {
  kind: "activity" | "gap";
  from: number;
  to: number;
  skipped: boolean;
}

/** Merge overlapping or touching intervals into disjoint ones, in order. */
function mergeIntervals(intervals: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Map activity times onto `units` columns. Gaps longer than `cap` become one marked column; other
 * gaps take no column. The merged intervals span only activity, so nothing is wasted on idle. */
export function foldTimeline(intervals: ReadonlyArray<[number, number]>, units: number, cap = 500): FoldedTimeline {
  const merged = mergeIntervals(intervals);
  if (merged.length === 0) return { columnOf: () => 0, skipped: new Set() };

  const segments: Segment[] = [];
  let previous = merged[0]![0];
  for (const [from, to] of merged) {
    if (from > previous) segments.push({ kind: "gap", from: previous, to: from, skipped: from - previous > cap });
    segments.push({ kind: "activity", from, to, skipped: false });
    previous = Math.max(previous, to);
  }

  const skippedCount = segments.filter((segment) => segment.kind === "gap" && segment.skipped).length;
  const free = Math.max(1, units - skippedCount);
  const activeDuration = segments.reduce((sum, segment) => (segment.kind === "activity" ? sum + (segment.to - segment.from) : sum), 0) || 1;

  const ranges: Array<{ segment: Segment; start: number; end: number }> = [];
  const skipped = new Set<number>();
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
    if (segment.kind === "gap") skipped.add(start);
    column = end;
  }

  const mapActivity = (range: { segment: Segment; start: number; end: number }, atMs: number): number => {
    const width = range.segment.to - range.segment.from || 1;
    const span = range.end - range.start || 1;
    const offset = Math.min(span - 1, Math.max(0, Math.floor(((atMs - range.segment.from) / width) * span)));
    return Math.max(0, Math.min(units - 1, range.start + offset));
  };
  const columnOf = (atMs: number): number => {
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      const last = index === ranges.length - 1;
      if (range.segment.kind === "gap") {
        // A gap owns only the times strictly inside it; its end belongs to the next activity.
        if (atMs < range.segment.to) return Math.max(0, Math.min(units - 1, range.start));
        continue;
      }
      if (atMs <= range.segment.to || last) return mapActivity(range, Math.min(atMs, range.segment.to));
    }
    return units - 1;
  };
  return { columnOf, skipped };
}
