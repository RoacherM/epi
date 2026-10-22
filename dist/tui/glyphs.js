import { clockHeld, displayNow } from "./clock.js";
export const GLYPHS = {
    user: "❯",
    /** Thinking and replies; paired with the tools' filled `◆`. */
    model: "◇",
    shell: "$",
    tool: "◆",
    group: "◈",
    event: "·",
};
/** Epi's animation tick (chrome.ts MOTION_TICK_MS). */
export const TICK_MS = 80;
// A quarter turn (`+` to `×`) every 4 ticks, evenly.
const TURN_TICKS = 4;
const SHAKE = ["×", "+", "×", "+"];
/** How long the landing shake takes: one tick a frame. */
export const LANDING_MS = SHAKE.length * TICK_MS;
/** Ticks between the phases of calls that start one after another, so they don't turn in step. */
const PHASE_STEP = 2;
/** The rotating x at `now`, `phase` ticks ahead. */
export function spinFrame(now, phase = 0) {
    return Math.floor((Math.floor(now / TICK_MS) + phase) / TURN_TICKS) % 2 === 0 ? "+" : "×";
}
/** The landing frame at `now` for something that ended at `endedAt`, or undefined once it settled. */
export function landingFrame(now, endedAt) {
    if (endedAt === undefined || now < endedAt)
        return undefined;
    return SHAKE[Math.floor((now - endedAt) / TICK_MS)];
}
let nextPhase = 0;
/** The phase for the next call that starts running: each one PHASE_STEP ticks after the last. */
export function takePhase() {
    const phase = nextPhase;
    nextPhase = (nextPhase + PHASE_STEP) % (TURN_TICKS * 2);
    return phase;
}
/** `marker` painted at `now`. The landing shake plays only while `landing` (a block in the tip). */
export function paintMarker(theme, marker, now = displayNow(), landing = !clockHeld()) {
    const { state, glyph, color, endedAt, phase = 0, lead = "" } = marker;
    const frame = (text) => lead + text;
    if (state === "pending")
        return theme.fg("dim", frame("+"));
    if (state === "running")
        return theme.fg("accent", frame(spinFrame(now, phase)));
    const shake = landing ? landingFrame(now, endedAt) : undefined;
    if (shake !== undefined)
        return theme.fg(state === "error" ? "error" : "accent", frame(shake));
    return state === "error" ? theme.fg("error", marker.failedGlyph ?? frame("×")) : theme.fg(color, glyph);
}
/** Redraws every tick until a landing that starts now has played, for a block nothing else redraws
 * then (a `!cmd` alone has no turn status ticking). */
export function renderThroughLanding(requestRender) {
    const until = Date.now() + LANDING_MS + TICK_MS;
    const timer = setInterval(() => {
        requestRender();
        if (Date.now() >= until)
            clearInterval(timer);
    }, TICK_MS);
    timer.unref?.();
}
//# sourceMappingURL=glyphs.js.map