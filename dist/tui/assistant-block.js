// Assistant message rendering (docs/tui-design.md 4.2's "M4 视觉细节", docs/tui-transcript-layout-
// design.md §4-A/B): thinking blocks that stream as `× Thinking…` (the rotating x, docs/tui-glyphs-
// design.md) + last 3 lines, then collapse to a dim `◇ 2.1s`. Pi's `AssistantMessageComponent` can't do this: `hideThinkingBlock` /
// `hiddenThinkingLabel` are one flag and one static string for the *whole* component, but a message
// can hold several thinking runs, each needing its own duration and its own click-to-expand state.
// So thinking is rendered here, from scratch. Text runs go through `MeasuredMarkdown` (body text at a
// reading measure, code blocks at the full width, docs/tui-transcript-layout-design.md §4-F), built
// the way Pi's component builds its per-part `Markdown`: trimmed text, the assistant transformers.
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { fit, formatDuration, markPromptZone, splitPromptZone } from "./chrome.js";
import { drawAt } from "./clock.js";
import { GLYPHS, paintMarker } from "./glyphs.js";
import { rewritePiText } from "../pi-output.js";
import { CONTENT_COLUMN, MeasuredMarkdown } from "./markdown-layout.js";
import { piTui } from "./pi-tui.js";
import { dispatchToRows } from "./rows.js";
import { createFlashState, disposeFlash, isFlashing, startFlash } from "./tools/flash.js";
// The content column (R3): expanded thinking and the error lines start where the reply text does.
const CONTENT_PAD = CONTENT_COLUMN;
// The `◇` sits in the marker column, like a tool's `◆` (docs/tui-transcript-layout-design.md R3).
const MARKER_PAD = 3;
const STREAMING_TAIL_LINES = 3;
function applyTransformers(markdown, messageType, isStreaming, availableWidth, transformers) {
    let text = markdown;
    for (const transformer of transformers) {
        try {
            const transformed = transformer(text, { messageType, isStreaming, availableWidth });
            if (typeof transformed === "string")
                text = transformed;
        }
        catch {
            // Keep the current markdown and continue, like Pi's own applyMarkdownTransformers.
        }
    }
    return text;
}
/** Groups `content` into alternating runs, the same split Pi's own updateContent walks: a
 * contiguous run of `thinking` parts is one visual block; everything else (text, tool calls) in
 * between is left in original order for `AssistantMessageComponent` to render (it already skips
 * tool calls itself and only draws text). */
function splitSegments(content) {
    const segments = [];
    for (let index = 0; index < content.length; index += 1) {
        const part = content[index];
        const isThinking = part.type === "thinking";
        const last = segments[segments.length - 1];
        if (last !== undefined && (last.kind === "thinking") === isThinking) {
            last.parts.push(part);
        }
        else if (isThinking) {
            segments.push({ kind: "thinking", startIndex: index, parts: [part] });
        }
        else {
            segments.push({ kind: "content", startIndex: index, parts: [part] });
        }
    }
    return segments;
}
/** One collapsed/expanded/streaming thinking run, keyed by its first content-array index (stable
 * across streaming updates, since content only ever appends). */
