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
    private columnRows;
    constructor(lines: string[] | string, inspectable?: Inspectable, columnRows?: readonly number[]);
    /** `inspectable` row indices count the rows as split here, one per "\n"-separated part.
     * `columnRows` are rows of the turn's column -- a failure row -- cut at the reply's measure;
     * every other row is data and keeps the full width (docs/tui-one-column-design.md §2.1). */
    setLines(lines: string[] | string, inspectable?: Inspectable, columnRows?: readonly number[]): void;
    /** The inspector target behind rendered row `row`, if that row opens one. */
    inspectTargetAt(row: number): InspectTarget | undefined;
    invalidate(): void;
    render(width: number): string[];
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export declare function createOrUpdateLines(context: ToolRenderContext, lines: string[], inspectable?: Inspectable, columnRows?: readonly number[]): Component;
/** The text parts of a tool result joined by "\n"; images and malformed parts are skipped. */
export declare function textContent(result: AgentToolResult<unknown>): string;
export declare function isErrorResult(result: AgentToolResult<unknown>, context: ToolRenderContext | undefined): boolean;
/**
 * grok truncation rule (docs/tui-design.md 4.2): up to 5 lines in full, otherwise the first 2, an
 * ellipsis row, and the last 3. `ellipsis` styles that row; callers pick its colour (8.4 keeps the
 * model's bash block `muted` and the `!cmd` block `toolOutput`).
 */
export declare function truncateOutputLines(lines: string[], ellipsis: (text: string) => string): string[];
/** A running tool's output under its call row, newest rows last (docs/tui-ctrl-o-per-block-design.md
 * §9.1): the call row and these fit in the spine's tip (TIP_ROWS = 8), where the carriage moves. */
export declare const RUNNING_SLICE_ROWS = 5;
/** A tool's run time on its call line: `2.1s`, `2m20s`; under a second in milliseconds, since
 * `0.0s`/`0.1s` say nothing about a 30ms grep. */
export declare function formatToolDuration(ms: number): string;
/** `body` cut to fit `width` together with `tail`, which is never cut (docs/tui-transcript-layout-
 * design.md §4-C: a long command must not eat its `· +8 lines`). A tail wider than the line is
 * dropped rather than cut. */
export declare function fitWithTail(body: string, tail: string, width: number, ellipsis: string): string;
/** `ms` as a bar: dim filled cells, then `·` for the empty ones; with the time after a full bar. Under
 * 10ms nothing is filled (`····`, all but instant): a `▏` there, drawn full-height by terminals, lined
 * up with the next fast call's into what read as a divider (docs/tui-one-column-design.md §2.2). */
export declare function durationBar(theme: Theme, ms: number): string;
/** What a call row holds: the body (cut to fit), its tail (`· +36 lines`, `· +3 −1`; never cut), the
 * duration bar ("" for none), and the time as a number for a line too narrow for a column. */
interface CallRowParts {
    body: string;
    tail: string;
    bar: string;
    fallbackTime?: string;
}
/**
 * A call row in the turn's one column (docs/tui-one-column-design.md §2.1): the body and its tail
 * fill the column up to the bar, and the bar starts at the same column on every row -- the
 * measure's right edge less its cells -- so a group of calls lines its bars up. A number after a
 * full bar runs past the edge when the line has room, and otherwise moves the bar left. `width` is
 * the row's width after the marker.
 */
export declare function fitCallRow({ body, tail, bar, fallbackTime }: CallRowParts, width: number, ellipsis: string): string;
/** The marker a call line puts in the marker column once it settles: `$` for shell commands, `◆` for
 * the rest. tools/block.ts draws the rotating x until then (src/tui/glyphs.ts). */
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
    constructor(marker: CallMarker, theme: Theme, body: string, context: Pick<ToolRenderContext, "state" | "durationMs" | "isError" | "isPartial" | "executionStarted" | "expanded">, extra?: string);
    /** The tail as it reads right now: `extra`, then the result's summary. A failed result's own row
     * says what happened, so a summary left by an earlier (partial) result is dropped. */
    tail(): string;
    /** How long the tool has run: the final time, or while it runs the time since it started (kept in
     * the renderer's state, which Pi keeps per call). A failure draws none, as in 0.1.22. */
    private elapsed;
    /** The bar for the time so far, with the exact time after it when expanded (Ctrl+O). */
    private bar;
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
export {};
//# sourceMappingURL=common.d.ts.map