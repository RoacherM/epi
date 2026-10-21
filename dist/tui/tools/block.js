import { motionTime, railGlyph } from "../motion.js";
import { piTui } from "../pi-tui.js";
import { CallLine, LinesComponent, textContent } from "./common.js";
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
    onInspect;
    constructor(inner, theme, tone, isCall, onInspect) {
        this.inner = inner;
        this.theme = theme;
        this.tone = tone;
        this.isCall = isCall;
        this.onInspect = onInspect;
    }
    /** A left click on a row the renderer marked inspectable (`… N more lines`) opens the inspector;
     * anywhere else falls through to Pi's own click-to-expand. */
    handleMouse(event) {
        if (event.type !== "click" || event.button !== "left" || this.onInspect === undefined)
            return undefined;
        if (!(this.inner instanceof LinesComponent))
            return undefined;
        const target = this.inner.inspectTargetAt(event.y);
        if (target === undefined)
            return undefined;
        this.onInspect(target);
        return { handled: true };
    }
    render(width) {
        const prefix = this.isCall ? CALL_PREFIX : RESULT_PREFIX;
        const t = motionTime();
        // The result's rows continue the call line's pulse, one row further down.
        const firstRow = this.isCall ? 0 : 1;
        const rail = (index) => (this.tone === "running" ? railGlyph(this.theme, firstRow + index, t) : " ");
        const bullet = this.marker();
        const contentWidth = Math.max(1, width - prefix - (this.isCall ? 2 : 0));
        return this.inner.render(contentWidth).map((line, index) => {
            const lead = `${rail(index)}${" ".repeat(prefix - 1)}`;
            if (!this.isCall)
                return lead + line;
            return lead + (index === 0 ? bullet : "  ") + line;
        });
    }
    /** `$` stays the shell's amber unless the command failed; `◆` follows the tool's state. */
    marker() {
        if (this.inner instanceof CallLine && this.inner.marker === "$")
            return this.theme.fg(this.tone === "error" ? "error" : "bashMode", "$ ");
        return this.theme.fg(this.tone === "error" ? "error" : this.tone === "running" ? "accent" : "muted", "◆ ");
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
function hasMalformedContent(result) {
    if (!Array.isArray(result?.content))
        return true;
    return result.content.some((part) => {
        if (part?.type === "text")
            return typeof part.text !== "string";
        if (part?.type === "image")
            return typeof part.data !== "string" || typeof part.mimeType !== "string";
        return true;
    });
}
function fallbackResult(result, expanded, theme) {
    const text = textContent(result).trimEnd();
    const lines = text === "" ? [] : text.split("\n");
    const shown = expanded ? lines : lines.slice(0, FALLBACK_LINES);
    const rows = shown.map((line) => theme.fg("toolOutput", line));
    if (shown.length < lines.length)
        rows.push(theme.fg("muted", `… +${lines.length - shown.length} lines (Ctrl+O to expand)`));
    if (hasMalformedContent(result))
        rows.push(theme.fg("muted", "(unrenderable tool result)"));
    return new piTui.Text(rows.join("\n"), 0, 0);
}
/**
 * Frames any tool's renderers in a grok block. A definition that draws its own frame
 * (`renderShell: "self"`) is left alone. `onInspect` receives clicks on inspectable rows.
 */
export function toolBlock(toolName, renderers, onInspect) {
    if (renderers !== undefined && "renderShell" in renderers && renderers.renderShell === "self")
        return renderers;
    const { renderCall, renderResult } = (renderers ?? {});
    const framed = {
        ...renderers,
        renderShell: "self",
        renderCall(args, theme, context) {
            const inner = renderCall?.(args, theme, unwrap(context)) ?? fallbackCall(toolName, theme);
            return new Railed(inner, theme, toneOf(context), true, onInspect);
        },
        renderResult(result, options, theme, context) {
            const inner = renderResult?.(result, options, theme, unwrap(context)) ?? fallbackResult(result, options.expanded, theme);
            return new Railed(inner, theme, toneOf(context), false, onInspect);
        },
    };
    return framed;
}
//# sourceMappingURL=block.js.map