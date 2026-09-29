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
    private messageCount;
    private readonly tools;
    private readonly userMessages;
    private streaming;
    private toolsExpanded;
    constructor(tui: TUI, theme: Theme, session: AgentSession);
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session: AgentSession): void;
    /** Ctrl+O (docs/tui-design.md 4.3, item 5): the same toggle that expands tool output also
     * expands a user message collapsed past 3 lines, instead of a second toggle. */
    setToolsExpanded(expanded: boolean): void;
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
    private addFinishedMessage;
    private syncToolCalls;
    private tool;
}
//# sourceMappingURL=transcript.d.ts.map