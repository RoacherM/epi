// Assistant message rendering (docs/tui-design.md 4.2's "M4 视觉细节"): the timestamp on the first
// line, and thinking blocks that stream as `◆ Thinking…` + last 3 lines, then collapse to
// `◆ Thought for Ns`. Pi's `AssistantMessageComponent` can't do this: `hideThinkingBlock` /
// `hiddenThinkingLabel` are one flag and one static string for the *whole* component, but a message
// can hold several thinking runs, each needing its own duration and its own click-to-expand state.
// So thinking is rendered here, from scratch; plain text and tool-call bookkeeping (markdown,
// transformers, the aborted/error/length footer) still go through Pi's real component -- that part
// isn't broken, just reused per text run instead of once for the whole message.
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { fit, formatDuration, markPromptZone, spread, splitPromptZone, clockColumns } from "./chrome.js";
import { piTui } from "./pi-tui.js";
import { createFlashState, disposeFlash, paintFlashRail, startFlash } from "./tools/flash.js";
// Matches transcript.ts's CONTENT_PAD: a 1-column rail plus 2 columns of padding, so thinking lines
// up under the assistant text next to it.
const CONTENT_PAD = 3;
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
    isStreaming, flash) {
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
        const bullet = this.theme.fg("dim", "◆");
        const pad = " ".repeat(CONTENT_PAD - 2);
        // Available width for wrapped content, matching `fit()`'s single-line budget elsewhere in this
        // file: the same `pad` prefix, minus a column of slack `wrapTextWithAnsi` doesn't need but
        // `fit()`'s `truncateToWidth` did.
        const contentWidth = Math.max(1, width - pad.length);
        if (this.active) {
            const label = `${bullet} ${this.theme.fg("muted", "Thinking…")}`;
            const transformed = applyTransformers(this.text, "assistant-thinking", true, contentWidth, this.transformers);
            // Wrap first, *then* take the last 3 rows: a `fit()`/`truncateToWidth` per logical line (the
            // prior bug here) throws away everything past the terminal's width instead of carrying it to
            // the next screen row, so a paragraph wider than the terminal never showed its own end.
            const wrapped = piTui.wrapTextWithAnsi(transformed, contentWidth).filter((line) => line.trim() !== "");
            const tail = wrapped.slice(-STREAMING_TAIL_LINES);
            return [
                `${pad}${label}`,
                ...tail.map((line) => `${pad}${this.theme.fg("dim", line)}`),
            ];
        }
        const hasTiming = this.timing.startedAt !== undefined || this.timing.lastAt !== undefined;
        const suffix = hasTiming
            ? this.theme.fg("muted", ` for ${formatDuration((this.timing.lastAt ?? this.timing.startedAt ?? 0) - (this.timing.startedAt ?? this.timing.lastAt ?? 0))}`)
            // Replayed history (docs/tui-design.md 4.2): no live thinking_start/delta/end ever reached
            // this block, so there's no real duration to show -- a bare "◆ Thought" rather than a
            // misleadingly precise (and always-zero) "Thought for 0.0s".
            : "";
        const header = `${pad}${bullet} ${this.theme.bold(this.theme.fg("muted", "Thought"))}${suffix}`;
        if (!this.expanded)
            return [fit(header, width)];
        return [fit(header, width), ...this.expandedBody().render(width)];
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
        // The rail column is the blank first column of `pad`; it flashes once when the run ends.
        return paintFlashRail(this.renderLines(width), this.flash, this.theme);
    }
    /** Only the header row (the `Thought for Ns` / `Thinking…` line) toggles -- clicking into an
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
    container = new piTui.Container();
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
    clock;
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
        // Captured once, like UserMessageBlock's `time`: the component is reused across every
        // streaming update for this message, so this must not drift as content arrives.
        this.clock = theme.fg("muted", new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
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
        const hasVisibleContent = message.content.some((part) => (part.type === "text" && part.text.trim() !== "") || (part.type === "thinking" && part.thinking.trim() !== ""));
        // Only when the message *starts* with thinking: a leading content/tool-call segment already
        // brings its own leading Spacer(1) (Pi's AssistantMessageComponent adds one itself whenever it
        // has visible content), so adding this one too would double it up -- the bug a test caught
        // (a plain, thinking-free reply rendering two blank rows instead of one).
        if (hasVisibleContent && segments[0]?.kind === "thinking")
            this.container.addChild(new piTui.Spacer(1));
        const lastSegment = segments[segments.length - 1];
        const activeThinking = this.lastStreaming && lastSegment?.kind === "thinking" ? lastSegment.startIndex : undefined;
        if (this.activeThinking !== undefined && this.activeThinking !== activeThinking) {
            startFlash(this.flash(this.activeThinking), "success", this.requestRender);
        }
        this.activeThinking = activeThinking;
        segments.forEach((segment, segmentIndex) => {
            if (segment.kind === "thinking") {
                const text = segment.parts.map((part) => part.thinking.trim()).filter((part) => part !== "").join("\n\n");
                if (text === "")
                    return;
                // Active: still the last segment and the message overall hasn't finished -- always shown
                // as the live "Thinking…" tail, regardless of the expand/collapse toggle (docs/tui-design.md
                // 4.2: that toggle only applies "when the thinking block finishes").
                const active = this.lastStreaming && segmentIndex === segments.length - 1;
                const timing = this.timing.get(segment.startIndex) ?? { startedAt: undefined, lastAt: undefined };
                const expanded = this.expandedOverride.get(segment.startIndex) ?? this.globalExpanded;
                const toggle = () => {
                    this.expandedOverride.set(segment.startIndex, !(this.expandedOverride.get(segment.startIndex) ?? this.globalExpanded));
                    if (this.lastMessage !== undefined)
                        this.rebuild(splitSegments(this.lastMessage.content));
                };
                this.container.addChild(new ThinkingBlock(this.theme, text, active, timing, expanded, toggle, this.transformers, this.lastStreaming, this.flash(segment.startIndex)));
                return;
            }
            // A text/tool-call run: Pi's own component, fed only this run's `content` and a neutral
            // `stopReason` -- the real stopReason (aborted/error/length) is handled once, below, for the
            // whole message, not per run (Pi's version only ever had one run to worry about). Constructed
            // with no initial message so it doesn't render once with the wrong (default `false`)
            // isStreaming before this updateContent call gives it the real one.
            const synthetic = { ...message, content: segment.parts, stopReason: "stop" };
            const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), undefined, CONTENT_PAD, this.transformers);
            component.updateContent(synthetic, this.lastStreaming);
            const wrapped = {
                render: (width) => {
                    const rendered = component.render(width);
                    // Pi's component always opens with a blank spacer row when it has visible content. Kept
                    // for the very first segment (its only source of the one leading blank under the user
                    // bubble above); dropped for every later one so a text run right after a thinking block
                    // sits flush under it (the M4 mock-up shows no gap there). `visibleWidth`, not `.trim()`:
                    // Pi also prepends a zero-width OSC133 marker to this exact row, which defeats a plain
                    // string-emptiness check. The markers themselves are replaced in render() below.
                    return segmentIndex === 0 || piTui.visibleWidth(rendered[0] ?? "") > 0 ? rendered : rendered.slice(1);
                },
                invalidate: () => component.invalidate(),
                handleMouse: (mouseEvent) => component.handleMouse(mouseEvent),
            };
            this.container.addChild(wrapped);
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
                this.container.addChild(new piTui.Text(this.theme.fg("error", `Error: ${message.errorMessage ?? "Unknown error"}`), CONTENT_PAD, 0));
            }
        }
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
    /** The width the inner container is actually rendered at -- narrower than the component's own,
     * to leave room for the clock (chrome.ts's `UserMessageBlock` does the same). Shared by `render()`
     * and `handleMouse()` so a click is dispatched against the same row heights it was drawn with. */
    innerWidth(width) {
        return Math.max(1, width - clockColumns(this.clock) - 2);
    }
    /** Item 1 (docs/tui-design.md 4.2): the time sits on the first *visible* line, like a user
     * message -- not literally render()'s line 0, which is usually the blank spacer Pi's component
     * always opens with. Reused, `spread`'s narrowing (chrome.ts's UserMessageBlock does the same)
     * costs a little wrap width throughout rather than only on that one line, which pi-tui's Markdown
     * has no hook to do more precisely. */
    render(width) {
        // Each text run's AssistantMessageComponent marks its own OSC133 prompt zone; the block is
        // marked once as a whole instead (below), so those markers are dropped here.
        const lines = this.container.render(this.innerWidth(width)).map((line) => splitPromptZone(line).rest);
        const index = lines.findIndex((line) => piTui.visibleWidth(line) > 0);
        if (index === -1)
            return lines;
        const rows = lines.map((line, lineIndex) => (lineIndex === index ? spread(line, this.clock, width) : line));
        // Pi's rule (assistant-message.js render): a message with tool calls is not a prompt zone, so
        // Ctrl+Up/Down step over a turn's intermediate tool-calling messages to its final answer.
        const hasToolCalls = this.lastMessage?.content.some((part) => part.type === "toolCall") ?? false;
        return hasToolCalls ? rows : markPromptZone(rows);
    }
    /** `event.width` must match what `render()` last drew the container at, or pi-tui's `Container.
     * handleMouse` recomputes row heights at the wrong (full, not narrowed) width and a click lands on
     * the wrong segment whenever an earlier one wraps differently at the two widths -- `Container`
     * only reuses its cached per-child heights when the width matches exactly. */
    handleMouse(event) {
        return this.container.handleMouse({ ...event, width: this.innerWidth(event.width) });
    }
    invalidate() {
        this.container.invalidate();
    }
}
//# sourceMappingURL=assistant-block.js.map