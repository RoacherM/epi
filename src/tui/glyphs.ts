// One table of glyphs for the transcript and /trace, and the rotating x that marks something running
// (docs/tui-glyphs-design.md). Every glyph is one cell wide; no emoji (⚙ is drawn two cells wide by
// some terminals).
//
// The marker column of a call shows its state: a dim `+` while it waits, a `+`/`×` turning evenly
// while it runs, two quick shakes when it lands, then its kind glyph -- or a red `×` if it failed.
// A frame is a pure function of the time, read from clock.ts, so a block the turn spine holds still
// outside its tip (spine.ts ClockGated) holds its marker still too, and never shakes there.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { clockHeld, displayNow } from "./clock.js";

export const GLYPHS = {
  user: "❯",
  /** Thinking and replies; paired with the tools' filled `◆`. */
  model: "◇",
  shell: "$",
  tool: "◆",
  group: "◈",
  event: "·",
} as const;

/** Epi's animation tick (chrome.ts MOTION_TICK_MS). */
export const TICK_MS = 80;
// A quarter turn (`+` to `×`) every 4 ticks, evenly.
const TURN_TICKS = 4;
const SHAKE = ["×", "+", "×", "+"] as const;
/** How long the landing shake takes: one tick a frame. */
export const LANDING_MS = SHAKE.length * TICK_MS;
/** Ticks between the phases of calls that start one after another, so they don't turn in step. */
const PHASE_STEP = 2;

/** The rotating x at `now`, `phase` ticks ahead. */
export function spinFrame(now: number, phase = 0): "+" | "×" {
  return Math.floor((Math.floor(now / TICK_MS) + phase) / TURN_TICKS) % 2 === 0 ? "+" : "×";
}

/** The landing frame at `now` for something that ended at `endedAt`, or undefined once it settled. */
export function landingFrame(now: number, endedAt: number | undefined): "+" | "×" | undefined {
  if (endedAt === undefined || now < endedAt) return undefined;
  return SHAKE[Math.floor((now - endedAt) / TICK_MS)];
}

let nextPhase = 0;

/** The phase for the next call that starts running: each one PHASE_STEP ticks after the last. */
export function takePhase(): number {
  const phase = nextPhase;
  nextPhase = (nextPhase + PHASE_STEP) % (TURN_TICKS * 2);
  return phase;
}

export type MarkerState = "pending" | "running" | "done" | "error";

export interface Marker {
  state: MarkerState;
  /** The glyph once settled (`$`, `◆`, `◈`, `◇`). */
  glyph: string;
  /** Its colour once settled. */
  color: ThemeColor;
  /** Settled with a failure: the glyph a failure settles on, default a red `×`. */
  failedGlyph?: string;
  /** When it ended, if it was seen running: it shakes for LANDING_MS after this. */
  endedAt?: number | undefined;
  phase?: number | undefined;
  /** Drawn before every frame but the settled glyph, which it is part of: `!` for `!!` (a `!!cmd` turns
   * as `!+`/`!×`), so the row never changes width and still says what it is. */
  lead?: string;
}

/** `marker` painted at `now`. The landing shake plays only while `landing` (a block in the tip). */
export function paintMarker(theme: Pick<Theme, "fg">, marker: Marker, now = displayNow(), landing = !clockHeld()): string {
  const { state, glyph, color, endedAt, phase = 0, lead = "" } = marker;
  const frame = (text: string) => lead + text;
  if (state === "pending") return theme.fg("dim", frame("+"));
  if (state === "running") return theme.fg("accent", frame(spinFrame(now, phase)));
  const shake = landing ? landingFrame(now, endedAt) : undefined;
  if (shake !== undefined) return theme.fg(state === "error" ? "error" : "accent", frame(shake));
  return state === "error" ? theme.fg("error", marker.failedGlyph ?? frame("×")) : theme.fg(color, glyph);
}

/** Redraws every tick until a landing that starts now has played, for a block nothing else redraws
 * then (a `!cmd` alone has no turn status ticking). */
export function renderThroughLanding(requestRender: () => void): void {
  const until = Date.now() + LANDING_MS + TICK_MS;
  const timer = setInterval(() => {
    requestRender();
    if (Date.now() >= until) clearInterval(timer);
  }, TICK_MS);
  timer.unref?.();
}
