import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
export declare const GLYPHS: {
    readonly user: "❯";
    /** Thinking and replies; paired with the tools' filled `◆`. */
    readonly model: "◇";
    readonly shell: "$";
    readonly tool: "◆";
    readonly group: "◈";
    readonly event: "·";
};
/** Epi's animation tick (chrome.ts MOTION_TICK_MS). */
export declare const TICK_MS = 80;
/** How long the landing shake takes: one tick a frame. */
export declare const LANDING_MS: number;
/** The rotating x at `now`, `phase` ticks ahead. */
export declare function spinFrame(now: number, phase?: number): "+" | "×";
/** The landing frame at `now` for something that ended at `endedAt`, or undefined once it settled. */
export declare function landingFrame(now: number, endedAt: number | undefined): "+" | "×" | undefined;
/** The phase for the next call that starts running: each one PHASE_STEP ticks after the last. */
export declare function takePhase(): number;
export type MarkerState = "pending" | "running" | "done" | "error";
export interface Marker {
    state: MarkerState;
    /** The glyph once settled (`$`, `◆`, `◈`, `◇`). */
    glyph: string;
    /** Its colour once settled. */
    color: ThemeColor;
    /** Settled with a failure: the glyph a failure settles on, default a red `×`. */
    failedGlyph?: string;
    /** When it ended, if it was seen running: it shakes for LANDING_MS after this. */
    endedAt?: number | undefined;
    phase?: number | undefined;
    /** Drawn before every frame but the settled glyph, which it is part of: `!` for `!!` (a `!!cmd` turns
     * as `!+`/`!×`), so the row never changes width and still says what it is. */
    lead?: string;
}
/** `marker` painted at `now`. The landing shake plays only while `landing` (a block in the tip). */
export declare function paintMarker(theme: Pick<Theme, "fg">, marker: Marker, now?: number, landing?: boolean): string;
/** Redraws every tick until a landing that starts now has played, for a block nothing else redraws
 * then (a `!cmd` alone has no turn status ticking). */
export declare function renderThroughLanding(requestRender: () => void): void;
//# sourceMappingURL=glyphs.d.ts.map