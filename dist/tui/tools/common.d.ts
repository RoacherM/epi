import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { InspectTarget } from "../buffer/inspector.js";
import type { ToolRenderContext } from "./types.js";
/** Rows of a rendered block that open the inspector (the `… N more lines` row), and what they open. */
export interface Inspectable {
    rows: readonly number[];
    target: InspectTarget;
}
/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export declare class LinesComponent implements Component {
    private lines;
    private inspectable;
    constructor(lines: string[] | string, inspectable?: Inspectable);
    /** `inspectable` row indices count the rows as split here, one per "\n"-separated part. */
    setLines(lines: string[] | string, inspectable?: Inspectable): void;
    /** The inspector target behind rendered row `row`, if that row opens one. */
    inspectTargetAt(row: number): InspectTarget | undefined;
    invalidate(): void;
    render(width: number): string[];
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export declare function createOrUpdateLines(context: ToolRenderContext, lines: string[], inspectable?: Inspectable): Component;
/** The text parts of a tool result joined by "\n"; images and malformed parts are skipped. */
export declare function textContent(result: AgentToolResult<unknown>): string;
export declare function isErrorResult(result: AgentToolResult<unknown>, context: ToolRenderContext | undefined): boolean;
/**
 * grok truncation rule (docs/tui-design.md 4.2): up to 5 lines in full, otherwise the first 2, an
 * ellipsis row, and the last 3. `ellipsis` styles that row; callers pick its colour (8.4 keeps the
 * model's bash block `muted` and the `!cmd` block `toolOutput`).
 */
export declare function truncateOutputLines(lines: string[], ellipsis: (text: string) => string): string[];
/** A tool's run time on its call line: `2.1s`, `2m20s`; under a second in milliseconds, since
 * `0.0s`/`0.1s` say nothing about a 30ms grep. */
export declare function formatToolDuration(ms: number): string;
/** `body` cut to fit `width` together with `tail`, which is never cut (docs/tui-transcript-layout-
 * design.md §4-C: a long command must not eat its `· +8 lines`). A tail wider than the line is
 * dropped rather than cut. */
export declare function fitWithTail(body: string, tail: string, width: number, ellipsis: string): string;
/** The marker a call line puts in the marker column: `$` for shell commands, `◆` for the rest.
 * tools/block.ts paints it in the color of the tool's state. */
export type CallMarker = "$" | "◆";
/**
 * A built-in tool's one-row call line (docs/tui-transcript-layout-implementation.md W3): the body
 * (`read src/a.ts`, the command) cut to fit, then a dim tail that is never cut -- a summary the
 * result renderer leaves in `context.state.callSummary` (`· 120 lines`, `· +3 −1`) and the run
 * time. The tail is read at render time, after Pi's updateDisplay() has run the result renderer
 * too, so a summary only the result knows still lands on the call row; a successful collapsed
 * result then needs no row of its own ("成功不占行").
 */
export declare class CallLine implements Component {
    readonly marker: CallMarker;
    private readonly theme;
    private readonly body;
    private readonly context;
    private readonly extra;
    constructor(marker: CallMarker, theme: Theme, body: string, context: Pick<ToolRenderContext, "state" | "durationMs" | "isError" | "isPartial">, extra?: string);
    /** The tail as it reads right now: `extra`, the result's summary, then the run time. */
    tail(): string;
    invalidate(): void;
    render(width: number): string[];
}
/** A result renderer's summary for the call line's tail (see `CallLine`). */
export declare function setCallSummary(context: ToolRenderContext, summary: string | undefined): void;
/** A failure row (`✗ exit 1 · npm ERR! …`): the one case a collapsed result takes a row of its own.
 * Starts with `✗` so the turn spine can give it a red branch (src/tui/spine.ts). */
export declare function failureRow(theme: Theme, text: string): string;
/**
 * The command as a call line shows it (docs/tui-transcript-layout-design.md §4-C): its first line,
 * without a leading `cd <session cwd> &&` / `cd <session cwd>;` (the cwd is already the session's),
 * and with the home directory written `~`. `extraLines` counts the lines left out (a heredoc), for
 * the `· +N lines` tail. Display only: the inspector and copying still use the real command.
 */
export declare function shortenCommand(command: string, cwd: string | undefined, home?: string): {
    text: string;
    extraLines: number;
};
//# sourceMappingURL=common.d.ts.map