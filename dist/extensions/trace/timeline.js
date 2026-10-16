// The trace timeline (docs/trace-design.md §2.1, §4): two lanes, one shared scale. A step is a bar
// only when it has an observed/recorded span; a step with only an instant is a marker, never a bar
// stretched to look like one.
import { formatDuration, formatOffset } from "./format.js";
import { MAX_FUTURE_SKEW_MS } from "./project.js";
const MIN_WINDOW_MS = 1000;
function laneOf(step) {
    return step.kind === "model" ? "model" : "tools";
}
/** Bars and markers for a projection. User and event steps contribute markers on the nearest lane;
 * they never get a fabricated duration. */
export function buildTimeline(summary, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const bars = [];
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    const futureLimit = nowMs + MAX_FUTURE_SKEW_MS;
    for (const step of summary.steps) {
        if (step.kind === "unknown")
            continue;
        // A recorded instant far in the future must not stretch the scale; the step still lists.
        if (step.span === undefined && (step.atMs === undefined || step.atMs > futureLimit))
            continue;
        if (step.span !== undefined && step.span.startMs > futureLimit)
            continue;
        const lane = laneOf(step);
        if (step.span !== undefined) {
            const end = step.span.endMs ?? Math.max(step.span.startMs, nowMs);
            bars.push({
                id: step.id,
                kind: step.kind,
                lane,
                startMs: step.span.startMs,
                endMs: end,
                marker: step.span.endMs === undefined ? true : end === step.span.startMs,
                running: step.span.endMs === undefined,
                status: step.status,
            });
            startMs = Math.min(startMs, step.span.startMs);
            endMs = Math.max(endMs, end);
            continue;
        }
        if (step.atMs !== undefined) {
            bars.push({
                id: step.id,
                kind: step.kind,
                lane,
                startMs: step.atMs,
                endMs: step.atMs,
                marker: true,
                running: false,
                status: step.status,
            });
            startMs = Math.min(startMs, step.atMs);
            endMs = Math.max(endMs, step.atMs);
        }
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return { startMs: 0, endMs: 0, bars: [], ticks: [], empty: true };
    }
    // One instant (or a zero-width window) still needs a scale to draw on.
    if (endMs - startMs < MIN_WINDOW_MS)
        endMs = startMs + MIN_WINDOW_MS;
    const tickCount = Math.max(2, options.tickCount ?? 5);
    const span = endMs - startMs;
    const used = new Set();
    const ticks = [];
    for (let index = 0; index < tickCount; index += 1) {
        const atMs = startMs + Math.round((span * index) / (tickCount - 1));
        if (used.has(atMs))
            continue;
        used.add(atMs);
        ticks.push({ atMs, label: formatOffset(atMs, startMs) });
    }
    return { startMs, endMs, bars, ticks, empty: false };
}
/** Bars as drawn in one lane: each character is a cell in [0, width). A bar shorter than a cell is
 * a `•`/`●` marker so a 4 ms tool is still visible. Returns a string of exactly `width` cells. */
export function laneRow(timeline, lane, width, glyphs) {
    if (timeline.empty || width <= 0)
        return glyphs.empty.repeat(Math.max(0, width));
    const cells = Array(width).fill(glyphs.empty);
    const span = Math.max(1, timeline.endMs - timeline.startMs);
    for (const bar of timeline.bars) {
        if (bar.lane !== lane)
            continue;
        const from = Math.floor(((bar.startMs - timeline.startMs) / span) * width);
        const to = bar.marker
            ? from
            : Math.max(from, Math.ceil(((bar.endMs - timeline.startMs) / span) * width) - 1);
        if (from < 0 || from >= width)
            continue;
        if (to <= from)
            cells[Math.min(width - 1, from)] = bar.running ? glyphs.marker : glyphs.marker;
        else
            for (let at = from; at <= Math.min(width - 1, to); at += 1)
                cells[at] = glyphs.bar;
    }
    return cells.join("");
}
/** The axis label row, with each tick's label placed as close to its column as possible. */
export function axisRow(timeline, width) {
    if (timeline.empty || width <= 0)
        return "";
    const span = Math.max(1, timeline.endMs - timeline.startMs);
    const cells = Array(width).fill(" ");
    for (const tick of timeline.ticks) {
        const at = Math.floor(((tick.atMs - timeline.startMs) / span) * width);
        for (let index = 0; index < tick.label.length; index += 1) {
            const column = at + index;
            if (column >= width)
                break;
            cells[column] = tick.label[index];
        }
    }
    return cells.join("").trimEnd();
}
export function timelineRange(timeline) {
    if (timeline.empty)
        return "no timing recorded";
    return `${formatDuration(timeline.endMs - timeline.startMs)} total window`;
}
/** The 0-based grid column an instant falls in. */
export function columnOf(timeline, atMs, columns) {
    if (timeline.empty || columns <= 0)
        return 0;
    const span = Math.max(1, timeline.endMs - timeline.startMs);
    return Math.max(0, Math.min(columns - 1, Math.floor(((atMs - timeline.startMs) / span) * columns)));
}
/** The inclusive column range a span covers (a single column when it is an instant). */
export function columnRange(timeline, startMs, endMs, columns) {
    const from = columnOf(timeline, startMs, columns);
    const to = endMs <= startMs ? from : Math.max(from, columnOf(timeline, endMs, columns));
    return [from, to];
}
function worseTone(a, b) {
    const rank = { normal: 0, running: 1, error: 2 };
    return rank[b] > rank[a] ? b : a;
}
function toneOf(status) {
    if (status === "error" || status === "aborted")
        return "error";
    if (status === "running")
        return "running";
    return "normal";
}
/** The timeline as `columns` time buckets per lane, for a grid of filled/empty cells. A bar fills
 * every bucket it overlaps; active counts let the renderer show concurrency as stacked rows. */
export function buildGrid(timeline, columns) {
    const lanes = [
        { lane: "model", cells: Array.from({ length: columns }, () => ({ active: 0, tone: "normal" })) },
        { lane: "tools", cells: Array.from({ length: columns }, () => ({ active: 0, tone: "normal" })) },
    ];
    if (timeline.empty || columns <= 0)
        return lanes;
    for (const bar of timeline.bars) {
        const target = lanes.find((entry) => entry.lane === bar.lane);
        if (target === undefined)
            continue;
        const [from, to] = columnRange(timeline, bar.startMs, bar.endMs, columns);
        for (let column = from; column <= to; column += 1) {
            const cell = target.cells[column];
            cell.active += 1;
            cell.tone = worseTone(cell.tone, toneOf(bar.status));
        }
    }
    return lanes;
}
//# sourceMappingURL=timeline.js.map