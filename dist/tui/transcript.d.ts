import { type AgentSession, type AgentSessionEvent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
export declare class Transcript {
    private readonly tui;
    private readonly theme;
    private session;
    /** Scrolled content: the welcome page (extension header) until the first message, then messages. */
    readonly root: Container;
    readonly header: Container;
    private readonly messages;
    private readonly groupedMessages;
    private messageCount;
    private readonly tools;
    private readonly userMessages;
    private readonly assistantBlocks;
    private streaming;
    private toolsExpanded;
    private thinkingExpanded;
    /** Set on `agent_start`, read (and cleared) on `agent_end`/`auto_retry_end` for the `Worked
     * for Ns` footer (item 2) -- this process's own clock, not anything from the event stream, since
     * neither event carries a timestamp. */
    private turnStartedAt;
    constructor(tui: TUI, theme: Theme, session: AgentSession);
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session: AgentSession): void;
    /** Ctrl+O (docs/tui-design.md 4.3, item 5): the same toggle that expands tool output also
     * expands a user message collapsed past 3 lines, instead of a second toggle. */
    setToolsExpanded(expanded: boolean): void;
    /** Ctrl+T (docs/tui-design.md 4.2/4.6, `app.thinking.toggle`): expands or collapses every
     * thinking run in every assistant message at once, independent of Ctrl+O's tool/user-message
     * toggle. */
    setThinkingExpanded(expanded: boolean): void;
    /**
     * A notice ("/tree is not in MMP TUI v2 yet", an extension load warning) is not a real
     * message: it must not count toward messageCount, which gates the welcome page's header.
     */
    notice(text: string, tone?: "info" | "warning" | "error"): void;
    /** A block from the host (command output, info panels), separated like any other message. */
    addBlock(component: Component): void;
    handle(event: AgentSessionEvent): void;
    /**
     * `gap: false` for components that already start with a blank row (Pi's assistant and tool
     * components). `counts: false` for a notice, which shares the spacer rhythm but must not hide
     * the welcome page (see `notice()`).
     */
    private add;
    private assistant;
    /** Item 2 (docs/tui-design.md 4.2): `Worked for Ns` below the last block of a settled turn,
     * `Stopped after Ns` for one that ended aborted. `messages` is `agent_end`'s own payload (this
     * run's messages, not the whole session) so the scan for the last assistant reply's `stopReason`
     * only ever looks at this turn -- an empty array (auto_retry_end giving up with no final
     * assistant message at all) just falls back to "Worked for". */
    private turnFooter;
    private addFinishedMessage;
    private syncToolCalls;
    private tool;
}
//# sourceMappingURL=transcript.d.ts.map