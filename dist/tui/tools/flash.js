export const FLASH_MS = 400;
export function createFlashState() {
    return { until: 0, tone: "success", timer: undefined };
}
/** Call once when the thing being tracked finishes. `requestRender` fires after 400ms so the
 * final (non-flashing) frame actually gets drawn even if nothing else changes in the meantime. */
export function startFlash(state, tone, requestRender) {
    if (state.timer !== undefined)
        clearTimeout(state.timer);
    state.tone = tone;
    state.until = Date.now() + FLASH_MS;
    state.timer = setTimeout(() => {
        state.until = 0;
        state.timer = undefined;
        requestRender();
    }, FLASH_MS);
}
export function isFlashing(state) {
    return Date.now() < state.until;
}
/** Cleared on dispose/reset so a stale timer never fires after its component is gone. */
export function disposeFlash(state) {
    if (state.timer !== undefined)
        clearTimeout(state.timer);
    state.timer = undefined;
    state.until = 0;
}
/**
 * Recolors column 0 of each line from a blank rail to the flash tone's "┃", for the 400ms after
 * something finishes. Only lines that start with a plain, uncolored space are touched -- that's
 * the rail column a settled tool/thinking block leaves blank -- so an already-colored running rail,
 * or an image escape line, passes through untouched.
 */
export function paintFlashRail(lines, state, theme) {
    if (!isFlashing(state))
        return lines;
    const bar = theme.fg(state.tone, "┃");
    return lines.map((line) => (line.startsWith(" ") ? bar + line.slice(1) : line));
}
//# sourceMappingURL=flash.js.map