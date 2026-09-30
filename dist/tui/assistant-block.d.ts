import { type MarkdownTransformer, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
export declare class AssistantBlock implements Component {
    private readonly theme;
    private readonly transformers;
    private readonly container;
    private lastMessage;
    private lastStreaming;
    private readonly timing;
    private readonly expandedOverride;
    private globalExpanded;
    private readonly clock;
    constructor(theme: Theme, message: AssistantMessage, transformers: readonly MarkdownTransformer[], streaming: boolean);
    /** Finds which thinking segment (by its startIndex key) a streaming event's contentIndex falls
     * into, so a run built from several adjacent `thinking` content parts still gets one timer. */
    private recordEvent;
    updateContent(message: AssistantMessage, streaming: boolean, event?: AssistantMessageEvent): void;
    /** Ctrl+T (docs/tui-design.md 4.2/4.6's `app.thinking.toggle`): sets every run in this message to
     * the same state and drops any run a click had individually overridden, mirroring Pi's own
     * `setHideThinkingBlock` clearing `thinkingVisibilityOverrides`. */
    setGlobalExpanded(expanded: boolean): void;
    private rebuild;
    /** Item 1 (docs/tui-design.md 4.2): the time sits on the first *visible* line, like a user
     * message -- not literally render()'s line 0, which is usually the blank spacer Pi's component
     * always opens with. Reused, `spread`'s narrowing (chrome.ts's UserMessageBlock does the same)
     * costs a little wrap width throughout rather than only on that one line, which pi-tui's Markdown
     * has no hook to do more precisely. */
    render(width: number): string[];
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    invalidate(): void;
}
//# sourceMappingURL=assistant-block.d.ts.map