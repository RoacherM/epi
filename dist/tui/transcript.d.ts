import { type AgentSession, type AgentSessionEvent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
export declare class Transcript {
    private readonly tui;
    private readonly theme;
    private readonly cwd;
    private session;
    /** Scrolled content: extension header first, then messages. */
    readonly root: Container;
    readonly header: Container;
    private readonly messages;
    private readonly tools;
    private streaming;
    private toolsExpanded;
    constructor(tui: TUI, theme: Theme, cwd: string, session: AgentSession);
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session: AgentSession): void;
    setToolsExpanded(expanded: boolean): void;
    notice(text: string, tone?: "info" | "warning" | "error"): void;
    handle(event: AgentSessionEvent): void;
    private add;
    private assistant;
    private addFinishedMessage;
    private syncToolCalls;
    private tool;
}
//# sourceMappingURL=transcript.d.ts.map