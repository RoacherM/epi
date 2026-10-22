// Pieces shared by the built-in tool renderers, the tool block fallback and the `!cmd` block.
import { homedir } from "node:os";
import { formatDuration } from "../chrome.js";
import { piTui } from "../pi-tui.js";
/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export class LinesComponent {
    lines = [];
    inspectable;
    constructor(lines, inspectable) {
        this.setLines(lines, inspectable);
    }
    /** `inspectable` row indices count the rows as split here, one per "\n"-separated part. */
    setLines(lines, inspectable) {
        if (typeof lines === "string") {
            this.lines = lines ? lines.split("\n") : [];
        }
        else {
            this.lines = lines.flatMap((line) => line.split("\n"));
        }
        this.inspectable = inspectable;
    }
    /** The inspector target behind rendered row `row`, if that row opens one. */
    inspectTargetAt(row) {
        return this.inspectable?.rows.includes(row) ? this.inspectable.target : undefined;
    }
    invalidate() { }
    render(width) {
        return this.lines.map((line) => piTui.truncateToWidth(line, width));
    }
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export function createOrUpdateLines(context, lines, inspectable) {
    if (context.lastComponent instanceof LinesComponent) {
        context.lastComponent.setLines(lines, inspectable);
        return context.lastComponent;
    }
    return new LinesComponent(lines, inspectable);
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
    constructor(marker, theme, body, context, extra = "") {
        this.marker = marker;
        this.theme = theme;
        this.body = body;
        this.context = context;
        this.extra = extra;
    }
    /** The tail as it reads right now: `extra`, the result's summary, then the run time. A failed
     * result's own row says what happened, so a summary left by an earlier (partial) result is dropped. */
    tail() {
        const summary = typeof this.context.state?.callSummary === "string" && !this.context.isError ? this.context.state.callSummary : "";
        const parts = [this.extra, summary].filter((part) => part !== "");
        const dot = parts.map((part) => `${this.theme.fg("dim", " · ")}${part}`).join("");
        const { durationMs, isError, isPartial } = this.context;
        const time = durationMs !== undefined && !isError && !isPartial ? `  ${this.theme.fg("dim", formatToolDuration(durationMs))}` : "";
        return dot + time;
    }
    invalidate() { }
    render(width) {
        return [fitWithTail(this.body, this.tail(), width, this.theme.fg("dim", "…"))];
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