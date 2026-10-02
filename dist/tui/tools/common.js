import { piTui } from "../pi-tui.js";
/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export class LinesComponent {
    lines = [];
    constructor(lines) {
        this.setLines(lines);
    }
    setLines(lines) {
        if (typeof lines === "string") {
            this.lines = lines ? lines.split("\n") : [];
        }
        else {
            this.lines = lines.flatMap((line) => line.split("\n"));
        }
    }
    invalidate() { }
    render(width) {
        return this.lines.map((line) => piTui.truncateToWidth(line, width));
    }
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export function createOrUpdateLines(context, lines) {
    if (context.lastComponent instanceof LinesComponent) {
        context.lastComponent.setLines(lines);
        return context.lastComponent;
    }
    return new LinesComponent(lines);
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
//# sourceMappingURL=common.js.map