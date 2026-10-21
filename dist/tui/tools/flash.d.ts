import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Blend } from "../motion.js";
export interface FlashState {
    startedAt: number;
    until: number;
    tone: "success" | "error";
    timer: ReturnType<typeof setInterval> | undefined;
}
export declare function createFlashState(): FlashState;
/** Call once when the thing being tracked finishes. `requestRender` fires every fade step until
 * 400ms, so each fade frame -- and the final, non-flashing one -- is drawn even if nothing else
 * changes in the meantime. */
export declare function startFlash(state: FlashState, tone: "success" | "error", requestRender: () => void): void;
export declare function isFlashing(state: FlashState, now?: number): boolean;
/** Cleared on dispose/reset so a stale timer never fires after its component is gone. */
export declare function disposeFlash(state: FlashState): void;
/** The color of `state`'s flash right now: full tone while holding, then an ease-out toward
 * `borderMuted`. Only meaningful while `isFlashing(state)`. The turn spine paints its glyphs in it. */
export declare function flashBlend(state: FlashState, theme: Theme, now?: number): Blend;
//# sourceMappingURL=flash.d.ts.map