class ThinkingBlock {
    theme;
    text;
    active;
    timing;
    expanded;
    onToggle;
    transformers;
    isStreaming;
    flash;
    body;
    constructor(theme, text, active, timing, expanded, onToggle, transformers, 
    // The whole message's streaming state, which Pi hands to the thinking transformers too -- an
    // earlier, finished run of a still-streaming message gets `true`, as in Pi.
    isStreaming, 
    /** Lights this run's stretch of the turn spine once it ends (AssistantBlock.spineFlash). */
    flash) {
        this.theme = theme;
        this.text = text;
        this.active = active;
        this.timing = timing;
        this.expanded = expanded;
        this.onToggle = onToggle;
        this.transformers = transformers;
        this.isStreaming = isStreaming;
        this.flash = flash;
    }
    renderLines(width) {
        const pad = " ".repeat(MARKER_PAD);
        if (this.active) {
            this.timing.shownActive = true;
            const bodyPad = " ".repeat(MARKER_PAD + 2);
            const contentWidth = Math.max(1, width - bodyPad.length);
            const label = `${paintMarker(this.theme, { state: "running", glyph: GLYPHS.model, color: "dim" })} ${this.theme.fg("muted", "Thinking…")}`;
            const transformed = applyTransformers(this.text, "assistant-thinking", true, contentWidth, this.transformers);
            // Wrap first, *then* take the last 3 rows: a `fit()`/`truncateToWidth` per logical line (the
            // prior bug here) throws away everything past the terminal's width instead of carrying it to
            // the next screen row, so a paragraph wider than the terminal never showed its own end.
            const wrapped = piTui.wrapTextWithAnsi(transformed, contentWidth).filter((line) => line.trim() !== "");
            const tail = wrapped.slice(-STREAMING_TAIL_LINES);
            return [
                fit(`${pad}${label}`, width),
                ...tail.map((line) => `${bodyPad}${this.theme.fg("dim", line)}`),
            ];
        }
        // One dim row, no bold and no clock: thinking is the least informative line of a turn
        // (docs/tui-transcript-layout-design.md R2). Replayed history (docs/tui-design.md 4.2): no live
        // thinking_start/delta/end ever reached this block, so there's no real duration to show -- a
        // bare `◇ thought` rather than a misleadingly precise (and always-zero) `0.0s`.
        const hasTiming = this.timing.startedAt !== undefined || this.timing.lastAt !== undefined;
        const label = hasTiming
            ? formatDuration((this.timing.lastAt ?? this.timing.startedAt ?? 0) - (this.timing.startedAt ?? this.timing.lastAt ?? 0))
            : "thought";
        // A run seen streaming shakes twice as it lands (its flash started then); a replayed one doesn't.
        const endedAt = this.timing.shownActive === true && this.flash.startedAt > 0 ? this.flash.startedAt : undefined;
        const marker = paintMarker(this.theme, { state: "done", glyph: GLYPHS.model, color: "dim", endedAt });
        const header = fit(`${pad}${marker} ${this.theme.fg("dim", label)}`, width);
        if (!this.expanded)
            return [header];
        return [header, ...this.expandedBody().render(width)];
    }
    /** Pi's own expanded thinking (assistant-message.js updateContent): a `Markdown` in the
     * thinkingText color, italic, after the `assistant-thinking` transformers, padded by the same
     * CONTENT_PAD the answer text's AssistantMessageComponent gets -- so its left edge sits in the
     * same column as the answer below at every width. Built lazily and kept for this block's life
     * (until the next rebuild()), so Markdown's cache of its last width is reused across renders. */
    expandedBody() {
        this.body ??= new piTui.Markdown(this.text, CONTENT_PAD, 0, getMarkdownTheme(), {
            color: (text) => this.theme.fg("thinkingText", text),
            italic: true,
        }, {
            transform: (markdown, availableWidth) => applyTransformers(markdown, "assistant-thinking", this.isStreaming, availableWidth, this.transformers),
        });
        return this.body;
    }
    render(width) {
        return this.renderLines(width);
    }
    /** Only the header row (the `◇ 2.1s` / `Thinking…` line) toggles -- clicking into an
     * expanded block's body shouldn't collapse it back out from under a text selection. */
    handleMouse(event) {
        if (event.type !== "click" || event.button !== "left" || event.y !== 0 || this.active)
            return undefined;
        this.onToggle();
        return { handled: true };
    }
    invalidate() {
        this.body?.invalidate();
    }
}
export class AssistantBlock {
    theme;
    transformers;
    requestRender;
    spineRole = "trunk";
    /** The thinking marker turns with the clock: outside the transcript's tip it holds still at the time
     * it last showed inside it (spine.ts ClockGated). */
    clockLive = true;
    /** The live `Thinking…` row in the last render, if one is: it is what turns with the clock. */
    clockRow;
    shownAt;
    container = new piTui.Container();
    /** Each child's rows in the last render, for click routing and the spine's flash rows. */
    rows = [];
    rowsWidth;
    lastMessage;
    lastStreaming = false;
    timing = new Map();
    expandedOverride = new Map();
    /** Completion flash per thinking run, keyed like `timing` (docs/tui-design.md 4.2 "完成闪烁"). */
    flashes = new Map();
    /** The run drawn as live "Thinking…" by the last rebuild. Only a run seen active here flashes
     * when it ends, so replayed history (never streamed in this process) never does -- the same
     * guard as a tool's `started` flag. */
    activeThinking;
    globalExpanded = false;
    constructor(theme, message, transformers, streaming, 
    // The transcript's current Ctrl+T state (Transcript.thinkingExpanded), applied *before* the
    // first rebuild instead of via a `setGlobalExpanded()` call right after construction -- that
    // call would trigger a second full rebuild of every segment on every single replayed message,
    // for no visible difference the vast majority of the time (Ctrl+T defaults to off).
    globalExpanded = false, 
    // Draws the frame after a completion flash clears, when nothing else would.
    requestRender = () => { }) {
        this.theme = theme;
        this.transformers = transformers;
        this.requestRender = requestRender;
        this.globalExpanded = globalExpanded;
        this.updateContent(message, streaming);
    }
    /** Finds which thinking segment (by its startIndex key) a streaming event's contentIndex falls
     * into, so a run built from several adjacent `thinking` content parts still gets one timer. */
    recordEvent(segments, event) {
        if (event === undefined)
            return;
        if (event.type !== "thinking_start" && event.type !== "thinking_delta" && event.type !== "thinking_end")
            return;
        const contentIndex = event.contentIndex;
        const segment = segments.find((candidate) => candidate.kind === "thinking" && contentIndex >= candidate.startIndex && contentIndex < candidate.startIndex + candidate.parts.length);
        if (segment === undefined)
            return;
        const timing = this.timing.get(segment.startIndex) ?? { startedAt: undefined, lastAt: undefined };
        timing.startedAt ??= Date.now();
        timing.lastAt = Date.now();
        this.timing.set(segment.startIndex, timing);
    }
    updateContent(message, streaming, event) {
        this.lastMessage = message;
        this.lastStreaming = streaming;
        const segments = splitSegments(message.content);
        this.recordEvent(segments, event);
        this.rebuild(segments);
    }
    /** Ctrl+T (docs/tui-design.md 4.2/4.6's `app.thinking.toggle`): sets every run in this message to
     * the same state and drops any run a click had individually overridden, mirroring Pi's own
     * `setHideThinkingBlock` clearing `thinkingVisibilityOverrides`. */
    setGlobalExpanded(expanded) {
        this.globalExpanded = expanded;
        this.expandedOverride.clear();
        if (this.lastMessage !== undefined)
            this.rebuild(splitSegments(this.lastMessage.content));
    }
    rebuild(segments) {
        this.container.clear();
        const message = this.lastMessage;
        if (message === undefined)
            return;
        const lastSegment = segments[segments.length - 1];
        const activeThinking = this.lastStreaming && lastSegment?.kind === "thinking" ? lastSegment.startIndex : undefined;
        if (this.activeThinking !== undefined && this.activeThinking !== activeThinking) {
            startFlash(this.flash(this.activeThinking), "success", this.requestRender);
        }
        this.activeThinking = activeThinking;
        const pieces = segments.flatMap((segment, segmentIndex) => {
            const piece = this.piece(segments, segmentIndex);
            return piece === undefined ? [] : [{ kind: segment.kind, piece }];
        });
        // One blank row above the message's first visible row (under the user bubble or the previous
        // block), and one between a text run and a thinking run after it; a text run right after a
        // thinking run sits flush under its `◇` (the M4 mock-up shows no gap there).
        pieces.forEach(({ kind, piece }, index) => {
            if (index === 0 || (kind === "thinking" && pieces[index - 1]?.kind === "content"))
                this.container.addChild(new piTui.Spacer(1));
            this.container.addChild(piece);
        });
        const hasToolCalls = message.content.some((part) => part.type === "toolCall");
        if (message.stopReason === "length") {
            this.container.addChild(new piTui.Spacer(1));
            this.container.addChild(new piTui.Text(this.theme.fg("error", "Response was truncated before completion."), CONTENT_PAD, 0));
        }
        else if (!hasToolCalls) {
            if (message.stopReason === "aborted") {
                const text = message.errorMessage !== undefined && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
                this.container.addChild(new piTui.Spacer(1));
                this.container.addChild(new piTui.Text(this.theme.fg("error", text), CONTENT_PAD, 0));
            }
            else if (message.stopReason === "error") {
                this.container.addChild(new piTui.Spacer(1));
                this.container.addChild(new piTui.Text(this.theme.fg("error", `Error: ${rewritePiText(message.errorMessage ?? "Unknown error")}`), CONTENT_PAD, 0));
            }
        }
    }
    /** The component for `segments[segmentIndex]`, or undefined when it draws nothing: an empty run,
     * a text run with no text (tool calls only), or a collapsed thinking run that no text follows. */
    piece(segments, segmentIndex) {
        const segment = segments[segmentIndex]; // in range: called with an index of `segments`
        if (segment.kind === "thinking") {
            const text = segment.parts.map((part) => part.thinking.trim()).filter((part) => part !== "").join("\n\n");
            if (text === "")
                return undefined;
            // Active: still the last segment and the message overall hasn't finished -- always shown
            // as the live "Thinking…" tail, regardless of the expand/collapse toggle (docs/tui-design.md
            // 4.2: that toggle only applies "when the thinking block finishes").
            const active = this.lastStreaming && segmentIndex === segments.length - 1;
            const expanded = this.expandedOverride.get(segment.startIndex) ?? this.globalExpanded;
            // `◇` heads the text it led to (docs/tui-transcript-layout-design.md §7.2-4): a collapsed run
            // followed by tool calls, or by nothing, draws no row -- seven `◇` rows in one turn would cut
            // the story into pieces. Its time still counts in the turn's `Worked for`.
            if (!active && !expanded && !this.textFollows(segments, segmentIndex))
                return undefined;
            let timing = this.timing.get(segment.startIndex);
            if (timing === undefined) {
                timing = { startedAt: undefined, lastAt: undefined };
                this.timing.set(segment.startIndex, timing);
            }
            const toggle = () => {
                this.expandedOverride.set(segment.startIndex, !(this.expandedOverride.get(segment.startIndex) ?? this.globalExpanded));
                if (this.lastMessage !== undefined)
                    this.rebuild(splitSegments(this.lastMessage.content));
            };
            return new ThinkingBlock(this.theme, text, active, timing, expanded, toggle, this.transformers, this.lastStreaming, this.flash(segment.startIndex));
        }
        // A text/tool-call run: one `MeasuredMarkdown` per non-blank text part, stacked with no gap, as
        // Pi's AssistantMessageComponent stacks its `Markdown`s (tool calls draw nothing here). The
        // message's real stopReason (aborted/error/length) is handled once, in rebuild(), not per run.
        const transform = (markdown, availableWidth) => applyTransformers(markdown, "assistant", this.lastStreaming, availableWidth, this.transformers);
        const texts = segment.parts.flatMap((part) => (part.type === "text" && part.text.trim() !== "" ? [part.text.trim()] : []));
        if (texts.length === 0)
            return undefined;
        const stack = new piTui.Container();
        for (const text of texts)
            stack.addChild(new MeasuredMarkdown(this.theme, text, transform));
        return stack;
    }
    /** Whether text (not a tool call) comes right after thinking segment `index`. While the message
     * streams, an empty text part counts too, so the `◇` row doesn't blink out for the moment between
     * `text_start` and the first delta. */
    textFollows(segments, index) {
        const next = segments[index + 1];
        if (next?.kind !== "content")
            return false;
        for (const part of next.parts) {
            if (part.type === "toolCall")
                return false;
            if (part.type === "text" && (part.text.trim() !== "" || this.lastStreaming))
                return true;
        }
        return false;
    }
    flash(startIndex) {
        let flash = this.flashes.get(startIndex);
        if (flash === undefined) {
            flash = createFlashState();
            this.flashes.set(startIndex, flash);
        }
        return flash;
    }
    /** Drops pending flash timers when the transcript is cleared (/new, /resume, /reload). */
    dispose() {
        for (const flash of this.flashes.values())
            disposeFlash(flash);
    }
    render(width) {
        if (this.clockLive) {
            this.shownAt = Date.now();
            return this.draw(width);
        }
        this.shownAt ??= Date.now();
        return drawAt(this.shownAt, () => this.draw(width));
    }
    draw(width) {
        const lines = [];
        this.clockRow = undefined;
        this.rows = this.container.children.map((component) => {
            if (component instanceof ThinkingBlock && component.active)
                this.clockRow = lines.length;
            const rendered = component.render(width);
            lines.push(...rendered);
            return { component, height: rendered.length };
        });
        this.rowsWidth = width;
        // Markers a child may carry (an OSC133 prompt zone) are dropped: the block is marked once as a
        // whole instead (below).
        const rows = lines.map((line) => splitPromptZone(line).rest);
        if (!rows.some((line) => piTui.visibleWidth(line) > 0))
            return rows;
        // Pi's rule (assistant-message.js render): a message with tool calls is not a prompt zone, so
        // Ctrl+Up/Down step over a turn's intermediate tool-calling messages to its final answer.
        const hasToolCalls = this.lastMessage?.content.some((part) => part.type === "toolCall") ?? false;
        return hasToolCalls ? rows : markPromptZone(rows);
    }
    handleMouse(event) {
        if (this.rowsWidth !== event.width)
            this.render(event.width);
        return dispatchToRows(this.rows, event);
    }
    /** A thinking run that just ended flashes its rows' stretch of the turn spine (docs/tui-motion-
     * design.md M6); `row` counts the rows of the last render. */
    spineFlash(row) {
        let top = 0;
        for (const { component, height } of this.rows) {
            if (row < top + height)
                return component instanceof ThinkingBlock && isFlashing(component.flash) ? component.flash : undefined;
            top += height;
        }
        return undefined;
    }
    invalidate() {
        this.container.invalidate();
    }
}
//# sourceMappingURL=assistant-block.js.map