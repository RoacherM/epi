import { piTui } from "./pi-tui.js";
export function blend(theme, from, to, amount) {
    const clamped = Math.max(0, Math.min(1, amount));
    if (clamped === 0)
        return { key: from, paint: (text) => theme.fg(from, text) };
    if (clamped === 1)
        return { key: to, paint: (text) => theme.fg(to, text) };
    const open = piTui.foregroundAnsi(piTui.mixColors(theme.colors[from], theme.colors[to], clamped, "srgb"), theme.getColorMode());
    return { key: open, paint: (text) => `${open}${text}\x1b[39m` };
}
/** `text` in the blend of `from` and `to` (see `blend`). */
export function blendFg(theme, from, to, amount, text) {
    return blend(theme, from, to, amount).paint(text);
}
/** Glyphs painted one color code per run of equal colors, not one per glyph; an undefined blend
 * leaves its glyph unpainted. */
export function paintRuns(cells) {
    let out = "";
    let run = "";
    let current;
    const flush = () => {
        out += current === undefined ? run : current.paint(run);
        run = "";
    };
    for (const cell of cells) {
        if (run !== "" && cell.blend?.key !== current?.key)
            flush();
        current = cell.blend;
        run += cell.glyph;
    }
    if (run !== "")
        flush();
    return out;
}
/** A bell curve: 1 at distance 0, ~0.37 at distance `spread`. */
export function gaussian(distance, spread) {
    const d = distance / spread;
    return Math.exp(-d * d);
}
/** Two highlights sweeping a `width`-column rule in opposite directions; `━` under a highlight,
 * `─` elsewhere, so the rule keeps its line geometry. `phase` offsets one rule from another;
 * `strength` scales the highlights (0 draws the plain `borderMuted` rule). */
export function pulseRule(theme, width, t, phase = 0, strength = 1) {
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
/** The color of a running rail's `row` at `t`: a pulse slides down it, accent to thinkingHigh,
 * repeating every RAIL_PERIOD rows. The turn spine (src/tui/spine.ts) paints its live glyphs in it. */
export function railBlend(theme, row, t) {
    const head = (t * 6) % RAIL_PERIOD;
    const offset = Math.abs(row % RAIL_PERIOD - head);
    const distance = Math.min(offset, RAIL_PERIOD - offset);
    return blend(theme, "accent", "thinkingHigh", gaussian(distance, 1.2));
}
/** A running rail's `row`: `┃` in `railBlend`'s color. */
export function railGlyph(theme, row, t) {
    return railBlend(theme, row, t).paint("┃");
}
/** A glyph breathing between `from` and `to` about once a second (a running group's `◈`). */
export function breathe(theme, from, to, t, text) {
    return blendFg(theme, from, to, 0.5 - 0.5 * Math.cos(t * Math.PI * 2), text);
}
/** Seconds on the shared motion clock. One clock keeps every rail and spinner in step. */
export function motionTime(now = Date.now()) {
    return now / 1000;
}
/**
 * A redraw timer that stops itself once nothing draws the component any more (docs/tui-motion-
 * design.md §3.2): `rendered()` is called from render(); a tick that finds no render since the last
 * tick clears the interval. The welcome page uses it -- after the first message the transcript
 * stops rendering the header, so the timer stops one tick later; a later render starts it again.
 */
export class FrameTicker {
    intervalMs;
    requestRender;
    timer;
    renderedSinceTick = false;
    constructor(intervalMs, requestRender) {
        this.intervalMs = intervalMs;
        this.requestRender = requestRender;
    }
    rendered() {
        this.renderedSinceTick = true;
        if (this.timer !== undefined)
            return;
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
    get running() {
        return this.timer !== undefined;
    }
    stop() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
        this.renderedSinceTick = false;
    }
}
//# sourceMappingURL=motion.js.map