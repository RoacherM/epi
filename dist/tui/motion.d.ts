import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
export type MotionTheme = Pick<Theme, "colors" | "fg" | "getColorMode">;
/** A painter for the color `amount` of the way from token `from` to token `to` (0 = from,
 * 1 = to); `key` is equal for equal colors, so cells can be painted in runs. */
export interface Blend {
    key: string;
    paint(text: string): string;
}
export declare function blend(theme: MotionTheme, from: ThemeColor, to: ThemeColor, amount: number): Blend;
/** `text` in the blend of `from` and `to` (see `blend`). */
export declare function blendFg(theme: MotionTheme, from: ThemeColor, to: ThemeColor, amount: number, text: string): string;
/** Glyphs painted one color code per run of equal colors, not one per glyph; an undefined blend
 * leaves its glyph unpainted. */
export declare function paintRuns(cells: readonly {
    glyph: string;
    blend: Blend | undefined;
}[]): string;
/** A bell curve: 1 at distance 0, ~0.37 at distance `spread`. */
export declare function gaussian(distance: number, spread: number): number;
/** Two highlights sweeping a `width`-column rule in opposite directions; `━` under a highlight,
 * `─` elsewhere, so the rule keeps its line geometry. `phase` offsets one rule from another;
 * `strength` scales the highlights (0 draws the plain `borderMuted` rule). */
export declare function pulseRule(theme: MotionTheme, width: number, t: number, phase?: number, strength?: number): string;
/** Seconds on the shared motion clock. One clock keeps every rule and spinner in step. */
export declare function motionTime(now?: number): number;
/**
 * A redraw timer that stops itself once nothing draws the component any more (docs/tui-motion-
 * design.md §3.2): `rendered()` is called from render(); a tick that finds no render since the last
 * tick clears the interval. The welcome page uses it -- after the first message the transcript
 * stops rendering the header, so the timer stops one tick later; a later render starts it again.
 */
export declare class FrameTicker {
    private readonly intervalMs;
    private readonly requestRender;
    private timer;
    private renderedSinceTick;
    constructor(intervalMs: number, requestRender: () => void);
    rendered(): void;
    get running(): boolean;
    stop(): void;
}
//# sourceMappingURL=motion.d.ts.map