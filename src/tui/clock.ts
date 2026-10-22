// The time a running duration bar shows (docs/tui-one-column-design.md §2.2). Outside the transcript's
// last TIP_ROWS rows a running block is drawn at the time it last showed inside them, so the bar holds
// still while everything else about the block (arguments, output, the result) still redraws
// (spine.ts ClockGated). Only the clock is held: nothing is cached, so no event can be missed.

let held: { at: number | undefined } | undefined;

/** Now, or the held time while a block outside the tip is being drawn. */
export function displayNow(): number {
  return held?.at ?? Date.now();
}

/** Whether the block being drawn is outside the tip, where nothing may move with the clock alone:
 * a landing shake (glyphs.ts) only plays inside it. */
export function clockHeld(): boolean {
  return held !== undefined;
}

/** `draw()` as a block outside the tip: displayNow() reads `at` (undefined: the real time). */
export function drawAt<T>(at: number | undefined, draw: () => T): T {
  const previous = held;
  held = { at };
  try {
    return draw();
  } finally {
    held = previous;
  }
}
