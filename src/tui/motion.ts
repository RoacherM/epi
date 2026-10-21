// Shared motion primitives (docs/tui-motion-design.md §3): pure functions of a time `t` (seconds)
// that paint glyphs in a blend of two theme tokens. Colors come from the active Theme, so the night
// and day palettes both work, and Theme's own color mode decides truecolor vs 256-color output.
// Nothing here owns a timer: callers redraw on an existing tick (TurnStatus) or a self-stopping one
// (`FrameTicker`).
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { piTui } from "./pi-tui.js";

export type MotionTheme = Pick<Theme, "colors" | "fg" | "getColorMode">;

/** A painter for the color `amount` of the way from token `from` to token `to` (0 = from,
 * 1 = to); `key` is equal for equal colors, so cells can be painted in runs. */
export interface Blend {
  key: string;
  paint(text: string): string;
}

export function blend(theme: MotionTheme, from: ThemeColor, to: ThemeColor, amount: number): Blend {
  const clamped = Math.max(0, Math.min(1, amount));
  if (clamped === 0) return { key: from, paint: (text) => theme.fg(from, text) };
  if (clamped === 1) return { key: to, paint: (text) => theme.fg(to, text) };
  const open = piTui.foregroundAnsi(piTui.mixColors(theme.colors[from], theme.colors[to], clamped, "srgb"), theme.getColorMode());
  return { key: open, paint: (text) => `${open}${text}\x1b[39m` };
}

/** `text` in the blend of `from` and `to` (see `blend`). */
export function blendFg(theme: MotionTheme, from: ThemeColor, to: ThemeColor, amount: number, text: string): string {
  return blend(theme, from, to, amount).paint(text);
}

/** Glyphs painted one color code per run of equal colors, not one per glyph; an undefined blend
 * leaves its glyph unpainted. */
export function paintRuns(cells: readonly { glyph: string; blend: Blend | undefined }[]): string {
  let out = "";
  let run = "";
  let current: Blend | undefined;
  const flush = () => {
    out += current === undefined ? run : current.paint(run);
    run = "";
  };
  for (const cell of cells) {
    if (run !== "" && cell.blend?.key !== current?.key) flush();
    current = cell.blend;
    run += cell.glyph;
  }
  if (run !== "") flush();
  return out;
}

/** A bell curve: 1 at distance 0, ~0.37 at distance `spread`. */
export function gaussian(distance: number, spread: number): number {
  const d = distance / spread;
  return Math.exp(-d * d);
}

/** Two highlights sweeping a `width`-column rule in opposite directions; `━` under a highlight,
 * `─` elsewhere, so the rule keeps its line geometry. `phase` offsets one rule from another;
 * `strength` scales the highlights (0 draws the plain `borderMuted` rule). */
export function pulseRule(theme: MotionTheme, width: number, t: number, phase = 0, strength = 1): string {
  const span = width + 24;
  const forward = ((t * 28 + phase) % span) - 12;
  const backward = width - (((t * 20 + span / 2 + phase) % span) - 12);
  const cells = [];
  for (let x = 0; x < width; x += 1) {
    const a = gaussian(x - forward, 5.5) * strength;
    const b = gaussian(x - backward, 5.5) * strength;
    const intensity = Math.max(a, b);
    // Far from both highlights the rule is plain borderMuted: those cells join one run.
    const amount = intensity < 0.02 ? 0 : intensity;
    cells.push({ glyph: intensity > 0.55 ? "━" : "─", blend: blend(theme, "borderMuted", a >= b ? "accent" : "syntaxFunction", amount) });
  }
  return paintRuns(cells);
}

// Rows between two pulses on a running rail; the pulse repeats down a block of any length.
const RAIL_PERIOD = 8;

/** Column 0 of a running block's `row`: `┃` whose color a pulse slides down, accent to thinkingHigh. */
export function railGlyph(theme: MotionTheme, row: number, t: number): string {
  const head = (t * 6) % RAIL_PERIOD;
  const offset = Math.abs(row % RAIL_PERIOD - head);
  const distance = Math.min(offset, RAIL_PERIOD - offset);
  return blendFg(theme, "accent", "thinkingHigh", gaussian(distance, 1.2), "┃");
}

/** A glyph breathing between `from` and `to` about once a second (a running group's `◈`). */
export function breathe(theme: MotionTheme, from: ThemeColor, to: ThemeColor, t: number, text: string): string {
  return blendFg(theme, from, to, 0.5 - 0.5 * Math.cos(t * Math.PI * 2), text);
}

/** Seconds on the shared motion clock. One clock keeps every rail and spinner in step. */
export function motionTime(now = Date.now()): number {
  return now / 1000;
}

/**
 * A redraw timer that stops itself once nothing draws the component any more (docs/tui-motion-
 * design.md §3.2): `rendered()` is called from render(); a tick that finds no render since the last
 * tick clears the interval. The welcome page uses it -- after the first message the transcript
 * stops rendering the header, so the timer stops one tick later; a later render starts it again.
 */
export class FrameTicker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private renderedSinceTick = false;

  constructor(
    private readonly intervalMs: number,
    private readonly requestRender: () => void,
  ) {}

  rendered(): void {
    this.renderedSinceTick = true;
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (!this.renderedSinceTick) {
        this.stop();
        return;
      }
      this.renderedSinceTick = false;
      this.requestRender();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.renderedSinceTick = false;
  }
}
