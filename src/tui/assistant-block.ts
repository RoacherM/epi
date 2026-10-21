// Assistant message rendering (docs/tui-design.md 4.2's "M4 视觉细节", docs/tui-transcript-layout-
// design.md §4-A/B): thinking blocks that stream as `∴ Thinking…` + last 3 lines, then collapse to a
// dim `∴ 2.1s`. Pi's `AssistantMessageComponent` can't do this: `hideThinkingBlock` /
// `hiddenThinkingLabel` are one flag and one static string for the *whole* component, but a message
// can hold several thinking runs, each needing its own duration and its own click-to-expand state.
// So thinking is rendered here, from scratch; plain text and tool-call bookkeeping (markdown,
// transformers, the aborted/error/length footer) still go through Pi's real component -- that part
// isn't broken, just reused per text run instead of once for the whole message.
import { AssistantMessageComponent, getMarkdownTheme, type MarkdownTransformer, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { fit, formatDuration, markPromptZone, splitPromptZone } from "./chrome.js";
import { rewritePiText } from "../pi-output.js";
import { breathe, motionTime, railGlyph } from "./motion.js";
import { piTui } from "./pi-tui.js";
import { createFlashState, disposeFlash, type FlashState, paintFlashRail, startFlash } from "./tools/flash.js";

type ContentPart = AssistantMessage["content"][number];

// Matches transcript.ts's CONTENT_PAD: a 1-column rail plus 2 columns of padding, so thinking lines
// up under the assistant text next to it.
const CONTENT_PAD = 3;
// The `∴` sits in the marker column, like a tool's `◆` (docs/tui-transcript-layout-design.md R3).
const MARKER_PAD = 3;
const STREAMING_TAIL_LINES = 3;

function applyTransformers(markdown: string, messageType: "assistant" | "assistant-thinking", isStreaming: boolean, availableWidth: number, transformers: readonly MarkdownTransformer[]): string {
  let text = markdown;
  for (const transformer of transformers) {
    try {
      const transformed = transformer(text, { messageType, isStreaming, availableWidth });
      if (typeof transformed === "string") text = transformed;
    } catch {
      // Keep the current markdown and continue, like Pi's own applyMarkdownTransformers.
    }
  }
  return text;
}

type Segment =
  | { kind: "content"; startIndex: number; parts: ContentPart[] }
  | { kind: "thinking"; startIndex: number; parts: Extract<ContentPart, { type: "thinking" }>[] };

/** Groups `content` into alternating runs, the same split Pi's own updateContent walks: a
 * contiguous run of `thinking` parts is one visual block; everything else (text, tool calls) in
 * between is left in original order for `AssistantMessageComponent` to render (it already skips
 * tool calls itself and only draws text). */
function splitSegments(content: readonly ContentPart[]): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index]!;
    const isThinking = part.type === "thinking";
    const last = segments[segments.length - 1];
    if (last !== undefined && (last.kind === "thinking") === isThinking) {
      (last.parts as ContentPart[]).push(part);
    } else if (isThinking) {
      segments.push({ kind: "thinking", startIndex: index, parts: [part] });
    } else {
      segments.push({ kind: "content", startIndex: index, parts: [part] });
    }
  }
  return segments;
}

interface ThinkingTiming {
  startedAt: number | undefined;
  lastAt: number | undefined;
}

/** One collapsed/expanded/streaming thinking run, keyed by its first content-array index (stable
 * across streaming updates, since content only ever appends). */
