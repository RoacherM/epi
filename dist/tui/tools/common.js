// Pieces shared by the built-in tool renderers, the tool block fallback and the `!cmd` block.
import { homedir } from "node:os";
import { formatDuration } from "../chrome.js";
import { displayNow } from "../clock.js";
import { DEFAULT_MEASURE } from "../measure.js";
import { piTui } from "../pi-tui.js";
/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export class LinesComponent {
    lines = [];
    inspectable;
    columnRows = new Set();
    constructor(lines, inspectable, columnRows = []) {
        this.setLines(lines, inspectable, columnRows);
    }
    /** `inspectable` row indices count the rows as split here, one per "\n"-separated part.
     * `columnRows` are rows of the turn's column -- a failure row -- cut at the reply's measure;
     * every other row is data and keeps the full width (docs/tui-one-column-design.md §2.1). */
    setLines(lines, inspectable, columnRows = []) {
        if (typeof lines === "string") {
            this.lines = lines ? lines.split("\n") : [];
        }
        else {
            this.lines = lines.flatMap((line) => line.split("\n"));
        }
        this.inspectable = inspectable;
        this.columnRows = new Set(columnRows);
    }
    /** The inspector target behind rendered row `row`, if that row opens one. */
    inspectTargetAt(row) {
        return this.inspectable?.rows.includes(row) ? this.inspectable.target : undefined;
    }
    invalidate() { }
    render(width) {
        return this.lines.map((line, row) => (this.columnRows.has(row) ? piTui.truncateToWidth(line, Math.min(width, DEFAULT_MEASURE)) : piTui.truncateToWidth(line, width)));
    }
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export function createOrUpdateLines(context, lines, inspectable, columnRows = []) {
    if (context.lastComponent instanceof LinesComponent) {
        context.lastComponent.setLines(lines, inspectable, columnRows);
        return context.lastComponent;
    }
    return new LinesComponent(lines, inspectable, columnRows);
}
/** The text parts of a tool result joined by "\n"; images and malformed parts are skipped. */
export function textContent(result) {
    if (!result || !Array.isArray(result.content))
        return "";
    return result.content
        .filter((part) => part?.type === "text" && typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n");
}
export function isErrorResult(result, context) {
    return Boolean(context?.isError || result?.isError);
}
/**
 * grok truncation rule (docs/tui-design.md 4.2): up to 5 lines in full, otherwise the first 2, an
 * ellipsis row, and the last 3. `ellipsis` styles that row; callers pick its colour (8.4 keeps the
 * model's bash block `muted` and the `!cmd` block `toolOutput`).
 */
export function truncateOutputLines(lines, ellipsis) {
    if (lines.length <= 5)
        return lines;
    return [...lines.slice(0, 2), ellipsis(`… +${lines.length - 5} lines`), ...lines.slice(-3)];
}
/** A running tool's output under its call row, newest rows last (docs/tui-ctrl-o-per-block-design.md
 * §9.1): the call row and these fit in the spine's tip (TIP_ROWS = 8), where the carriage moves. */
export const RUNNING_SLICE_ROWS = 5;
/** A tool's run time on its call line: `2.1s`, `2m20s`; under a second in milliseconds, since
 * `0.0s`/`0.1s` say nothing about a 30ms grep. */
export function formatToolDuration(ms) {
    if (ms < 950)
        return `${Math.max(1, Math.round(ms))}ms`;
    return formatDuration(ms);
}
/** `body` cut to fit `width` together with `tail`, which is never cut (docs/tui-transcript-layout-
 * design.md §4-C: a long command must not eat its `· +8 lines`). A tail wider than the line is
 * dropped rather than cut. */
export function fitWithTail(body, tail, width, ellipsis) {
    const tailWidth = piTui.visibleWidth(tail);
    if (tailWidth >= width)
        return piTui.truncateToWidth(body, Math.max(0, width), ellipsis);
    return piTui.truncateToWidth(body, width - tailWidth, ellipsis) + tail;
}
// A duration bar (docs/tui-one-column-design.md §2.2): four cells, one decade each -- 10ms–100ms,
// 100ms–1s, 1s–10s, 10s–100s -- filled in eighths at the log position. Tool run times span four or
// five decades; on a linear scale everything but the slowest would be a sliver. A collapsed row shows
// only the bar, an expanded one only the number (docs/tui-ctrl-o-per-block-design.md §9.2).
const BAR_CELLS = 4;
const EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
// Below this many columns for the whole call row there is no room for a column: the time stays a
// number at the end of the body, as in 0.1.22.
const MIN_COLUMN_FOR_BAR = 16;
/** `ms` as a bar: dim filled cells, then `·` for the empty ones; full from 100s on. Under
 * 10ms nothing is filled (`····`, all but instant): a `▏` there, drawn full-height by terminals, lined
 * up with the next fast call's into what read as a divider (docs/tui-one-column-design.md §2.2). */
export function durationBar(theme, ms) {
    const position = Math.min(BAR_CELLS, Math.max(0, Math.log10(Math.max(ms, 1) / 10)));
    const full = Math.floor(position);
    const eighths = Math.round((position - full) * 8);
    let filled = "█".repeat(full) + (full < BAR_CELLS && eighths > 0 ? EIGHTHS[eighths - 1] : "");
    if (filled === "" && ms >= 10)
        filled = "▏";
    return (filled === "" ? "" : theme.fg("dim", filled)) + theme.fg("borderMuted", "·".repeat(BAR_CELLS - [...filled].length));
}
/** The right edge of a call row: the bar when collapsed, the time as a number when expanded. */
export function rightEdgeTime(theme, ms, expanded) {
    return expanded ? theme.fg("muted", formatToolDuration(ms)) : durationBar(theme, ms);
}
/**
 * A call row in the turn's one column (docs/tui-one-column-design.md §2.1): the body and its tail
 * fill the column up to the bar, and the bar ends at the terminal's right edge on every row, so a
 * group of calls lines its bars up. A number in its place (an expanded row) ends at the same edge.
 * `width` is the row's width after the marker.
 */
export function fitCallRow({ body, tail, bar, fallbackTime = "" }, width, ellipsis) {
    const column = Math.min(width, DEFAULT_MEASURE);
    if (bar === "" || column < MIN_COLUMN_FOR_BAR)
        return fitWithTail(body, tail + fallbackTime, column, ellipsis);
    const start = Math.max(0, column - piTui.visibleWidth(bar));
    const left = fitWithTail(body, tail, Math.max(1, start - 1), ellipsis);
    return left + " ".repeat(Math.max(1, start - piTui.visibleWidth(left))) + bar;
}
/**
 * A built-in tool's one-row call line (docs/tui-transcript-layout-implementation.md W3): the body
 * (`read src/a.ts`, the command) cut to fit, then a dim tail that is never cut -- a summary the
 * result renderer leaves in `context.state.callSummary` (`· 120 lines`, `· +3 −1`) and the run
 * time. The tail is read at render time, after Pi's updateDisplay() has run the result renderer
 * too, so a summary only the result knows still lands on the call row; a successful collapsed
 * result then needs no row of its own ("成功不占行").
 */
export class CallLine {
    marker;
    theme;
    body;
    context;
    extra;
    /** Set by a renderer whose call row opens a view (a task's live progress): a click on the row
     * then opens the inspector instead of toggling the block. Read at click time. */
    inspect;
    constructor(marker, theme, body, context, extra = "") {
        this.marker = marker;
        this.theme = theme;
        this.body = body;
        this.context = context;
        this.extra = extra;
        // Pi builds the call component again when the tool starts (markExecutionStarted -> updateDisplay),
        // drawn or not -- a call folded into a group row is not -- so the clock starts with the tool.
        const { executionStarted, isPartial, isError, state } = context;
        if (executionStarted && isPartial && !isError && state !== undefined && state !== null)
            state.startedAt ??= Date.now();
    }
    /** The tail as it reads right now: `extra`, then the result's summary. A failed result's own row
     * says what happened, so a summary left by an earlier (partial) result is dropped. */
    tail() {
        const summary = typeof this.context.state?.callSummary === "string" && !this.context.isError ? this.context.state.callSummary : "";
        const parts = [this.extra, summary].filter((part) => part !== "");
        return parts.map((part) => `${this.theme.fg("dim", " · ")}${part}`).join("");
    }
    /** How long the tool has run: the final time, or while it runs the time since it started (kept in
     * the renderer's state, which Pi keeps per call). A failure draws none, as in 0.1.22. */
    elapsed() {
        const { durationMs, isError, isPartial, state } = this.context;
        if (isError)
            return undefined;
        if (!isPartial)
            return durationMs;
        const startedAt = state?.startedAt;
        return typeof startedAt === "number" ? Math.max(0, displayNow() - startedAt) : undefined;
    }
    /** The time so far: a bar, or the number when expanded (Ctrl+O). */
    bar() {
        const ms = this.elapsed();
        return ms === undefined ? "" : rightEdgeTime(this.theme, ms, this.context.expanded === true);
    }
    invalidate() { }
    inspectTargetAt(row) {
        return row === 0 ? this.inspect?.() : undefined;
    }
    render(width) {
        const ms = this.elapsed();
        const fallback = ms !== undefined && !this.context.isPartial ? `  ${this.theme.fg("dim", formatToolDuration(ms))}` : "";
        return [fitCallRow({ body: this.body, tail: this.tail(), bar: this.bar(), fallbackTime: fallback }, width, this.theme.fg("dim", "…"))];
    }
}
/** A result renderer's summary for the call line's tail (see `CallLine`). */
export function setCallSummary(context, summary) {
    if (context.state === undefined || context.state === null)
        return;
    context.state.callSummary = summary;
}
/** A failure row (`✗ exit 1 · npm ERR! …`): the one case a collapsed result takes a row of its own.
 * Starts with `✗` so the turn spine can give it a red branch (src/tui/spine.ts). */
export function failureRow(theme, text) {
    return theme.fg("error", `✗ ${text}`);
}
/**
 * The command as a call line shows it (docs/tui-transcript-layout-design.md §4-C): its first line,
 * without a leading `cd <session cwd> &&` / `cd <session cwd>;` (the cwd is already the session's),
 * and with the home directory written `~`. `extraLines` counts the lines left out (a heredoc), for
 * the `· +N lines` tail. Display only: the inspector and copying still use the real command.
 */
export function shortenCommand(command, cwd, home = homedir()) {
    const lines = command.trimEnd().split("\n");
    let text = lines[0] ?? "";
    if (cwd) {
        const spellings = [cwd, ...(home && cwd.startsWith(`${home}/`) ? [`~${cwd.slice(home.length)}`] : [])];
        const quoted = spellings.map(escapeRegExp).join("|");
        text = text.replace(new RegExp(`^\\s*cd\\s+(["']?)(?:${quoted})/?\\1\\s*(?:&&|;)\\s*`), "");
    }
    if (home && home !== "/")
        text = text.replace(new RegExp(`${escapeRegExp(home)}(?=$|[/\\s"':;)])`, "g"), "~");
    return { text, extraLines: lines.length - 1 };
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=common.js.map