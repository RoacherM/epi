// Completion flash (docs/tui-design.md 4.2 M4 "完成闪烁", docs/tui-motion-design.md M6): when a tool
// or thinking block finishes, its stretch of the turn spine (src/tui/spine.ts) lights up in `success`
// (or `error` if it failed), holds for 120ms, then eases out toward `borderMuted` and is gone at
// 400ms. The state lives on tool blocks (tools/group.ts) and thinking blocks (assistant-block.ts).
import type { Theme } from "@earendil-works/pi-coding-agent";

import { blend, type Blend } from "../motion.js";

const FLASH_MS = 400;
const HOLD_MS = 120;
// Redraws while fading; matches the turn status tick (chrome.ts), so the two never beat.
const FADE_STEP_MS = 80;

export interface FlashState {
  startedAt: number;
  until: number;
  tone: "success" | "error";
  timer: ReturnType<typeof setInterval> | undefined;
}

export function createFlashState(): FlashState {
  return { startedAt: 0, until: 0, tone: "success", timer: undefined };
}

/** Call once when the thing being tracked finishes. `requestRender` fires every fade step until
 * 400ms, so each fade frame -- and the final, non-flashing one -- is drawn even if nothing else
 * changes in the meantime. */
export function startFlash(state: FlashState, tone: "success" | "error", requestRender: () => void): void {
  if (state.timer !== undefined) clearInterval(state.timer);
  state.tone = tone;
  state.startedAt = Date.now();
  state.until = state.startedAt + FLASH_MS;
  state.timer = setInterval(() => {
    if (Date.now() >= state.until) {
      clearInterval(state.timer);
      state.until = 0;
      state.timer = undefined;
    }
    requestRender();
  }, FADE_STEP_MS);
  // Never hold the process open just to fade a color (e.g. Ctrl+D right after a tool finishes must
  // exit immediately, not wait out the flash).
  state.timer.unref?.();
}

export function isFlashing(state: FlashState, now = Date.now()): boolean {
  return now < state.until;
}

/** Cleared on dispose/reset so a stale timer never fires after its component is gone. */
export function disposeFlash(state: FlashState): void {
  if (state.timer !== undefined) clearInterval(state.timer);
  state.timer = undefined;
  state.until = 0;
}

/** The color of `state`'s flash right now: full tone while holding, then an ease-out toward
 * `borderMuted`. Only meaningful while `isFlashing(state)`. The turn spine paints its glyphs in it. */
export function flashBlend(state: FlashState, theme: Theme, now = Date.now()): Blend {
  const faded = Math.max(0, now - state.startedAt - HOLD_MS) / (FLASH_MS - HOLD_MS);
  return blend(theme, state.tone, "borderMuted", 1 - Math.exp(-4 * Math.min(1, faded)));
}
