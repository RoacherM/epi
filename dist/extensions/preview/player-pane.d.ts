import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
export interface PaneSource {
    /** A file path or URL (ffmpeg's -i). */
    video: string;
    /** A separate audio stream; without it the sound comes from `video`. */
    audio?: string;
    /** HTTP headers sent when reading `video` and `audio`. */
    headers?: Record<string, string>;
    /** Seconds; the progress bar and seeking by click need it, without it only the time played shows. */
    duration?: number;
    /** The source's frame rate; 24 when not given. */
    fps?: number;
    /** Start again from the beginning at the end (GIF). */
    loop?: boolean;
    /** The name in the text placeholder when the terminal cannot draw images. */
    label?: string;
}
export interface PlayerHost {
    /** The one ctx.ui.custom() gave; requestRender() is called when a new frame arrives. */
    tui: TUI;
    theme: Theme;
    /** The caller's own key hints, put after the pane's own. */
    hint?: string;
}
export declare class PlayerPane {
    private readonly source;
    private readonly host;
    private readonly onDispose?;
    private player;
    /** Where the progress bar sits in the status row, and the body height, for the mouse. */
    private progress;
    private height;
    private disposed;
    constructor(source: PaneSource, host: PlayerHost, onDispose?: (() => void) | undefined);
    /** Stops ffmpeg and ffplay. Safe to call more than once; a disposed pane does not play again. */
    dispose(): void;
    /** Space/p pause and resume, ←/→ and h/l seek 5 s, g/0 go back to the start. True when the key was used. */
    handleInput(data: string): boolean;
    /** `x`/`y` are relative to the body's top left; `y === height` is the status row. A click on the
     * picture pauses, a click or drag on the progress bar seeks. True when the event was used. */
    handleMouse(event: TuiMouseEvent, x: number, y: number): boolean;
    /** `body` is exactly `height` rows: the picture and one row of sound level; `status` is one row. */
    render(width: number, height: number): {
        body: string[];
        status: string;
    };
    private createPlayer;
}
//# sourceMappingURL=player-pane.d.ts.map