class ThinkingBlock implements Component {
  private body: Component | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly text: string,
    private readonly active: boolean,
    private readonly timing: ThinkingTiming,
    private readonly expanded: boolean,
    private readonly onToggle: () => void,
    private readonly transformers: readonly MarkdownTransformer[],
    // The whole message's streaming state, which Pi hands to the thinking transformers too -- an
    // earlier, finished run of a still-streaming message gets `true`, as in Pi.
    private readonly isStreaming: boolean,
    private readonly flash: FlashState,
  ) {}

  private renderLines(width: number): string[] {
    const pad = " ".repeat(MARKER_PAD);
    if (this.active) {
      const bodyPad = " ".repeat(MARKER_PAD + 2);
      const contentWidth = Math.max(1, width - bodyPad.length);
      const label = `${breathe(this.theme, "muted", "thinkingHigh", motionTime(), "∴")} ${this.theme.fg("muted", "Thinking…")}`;
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
    // bare `∴ thought` rather than a misleadingly precise (and always-zero) `0.0s`.
    const hasTiming = this.timing.startedAt !== undefined || this.timing.lastAt !== undefined;
    const label = hasTiming
      ? formatDuration((this.timing.lastAt ?? this.timing.startedAt ?? 0) - (this.timing.startedAt ?? this.timing.lastAt ?? 0))
      : "thought";
    const header = fit(`${pad}${this.theme.fg("dim", "∴")} ${this.theme.fg("dim", label)}`, width);
    if (!this.expanded) return [header];
    return [header, ...this.expandedBody().render(width)];
  }

  /** Pi's own expanded thinking (assistant-message.js updateContent): a `Markdown` in the
   * thinkingText color, italic, after the `assistant-thinking` transformers, padded by the same
   * CONTENT_PAD the answer text's AssistantMessageComponent gets -- so its left edge sits in the
   * same column as the answer below at every width. Built lazily and kept for this block's life
   * (until the next rebuild()), so Markdown's cache of its last width is reused across renders. */
  private expandedBody(): Component {
    this.body ??= new piTui.Markdown(this.text, CONTENT_PAD, 0, getMarkdownTheme(), {
      color: (text: string) => this.theme.fg("thinkingText", text),
      italic: true,
    }, {
      transform: (markdown: string, availableWidth: number) =>
        applyTransformers(markdown, "assistant-thinking", this.isStreaming, availableWidth, this.transformers),
    });
    return this.body;
  }

  render(width: number): string[] {
    // The rail column is the blank first column of `pad`: a pulse runs down it while thinking
    // (docs/tui-motion-design.md M4), and it flashes once when the run ends.
    const lines = this.renderLines(width);
    if (this.active) {
      const t = motionTime();
      return lines.map((line, row) => (line.startsWith(" ") ? railGlyph(this.theme, row, t) + line.slice(1) : line));
    }
    return paintFlashRail(lines, this.flash, this.theme);
  }

  /** Only the header row (the `∴ 2.1s` / `Thinking…` line) toggles -- clicking into an
   * expanded block's body shouldn't collapse it back out from under a text selection. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== 0 || this.active) return undefined;
    this.onToggle();
    return { handled: true };
  }

  invalidate(): void {
    this.body?.invalidate();
  }
}

export class AssistantBlock implements Component {
  private readonly container = new piTui.Container();
  private lastMessage: AssistantMessage | undefined;
  private lastStreaming = false;
  private readonly timing = new Map<number, ThinkingTiming>();
  private readonly expandedOverride = new Map<number, boolean>();
  /** Completion flash per thinking run, keyed like `timing` (docs/tui-design.md 4.2 "完成闪烁"). */
  private readonly flashes = new Map<number, FlashState>();
  /** The run drawn as live "Thinking…" by the last rebuild. Only a run seen active here flashes
   * when it ends, so replayed history (never streamed in this process) never does -- the same
   * guard as a tool's `started` flag. */
  private activeThinking: number | undefined;
  private globalExpanded = false;

  constructor(
    private readonly theme: Theme,
    message: AssistantMessage,
    private readonly transformers: readonly MarkdownTransformer[],
    streaming: boolean,
    // The transcript's current Ctrl+T state (Transcript.thinkingExpanded), applied *before* the
    // first rebuild instead of via a `setGlobalExpanded()` call right after construction -- that
    // call would trigger a second full rebuild of every segment on every single replayed message,
    // for no visible difference the vast majority of the time (Ctrl+T defaults to off).
    globalExpanded = false,
    // Draws the frame after a completion flash clears, when nothing else would.
    private readonly requestRender: () => void = () => {},
  ) {
    this.globalExpanded = globalExpanded;
    this.updateContent(message, streaming);
  }

  /** Finds which thinking segment (by its startIndex key) a streaming event's contentIndex falls
   * into, so a run built from several adjacent `thinking` content parts still gets one timer. */
  private recordEvent(segments: readonly Segment[], event: AssistantMessageEvent | undefined): void {
    if (event === undefined) return;
    if (event.type !== "thinking_start" && event.type !== "thinking_delta" && event.type !== "thinking_end") return;
    const contentIndex = event.contentIndex;
    const segment = segments.find((candidate): candidate is Extract<Segment, { kind: "thinking" }> =>
      candidate.kind === "thinking" && contentIndex >= candidate.startIndex && contentIndex < candidate.startIndex + candidate.parts.length);
    if (segment === undefined) return;
    const timing = this.timing.get(segment.startIndex) ?? { startedAt: undefined, lastAt: undefined };
    timing.startedAt ??= Date.now();
    timing.lastAt = Date.now();
    this.timing.set(segment.startIndex, timing);
  }

  updateContent(message: AssistantMessage, streaming: boolean, event?: AssistantMessageEvent): void {
    this.lastMessage = message;
    this.lastStreaming = streaming;
    const segments = splitSegments(message.content);
    this.recordEvent(segments, event);
    this.rebuild(segments);
  }

  /** Ctrl+T (docs/tui-design.md 4.2/4.6's `app.thinking.toggle`): sets every run in this message to
   * the same state and drops any run a click had individually overridden, mirroring Pi's own
   * `setHideThinkingBlock` clearing `thinkingVisibilityOverrides`. */
  setGlobalExpanded(expanded: boolean): void {
    this.globalExpanded = expanded;
    this.expandedOverride.clear();
    if (this.lastMessage !== undefined) this.rebuild(splitSegments(this.lastMessage.content));
  }

  private rebuild(segments: readonly Segment[]): void {
    this.container.clear();
    const message = this.lastMessage;
    if (message === undefined) return;

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
    // thinking run sits flush under its `∴` (the M4 mock-up shows no gap there).
    pieces.forEach(({ kind, piece }, index) => {
      if (index === 0 || (kind === "thinking" && pieces[index - 1]?.kind === "content")) this.container.addChild(new piTui.Spacer(1));
      this.container.addChild(piece);
    });

    const hasToolCalls = message.content.some((part) => part.type === "toolCall");
    if (message.stopReason === "length") {
      this.container.addChild(new piTui.Spacer(1));
      this.container.addChild(new piTui.Text(this.theme.fg("error", "Response was truncated before completion."), CONTENT_PAD, 0));
    } else if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const text = message.errorMessage !== undefined && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
        this.container.addChild(new piTui.Spacer(1));
        this.container.addChild(new piTui.Text(this.theme.fg("error", text), CONTENT_PAD, 0));
      } else if (message.stopReason === "error") {
        this.container.addChild(new piTui.Spacer(1));
        this.container.addChild(new piTui.Text(this.theme.fg("error", `Error: ${rewritePiText(message.errorMessage ?? "Unknown error")}`), CONTENT_PAD, 0));
      }
    }
  }

  /** The component for `segments[segmentIndex]`, or undefined when it draws nothing: an empty run,
   * a text run with no text (tool calls only), or a collapsed thinking run that no text follows. */
  private piece(segments: readonly Segment[], segmentIndex: number): Component | undefined {
    const segment = segments[segmentIndex]!; // in range: called with an index of `segments`
    const message = this.lastMessage!; // set by updateContent before any rebuild
    if (segment.kind === "thinking") {
      const text = segment.parts.map((part) => part.thinking.trim()).filter((part) => part !== "").join("\n\n");
      if (text === "") return undefined;
      // Active: still the last segment and the message overall hasn't finished -- always shown
      // as the live "Thinking…" tail, regardless of the expand/collapse toggle (docs/tui-design.md
      // 4.2: that toggle only applies "when the thinking block finishes").
      const active = this.lastStreaming && segmentIndex === segments.length - 1;
      const expanded = this.expandedOverride.get(segment.startIndex) ?? this.globalExpanded;
      // `∴` heads the text it led to (docs/tui-transcript-layout-design.md §7.2-4): a collapsed run
      // followed by tool calls, or by nothing, draws no row -- seven `∴` rows in one turn would cut
      // the story into pieces. Its time still counts in the turn's `Worked for`.
      if (!active && !expanded && !this.textFollows(segments, segmentIndex)) return undefined;
      const timing = this.timing.get(segment.startIndex) ?? { startedAt: undefined, lastAt: undefined };
      const toggle = () => {
        this.expandedOverride.set(segment.startIndex, !(this.expandedOverride.get(segment.startIndex) ?? this.globalExpanded));
        if (this.lastMessage !== undefined) this.rebuild(splitSegments(this.lastMessage.content));
      };
      return new ThinkingBlock(this.theme, text, active, timing, expanded, toggle, this.transformers, this.lastStreaming, this.flash(segment.startIndex));
    }
    if (!segment.parts.some((part) => part.type === "text" && part.text.trim() !== "")) return undefined;
    // A text/tool-call run: Pi's own component, fed only this run's `content` and a neutral
    // `stopReason` -- the real stopReason (aborted/error/length) is handled once, below, for the
    // whole message, not per run (Pi's version only ever had one run to worry about). Constructed
    // with no initial message so it doesn't render once with the wrong (default `false`)
    // isStreaming before this updateContent call gives it the real one.
    const synthetic: AssistantMessage = { ...message, content: segment.parts, stopReason: "stop" };
    const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), undefined, CONTENT_PAD, this.transformers);
    component.updateContent(synthetic, this.lastStreaming);
    return {
      // Pi's component always opens with a blank spacer row; rebuild() places the blank rows itself.
      // `visibleWidth`, not `.trim()`: Pi also prepends a zero-width OSC133 marker to this exact row.
      render: (width: number) => {
        const rendered = component.render(width);
        return piTui.visibleWidth(rendered[0] ?? "") > 0 ? rendered : rendered.slice(1);
      },
      invalidate: () => component.invalidate(),
      handleMouse: (mouseEvent) => component.handleMouse(mouseEvent),
    };
  }

  /** Whether text (not a tool call) comes right after thinking segment `index`. While the message
   * streams, an empty text part counts too, so the `∴` row doesn't blink out for the moment between
   * `text_start` and the first delta. */
  private textFollows(segments: readonly Segment[], index: number): boolean {
    const next = segments[index + 1];
    if (next?.kind !== "content") return false;
    for (const part of next.parts) {
      if (part.type === "toolCall") return false;
      if (part.type === "text" && (part.text.trim() !== "" || this.lastStreaming)) return true;
    }
    return false;
  }

  private flash(startIndex: number): FlashState {
    let flash = this.flashes.get(startIndex);
    if (flash === undefined) {
      flash = createFlashState();
      this.flashes.set(startIndex, flash);
    }
    return flash;
  }

  /** Drops pending flash timers when the transcript is cleared (/new, /resume, /reload). */
  dispose(): void {
    for (const flash of this.flashes.values()) disposeFlash(flash);
  }

  render(width: number): string[] {
    // Each text run's AssistantMessageComponent marks its own OSC133 prompt zone; the block is
    // marked once as a whole instead (below), so those markers are dropped here.
    const rows = this.container.render(width).map((line) => splitPromptZone(line).rest);
    if (!rows.some((line) => piTui.visibleWidth(line) > 0)) return rows;
    // Pi's rule (assistant-message.js render): a message with tool calls is not a prompt zone, so
    // Ctrl+Up/Down step over a turn's intermediate tool-calling messages to its final answer.
    const hasToolCalls = this.lastMessage?.content.some((part) => part.type === "toolCall") ?? false;
    return hasToolCalls ? rows : markPromptZone(rows);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.container.handleMouse(event);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}
