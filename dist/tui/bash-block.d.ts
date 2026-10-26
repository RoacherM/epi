import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { InspectTarget } from "./buffer/inspector.js";
import type { CommandHost } from "./command-host.js";
import { type ClockGated, type SpineMember } from "./spine.js";
interface FinishedBashMessage {
    command: string;
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    excludeFromContext?: boolean;
}
/**
 * grok truncation rule (4.2) with a plain ellipsis row; `render` then paints every row, the ellipsis
 * included, `toolOutput` (the model's bash block paints it `muted`; both kept, 8.4).
 */
export declare function truncateBashOutput(lines: string[]): string[];
export declare class UserBashBlock implements Component, SpineMember, ClockGated {
    private readonly theme;
    private readonly command;
    private readonly excludeFromContext;
    private readonly onInspect?;
    private readonly requestRender?;
    readonly spineRole = "bash";
    clockLive: boolean;
    private shownAt;
    private outputLines;
    private status;
    private exitCode;
    /** Live runs only: a replayed `bashExecution` message has no duration, so it shows none. */
    private startedAt;
    private durationMs;
    /** When a run drawn while it ran ended: its marker shakes then (glyphs.ts). */
    private endedAt;
    private shownRunning;
    private readonly phase;
    constructor(theme: Theme, command: string, excludeFromContext: boolean, onInspect?: ((target: InspectTarget) => void) | undefined, requestRender?: (() => void) | undefined);
    /** Replays a finished `bashExecution` session message after /new, /resume or /reload. */
    static fromMessage(theme: Theme, message: FinishedBashMessage, onInspect?: (target: InspectTarget) => void): UserBashBlock;
    appendOutput(chunk: string): void;
    /** Running: the carriage sits on the newest output row, or on the call row before any output --
     * not on the `Running…` row under them. */
    spineWriteRow(lines: readonly string[]): number | undefined;
    setComplete(exitCode: number | undefined, cancelled: boolean): void;
    /** The output as lines, without the single trailing newline most commands leave. */
    private lines;
    /** Same layout as a model's bash call (tools/mutating.ts): the marker, the shortened command and
     * a tail that is never cut; output rows under it; a status row only while running, when
     * cancelled, or when the command failed. */
    render(width: number): string[];
    /** `$` (`!!` for a `!!cmd`), the rotating x until then (glyphs.ts). */
    private marker;
    private draw;
    private statusText;
    /** The `… +N lines` row (the call line, then two output rows above it) opens the full output. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    invalidate(): void;
}
/**
 * Handles a submitted `!cmd` / `!!cmd`. Returns false for anything else, so the caller falls
 * through to a normal prompt submit (an empty `!` with no command included, same as Pi).
 */
export declare function runUserBash(host: CommandHost, text: string): Promise<boolean>;
export {};
//# sourceMappingURL=bash-block.d.ts.map