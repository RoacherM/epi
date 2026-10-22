// The time a running duration bar shows (docs/tui-one-column-design.md §2.2). Outside the transcript's
// last TIP_ROWS rows a running block is drawn at the time it last showed inside them, so the bar holds
// still while everything else about the block (arguments, output, the result) still redraws
// (spine.ts ClockGated). Only the clock is held: nothing is cached, so no event can be missed.

let heldAt: number | undefined;

/** Now, or the held time while a block outside the tip is being drawn. */
export function displayNow(): number {
  return heldAt ?? Date.now();
}

/** `draw()` with displayNow() reading `at` (undefined: the real time). */
export function drawAt<T>(at: number | undefined, draw: () => T): T {
  const previous = heldAt;
  heldAt = at;
  try {
    return draw();
  } finally {
    heldAt = previous;
  }
}
