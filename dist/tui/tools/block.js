import { piTui } from "../pi-tui.js";
import { textContent } from "./common.js";
// Rail column, then padding so `◆` lines up with assistant text (transcript CONTENT_PAD = 3).
const CALL_PREFIX = 3;
// Result rows start under the call text, after `◆ `.
const RESULT_PREFIX = CALL_PREFIX + 2;
// grok: web and MCP tool output shows at most 10 lines until expanded.
const FALLBACK_LINES = 10;
function toneOf(context) {
    if (context.isError === true)
        return "error";
    return context.isPartial ? "running" : "done";
}
class Railed {
    inner;
    theme;
    tone;
    isCall;
    constructor(inner, theme, tone, isCall) {
        this.inner = inner;
        this.theme = theme;
        this.tone = tone;
        this.isCall = isCall;
    }
    render(width) {
        const prefix = this.isCall ? CALL_PREFIX : RESULT_PREFIX;
        const rail = this.tone === "running" ? this.theme.fg("accent", "┃") : " ";
        const bullet = this.theme.fg(this.tone === "error" ? "error" : this.tone === "running" ? "accent" : "muted", "◆ ");
        const contentWidth = Math.max(1, width - prefix - (this.isCall ? 2 : 0));
        return this.inner.render(contentWidth).map((line, index) => {
            const lead = `${rail}${" ".repeat(prefix - 1)}`;
            if (!this.isCall)
                return lead + line;
            return lead + (index === 0 ? bullet : "  ") + line;
        });
    }
    invalidate() {
        this.inner.invalidate();
    }
}
/** Renderers that reuse their last component see their own component, not the frame around it. */
function unwrap(context) {
    const last = context.lastComponent;
    return last instanceof Railed ? { ...context, lastComponent: last.inner } : context;
}
function fallbackCall(toolName, theme) {
    return new piTui.Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
}
function fallbackResult(result, expanded, theme) {
    const text = textContent(result).trimEnd();
    const lines = text === "" ? [] : text.split("\n");
    const shown = expanded ? lines : lines.slice(0, FALLBACK_LINES);
    const rows = shown.map((line) => theme.fg("toolOutput", line));
    if (shown.length < lines.length)
        rows.push(theme.fg("muted", `… +${lines.length - shown.length} lines (Ctrl+O to expand)`));
    return new piTui.Text(rows.join("\n"), 0, 0);
}
/**
 * Frames any tool's renderers in a grok block. A definition that draws its own frame
 * (`renderShell: "self"`) is left alone.
 */
export function toolBlock(toolName, renderers) {
    if (renderers !== undefined && "renderShell" in renderers && renderers.renderShell === "self")
        return renderers;
    const { renderCall, renderResult } = (renderers ?? {});
    const framed = {
        ...renderers,
        renderShell: "self",
        renderCall(args, theme, context) {
            const inner = renderCall?.(args, theme, unwrap(context)) ?? fallbackCall(toolName, theme);
            return new Railed(inner, theme, toneOf(context), true);
        },
        renderResult(result, options, theme, context) {
            const inner = renderResult?.(result, options, theme, unwrap(context)) ?? fallbackResult(result, options.expanded, theme);
            return new Railed(inner, theme, toneOf(context), false);
        },
    };
    return framed;
}
//# sourceMappingURL=block.js.map