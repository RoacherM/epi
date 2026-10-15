// The trace timeline (docs/trace-design.md §2.1, §4): two lanes, one shared scale. A step is a bar
// only when it has an observed/recorded span; a step with only an instant is a marker, never a bar
// stretched to look like one.
import { formatDuration, formatOffset } from "./format.js";
import { MAX_FUTURE_SKEW_MS } from "./project.js";
import type { TraceBar, TraceStep, TraceSummary } from "./types.js";

export interface Timeline {
  startMs: number;
  endMs: number;
  bars: TraceBar[];
  /** Evenly spaced labels along the axis. */
  ticks: Array<{ atMs: number; label: string }>;
  /** Nothing has any timing to show. */
  empty: boolean;
}

export interface TimelineOptions {
  /** Wall clock "now", so a still-running span can reach the right edge honestly. */
  nowMs?: number;
  /** How many axis labels to aim for. */
  tickCount?: number;
}

const MIN_WINDOW_MS = 1000;

function laneOf(step: TraceStep): "model" | "tools" {
  return step.kind === "model" ? "model" : "tools";
}

/** Bars and markers for a projection. User and event steps contribute markers on the nearest lane;
 * they never get a fabricated duration. */
export function buildTimeline(summary: TraceSummary, options: TimelineOptions = {}): Timeline {
  const nowMs = options.nowMs ?? Date.now();
  const bars: TraceBar[] = [];
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  const futureLimit = nowMs + MAX_FUTURE_SKEW_MS;

  for (const step of summary.steps) {
    if (step.kind === "unknown") continue;
    // A recorded instant far in the future must not stretch the scale; the step still lists.
    if (step.span === undefined && (step.atMs === undefined || step.atMs > futureLimit)) continue;
    if (step.span !== undefined && step.span.startMs > futureLimit) continue;
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
  if (endMs - startMs < MIN_WINDOW_MS) endMs = startMs + MIN_WINDOW_MS;

  const tickCount = Math.max(2, options.tickCount ?? 5);
  const span = endMs - startMs;
  const used = new Set<number>();
  const ticks: Array<{ atMs: number; label: string }> = [];
  for (let index = 0; index < tickCount; index += 1) {
    const atMs = startMs + Math.round((span * index) / (tickCount - 1));
    if (used.has(atMs)) continue;
    used.add(atMs);
    ticks.push({ atMs, label: formatOffset(atMs, startMs) });
  }
  return { startMs, endMs, bars, ticks, empty: false };
}

/** Bars as drawn in one lane: each character is a cell in [0, width). A bar shorter than a cell is
 * a `•`/`●` marker so a 4 ms tool is still visible. Returns a string of exactly `width` cells. */
export function laneRow(timeline: Timeline, lane: "model" | "tools", width: number, glyphs: { empty: string; bar: string; marker: string }): string {
  if (timeline.empty || width <= 0) return glyphs.empty.repeat(Math.max(0, width));
  const cells = Array<string>(width).fill(glyphs.empty);
  const span = Math.max(1, timeline.endMs - timeline.startMs);
  for (const bar of timeline.bars) {
    if (bar.lane !== lane) continue;
    const from = Math.floor(((bar.startMs - timeline.startMs) / span) * width);
    const to = bar.marker
      ? from
      : Math.max(from, Math.ceil(((bar.endMs - timeline.startMs) / span) * width) - 1);
    if (from < 0 || from >= width) continue;
    if (to <= from) cells[Math.min(width - 1, from)] = bar.running ? glyphs.marker : glyphs.marker;
    else for (let at = from; at <= Math.min(width - 1, to); at += 1) cells[at] = glyphs.bar;
  }
  return cells.join("");
}

/** The axis label row, with each tick's label placed as close to its column as possible. */
export function axisRow(timeline: Timeline, width: number): string {
  if (timeline.empty || width <= 0) return "";
  const span = Math.max(1, timeline.endMs - timeline.startMs);
  const cells = Array<string>(width).fill(" ");
  for (const tick of timeline.ticks) {
    const at = Math.floor(((tick.atMs - timeline.startMs) / span) * width);
    for (let index = 0; index < tick.label.length; index += 1) {
      const column = at + index;
      if (column >= width) break;
      cells[column] = tick.label[index]!;
    }
  }
  return cells.join("").trimEnd();
}

export function timelineRange(timeline: Timeline): string {
  if (timeline.empty) return "no timing recorded";
  return `${formatDuration(timeline.endMs - timeline.startMs)} total window`;
}
