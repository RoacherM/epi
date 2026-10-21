import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { InspectTarget } from "./buffer/inspector.js";
import type { CommandHost } from "./command-host.js";
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
export declare class UserBashBlock implements Component {
    private readonly theme;
    private readonly command;
    private readonly excludeFromContext;
    private readonly onInspect?;
    private outputLines;
    private status;
    private exitCode;
    constructor(theme: Theme, command: string, excludeFromContext: boolean, onInspect?: ((target: InspectTarget) => void) | undefined);
    /** Replays a finished `bashExecution` session message after /new, /resume or /reload. */
    static fromMessage(theme: Theme, message: FinishedBashMessage, onInspect?: (target: InspectTarget) => void): UserBashBlock;
    appendOutput(chunk: string): void;
    setComplete(exitCode: number | undefined, cancelled: boolean): void;
    /** The output as lines, without the single trailing newline most commands leave. */
    private lines;
    render(width: number): string[];
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