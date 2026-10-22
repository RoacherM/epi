import { type MarkdownTransformer, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { SpineMember } from "./spine.js";
import { type FlashState } from "./tools/flash.js";
export declare class AssistantBlock implements Component, SpineMember {
    private readonly theme;
    private readonly transformers;
    private readonly requestRender;
    readonly spineRole = "trunk";
    private readonly container;
    /** Each child's rows in the last render, for click routing and the spine's flash rows. */
    private rows;
    private rowsWidth;
    private lastMessage;
    private lastStreaming;
    private readonly timing;
    private readonly expandedOverride;
    /** Completion flash per thinking run, keyed like `timing` (docs/tui-design.md 4.2 "完成闪烁"). */
    private readonly flashes;
    /** The run drawn as live "Thinking…" by the last rebuild. Only a run seen active here flashes
     * when it ends, so replayed history (never streamed in this process) never does -- the same
     * guard as a tool's `started` flag. */
    private activeThinking;
    private globalExpanded;
    constructor(theme: Theme, message: AssistantMessage, transformers: readonly MarkdownTransformer[], streaming: boolean, globalExpanded?: boolean, requestRender?: () => void);
    /** Finds which thinking segment (by its startIndex key) a streaming event's contentIndex falls
     * into, so a run built from several adjacent `thinking` content parts still gets one timer. */
    private recordEvent;
    updateContent(message: AssistantMessage, streaming: boolean, event?: AssistantMessageEvent): void;
    /** Ctrl+T (docs/tui-design.md 4.2/4.6's `app.thinking.toggle`): sets every run in this message to
     * the same state and drops any run a click had individually overridden, mirroring Pi's own
     * `setHideThinkingBlock` clearing `thinkingVisibilityOverrides`. */
    setGlobalExpanded(expanded: boolean): void;
    private rebuild;
    /** The component for `segments[segmentIndex]`, or undefined when it draws nothing: an empty run,
     * a text run with no text (tool calls only), or a collapsed thinking run that no text follows. */
    private piece;
    /** Whether text (not a tool call) comes right after thinking segment `index`. While the message
     * streams, an empty text part counts too, so the `∴` row doesn't blink out for the moment between
     * `text_start` and the first delta. */
    private textFollows;
    private flash;
    /** Drops pending flash timers when the transcript is cleared (/new, /resume, /reload). */
    dispose(): void;
    render(width: number): string[];
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    /** A thinking run that just ended flashes its rows' stretch of the turn spine (docs/tui-motion-
     * design.md M6); `row` counts the rows of the last render. */
    spineFlash(row: number): FlashState | undefined;
    invalidate(): void;
}
//# sourceMappingURL=assistant-block.d.ts.map