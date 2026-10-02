// Completion flash (docs/tui-design.md 4.2 M4 "完成闪烁"): when a tool or thinking block finishes,
// its rail flashes once in `success` color (or `error` if it failed) for 400ms, then settles back to
// normal. Shared by tool blocks (tools/group.ts) and thinking blocks (assistant-block.ts).
import type { Theme } from "@earendil-works/pi-coding-agent";

const FLASH_MS = 400;

export interface FlashState {
  until: number;
  tone: "success" | "error";
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createFlashState(): FlashState {
  return { until: 0, tone: "success", timer: undefined };
}

/** Call once when the thing being tracked finishes. `requestRender` fires after 400ms so the
 * final (non-flashing) frame actually gets drawn even if nothing else changes in the meantime. */
export function startFlash(state: FlashState, tone: "success" | "error", requestRender: () => void): void {
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.tone = tone;
  state.until = Date.now() + FLASH_MS;
  state.timer = setTimeout(() => {
    state.until = 0;
    state.timer = undefined;
    requestRender();
  }, FLASH_MS);
  // Never hold the process open just to clear a color after 400ms (e.g. Ctrl+D right after a tool
  // finishes must exit immediately, not wait out the flash).
  state.timer.unref?.();
}

export function isFlashing(state: FlashState): boolean {
  return Date.now() < state.until;
}

/** Cleared on dispose/reset so a stale timer never fires after its component is gone. */
export function disposeFlash(state: FlashState): void {
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.timer = undefined;
  state.until = 0;
}

/**
 * Recolors column 0 of each line from a blank rail to `tone`'s "┃". Only lines that start with a
 * plain, uncolored space are touched -- that's the rail column a settled tool/thinking block leaves
 * blank -- so an already-colored running rail, or an image escape line, passes through untouched.
 * Unconditional: callers that already know they want the paint (e.g. a group line combining several
 * members' flash states) use this directly; `paintFlashRail` below is the single-state shortcut.
 */
export function paintRailTone(lines: string[], tone: "success" | "error", theme: Theme): string[] {
  const bar = theme.fg(tone, "┃");
  return lines.map((line) => (line.startsWith(" ") ? bar + line.slice(1) : line));
}

/** Recolors column 0 for the 400ms `state` is flashing, otherwise returns `lines` unchanged. */
export function paintFlashRail(lines: string[], state: FlashState, theme: Theme): string[] {
  return isFlashing(state) ? paintRailTone(lines, state.tone, theme) : lines;
}
