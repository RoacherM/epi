import { GLYPHS, paintMarker, takePhase } from "../glyphs.js";
import { piTui } from "../pi-tui.js";
import { CallLine, LinesComponent, RUNNING_SLICE_ROWS, textContent } from "./common.js";
// Rail column, then padding so `◆` lines up with assistant text (transcript CONTENT_PAD = 3).
const CALL_PREFIX = 3;
// Result rows start under the call text, after `◆ `.
const RESULT_PREFIX = CALL_PREFIX + 2;
// grok: web and MCP tool output shows at most 10 lines until expanded.
const FALLBACK_LINES = 10;
/** What the marker column shows: `pending` while the arguments stream or the call waits its turn. */
function markerStateOf(context) {
    if (context.isError === true)
        return "error";
    if (!context.isPartial)
        return "done";
    return context.executionStarted ? "running" : "pending";
}
function noteMarkerTiming(context) {
    const state = context.state;
    if (state === undefined || state === null || typeof state !== "object")
        return undefined;
    const marker = markerStateOf(context);
    if (marker === "running")
        state.markerPhase ??= takePhase();
    else if ((marker === "done" || marker === "error") && state.markerShownRunning === true)
        state.markerEndedAt ??= Date.now();
    return state;
}
class Railed {
    inner;
    theme;
    state;
    timing;
    kind;
    onInspect;
    constructor(inner, theme, state, timing, 
    /** `running`: a running call's result, of which only the newest RUNNING_SLICE_ROWS rows show. */
    kind, onInspect) {
        this.inner = inner;
        this.theme = theme;
        this.state = state;
        this.timing = timing;
        this.kind = kind;
        this.onInspect = onInspect;
    }
    get isCall() {
        return this.kind === "call";
    }
    /** A left click on a row the renderer marked inspectable (`… N more lines`, a task's call row)
     * opens the inspector; anywhere else falls through to Pi's own click-to-expand. */
    handleMouse(event) {
        if (event.type !== "click" || event.button !== "left" || this.onInspect === undefined)
            return undefined;
        if (!(this.inner instanceof LinesComponent) && !(this.inner instanceof CallLine))
            return undefined;
        const target = this.inner.inspectTargetAt(event.y);
        if (target === undefined)
            return undefined;
        this.onInspect(target);
        return { handled: true };
    }
    /** The first columns stay blank for the turn spine (src/tui/spine.ts), which also carries the
     * carriage. */
    render(width) {
        const prefix = this.isCall ? CALL_PREFIX : RESULT_PREFIX;
        const bullet = this.marker();
        const contentWidth = Math.max(1, width - prefix - (this.isCall ? 2 : 0));
        const lead = " ".repeat(prefix);
        const rows = this.inner.render(contentWidth);
        return (this.kind === "running" ? rows.slice(-RUNNING_SLICE_ROWS) : rows).map((line, index) => {
            if (!this.isCall)
                return lead + line;
            return lead + (index === 0 ? bullet : "  ") + line;
        });
    }
    /** The rotating x while the call runs, then `$` in the shell's amber or a muted `◆`; a red `×` if
     * it failed. Read at displayNow(), so a call held still outside the tip holds its marker too. */
    marker() {
        if (this.state === "running" && this.timing !== undefined)
            this.timing.markerShownRunning = true;
        const shell = this.inner instanceof CallLine && this.inner.marker === GLYPHS.shell;
        const glyph = paintMarker(this.theme, {
            state: this.state,
            glyph: shell ? GLYPHS.shell : GLYPHS.tool,
            color: shell ? "bashMode" : "muted",
            endedAt: this.timing?.markerEndedAt,
            phase: this.timing?.markerPhase,
        });
        return `${glyph} `;
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
function fallbackResult(result, expanded, theme, running) {
    const text = textContent(result).trimEnd();
    const lines = text === "" ? [] : text.split("\n");
    if (running)
        return new piTui.Text(lines.slice(-RUNNING_SLICE_ROWS).map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
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
            return new Railed(inner, theme, markerStateOf(context), noteMarkerTiming(context), "call", onInspect);
        },
        renderResult(result, options, theme, context) {
            // An opened block (Ctrl+O) shows everything, running or not (the v3 prototype's `open`).
            const running = options.isPartial && context.executionStarted && !options.expanded;
            const inner = renderResult?.(result, options, theme, unwrap(context)) ?? fallbackResult(result, options.expanded, theme, running);
            return new Railed(inner, theme, markerStateOf(context), undefined, running ? "running" : "result", onInspect);
        },
    };
    return framed;
}
//# sourceMappingURL=block.js.map