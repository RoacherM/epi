import type { Theme } from "@earendil-works/pi-coding-agent";
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
/** The rail glyph for `state` right now: full tone while holding, then an ease-out toward
 * `borderMuted`. Only meaningful while `isFlashing(state)`. */
export declare function flashRail(state: FlashState, theme: Theme, now?: number): string;
/**
 * Puts `rail` in column 0 of each line. Only lines that start with a plain, uncolored space are
 * touched -- that's the rail column a settled tool/thinking block leaves blank -- so an
 * already-colored running rail, or an image escape line, passes through untouched.
 */
export declare function paintRail(lines: string[], rail: string): string[];
/** Paints the fading rail for the 400ms `state` is flashing, otherwise returns `lines` unchanged. */
export declare function paintFlashRail(lines: string[], state: FlashState, theme: Theme): string[];
//# sourceMappingURL=flash.d.ts.map