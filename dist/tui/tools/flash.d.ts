import type { Theme } from "@earendil-works/pi-coding-agent";
export declare const FLASH_MS = 400;
export interface FlashState {
    until: number;
    tone: "success" | "error";
    timer: ReturnType<typeof setTimeout> | undefined;
}
export declare function createFlashState(): FlashState;
/** Call once when the thing being tracked finishes. `requestRender` fires after 400ms so the
 * final (non-flashing) frame actually gets drawn even if nothing else changes in the meantime. */
export declare function startFlash(state: FlashState, tone: "success" | "error", requestRender: () => void): void;
export declare function isFlashing(state: FlashState): boolean;
/** Cleared on dispose/reset so a stale timer never fires after its component is gone. */
export declare function disposeFlash(state: FlashState): void;
/**
 * Recolors column 0 of each line from a blank rail to `tone`'s "┃". Only lines that start with a
 * plain, uncolored space are touched -- that's the rail column a settled tool/thinking block leaves
 * blank -- so an already-colored running rail, or an image escape line, passes through untouched.
 * Unconditional: callers that already know they want the paint (e.g. a group line combining several
 * members' flash states) use this directly; `paintFlashRail` below is the single-state shortcut.
 */
export declare function paintRailTone(lines: string[], tone: "success" | "error", theme: Theme): string[];
/** Recolors column 0 for the 400ms `state` is flashing, otherwise returns `lines` unchanged. */
export declare function paintFlashRail(lines: string[], state: FlashState, theme: Theme): string[];
//# sourceMappingURL=flash.d.ts.map