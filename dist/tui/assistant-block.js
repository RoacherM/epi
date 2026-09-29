// Assistant message rendering (docs/tui-design.md 4.2's "M4 视觉细节"): the timestamp on the first
// line, and thinking blocks that stream as `◆ Thinking…` + last 3 lines, then collapse to
// `◆ Thought for Ns`. Pi's `AssistantMessageComponent` can't do this: `hideThinkingBlock` /
// `hiddenThinkingLabel` are one flag and one static string for the *whole* component, but a message
// can hold several thinking runs, each needing its own duration and its own click-to-expand state.
// So thinking is rendered here, from scratch; plain text and tool-call bookkeeping (markdown,
// transformers, the aborted/error/length footer) still go through Pi's real component -- that part
// isn't broken, just reused per text run instead of once for the whole message.
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { fit, formatDuration, spread } from "./chrome.js";
import { piTui } from "./pi-tui.js";
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
    constructor(theme, text, active, timing, expanded, onToggle) {
        this.theme = theme;
        this.text = text;
        this.active = active;
        this.timing = timing;
        this.expanded = expanded;
        this.onToggle = onToggle;
    }
    renderLines(width) {
        const bullet = this.theme.fg("dim", "◆");
        const pad = " ".repeat(CONTENT_PAD - 2);
        if (this.active) {
            const label = `${bullet} ${this.theme.fg("muted", "Thinking…")}`;
            const tail = this.text.split("\n").filter((line) => line.trim() !== "").slice(-STREAMING_TAIL_LINES);
            return [
                `${pad}${label}`,
                ...tail.map((line) => fit(`${pad}${this.theme.fg("thinkingText", line)}`, width)),
            ];
        }
        const duration = formatDuration((this.timing.lastAt ?? this.timing.startedAt ?? 0) - (this.timing.startedAt ?? this.timing.lastAt ?? 0));
        const header = `${pad}${bullet} ${this.theme.bold(this.theme.fg("muted", "Thought"))}${this.theme.fg("muted", ` for ${duration}`)}`;
        if (!this.expanded)
            return [fit(header, width)];
        const body = this.text.split("\n").map((line) => fit(`${pad}${this.theme.fg("thinkingText", line)}`, width));
        return [fit(header, width), ...body];
    }
    render(width) {
        return this.renderLines(width);
    }
    /** Only the header row (the `Thought for Ns` / `Thinking…` line) toggles -- clicking into an
     * expanded block's body shouldn't collapse it back out from under a text selection. */
    handleMouse(event) {
        if (event.type !== "click" || event.button !== "left" || event.y !== 0 || this.active)
            return undefined;
        this.onToggle();
        return { handled: true };
    }
    invalidate() { }
}
export class AssistantBlock {
    theme;
    transformers;
    container = new piTui.Container();
    lastMessage;
    lastStreaming = false;
    timing = new Map();
    expandedOverride = new Map();
    globalExpanded = false;
    clock;
    constructor(theme, message, transformers) {
        this.theme = theme;
        this.transformers = transformers;
        // Captured once, like UserMessageBlock's `time`: the component is reused across every
        // streaming update for this message, so this must not drift as content arrives.
        this.clock = theme.fg("muted", new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
        this.updateContent(message, true);
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
        if (hasVisibleContent)
            this.container.addChild(new piTui.Spacer(1));
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
                this.container.addChild(new ThinkingBlock(this.theme, text, active, timing, expanded, toggle));
                return;
            }
            // A text/tool-call run: Pi's own component, fed only this run's `content` and a neutral
            // `stopReason` -- the real stopReason (aborted/error/length) is handled once, below, for the
            // whole message, not per run (Pi's version only ever had one run to worry about).
            const synthetic = { ...message, content: segment.parts, stopReason: "stop" };
            const component = new AssistantMessageComponent(synthetic, false, getMarkdownTheme(), undefined, CONTENT_PAD, this.transformers);
            const wrapped = {
                render: (width) => {
                    const rendered = component.render(width);
                    // Pi's component always opens with a blank spacer row when it has visible content; drop
                    // it for every run after the first so a text run right after a thinking block sits flush
                    // under it (the M4 mock-up shows no gap there), while the very first run in the message
                    // keeps its spacer under the user bubble above.
                    return segmentIndex === 0 || rendered[0]?.trim() !== "" ? rendered : rendered.slice(1);
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
    /** Item 1 (docs/tui-design.md 4.2): the time sits on the first *visible* line, like a user
     * message -- not literally render()'s line 0, which is usually the blank spacer Pi's component
     * always opens with. Reused, `spread`'s narrowing (chrome.ts's UserMessageBlock does the same)
     * costs a little wrap width throughout rather than only on that one line, which pi-tui's Markdown
     * has no hook to do more precisely. */
    render(width) {
        const innerWidth = Math.max(1, width - piTui.visibleWidth(this.clock) - 2);
        const lines = this.container.render(innerWidth);
        const index = lines.findIndex((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim() !== "");
        if (index === -1)
            return lines;
        return lines.map((line, lineIndex) => (lineIndex === index ? spread(line, this.clock, width) : line));
    }
    handleMouse(event) {
        return this.container.handleMouse(event);
    }
    invalidate() {
        this.container.invalidate();
    }
}
//# sourceMappingURL=assistant-block.js.map