import { type MarkdownTransformer, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
export declare class AssistantBlock implements Component {
    private readonly theme;
    private readonly transformers;
    private readonly requestRender;
    private readonly container;
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
    private readonly clock;
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
    private flash;
    /** Drops pending flash timers when the transcript is cleared (/new, /resume, /reload). */
    dispose(): void;
    /** The width the inner container is actually rendered at -- narrower than the component's own,
     * to leave room for the clock (chrome.ts's `UserMessageBlock` does the same). Shared by `render()`
     * and `handleMouse()` so a click is dispatched against the same row heights it was drawn with. */
    private innerWidth;
    /** Item 1 (docs/tui-design.md 4.2): the time sits on the first *visible* line, like a user
     * message -- not literally render()'s line 0, which is usually the blank spacer Pi's component
     * always opens with. Reused, `spread`'s narrowing (chrome.ts's UserMessageBlock does the same)
     * costs a little wrap width throughout rather than only on that one line, which pi-tui's Markdown
     * has no hook to do more precisely. */
    render(width: number): string[];
    /** `event.width` must match what `render()` last drew the container at, or pi-tui's `Container.
     * handleMouse` recomputes row heights at the wrong (full, not narrowed) width and a click lands on
     * the wrong segment whenever an earlier one wraps differently at the two widths -- `Container`
     * only reuses its cached per-child heights when the width matches exactly. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    invalidate(): void;
}
//# sourceMappingURL=assistant-block.d.ts.map