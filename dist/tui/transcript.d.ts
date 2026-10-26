import { type AgentSession, type AgentSessionEvent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import { type InspectTarget } from "./buffer/inspector.js";
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
    private highestImage;
    private readonly tools;
    private readonly userMessages;
    private readonly assistantBlocks;
    private streaming;
    /** The extensions' all-blocks toggle (pi.ui.setToolsExpanded). */
    private toolsExpanded;
    /** Tool calls Ctrl+O opened, by call id: it toggles only the most recent block (a read-only run is
     * one block: all its members). Independent of `toolsExpanded`, which neither sets nor clears it
     * (docs/tui-ctrl-o-per-block-design.md §4). Cleared by reset(); never closed on its own. */
    private readonly expandedBlocks;
    private thinkingExpanded;
    /** The open block inspector, at most one (docs/tui-buffer-overlay-design.md §4): opening
     * another replaces it, and reset() (/new, /resume, /reload, /tree) closes it. */
    private inspector;
    /** Set on the *first* `agent_start` of a prompt run (item 2's `Worked for Ns` footer), read and
     * cleared on `agent_settled` -- this process's own clock, not anything from the event stream,
     * since none of these events carry a timestamp. Not reset on a later `agent_start`: `agent.
     * continue()` (a retry, a compaction recovery) re-emits it for the *same* run, and the footer
     * times the whole run from when the user asked for it, not its last leg. A queued follow-up
     * restarts it at its own user message instead (`finishedReply`, dogfood D23). */
    private turnStartedAt;
    /** The most recent `agent_end`'s own messages, read back on `agent_settled` (the point that's
     * actually "this run is over") to find the last assistant reply's `stopReason`. */
    private lastTurnMessages;
    /** Set by `auto_retry_end`'s "Retry cancelled" and by `markStopped()` (Esc during a retry's
     * backoff sleep or a post-run compaction never reaches another `agent_end`, so it has no
     * `stopReason` of its own to read back from `lastTurnMessages` -- this is the only signal it
     * leaves behind). `turnFooter()` ORs this with `lastTurnMessages`'s own
     * aborted check, the ordinary case (Esc during a normal response). */
    private turnAborted;
    /** The timed turn's last assistant reply, once it ended with no tool calls or its tool batch
     * ended with every tool returning `terminate: true`: the agent would have stopped there, so a
     * user message arriving after it (a queued follow-up, or a steer the loop picked up at that
     * point) starts a new turn with its own footer (dogfood D23, D43). Cleared as soon as another
     * assistant message starts. A steer delivered between tool calls finds this unset and stays part
     * of the running turn. */
    private finishedReply;
    /** The last reply with tool calls, and whether every tool of its batch that has ended so far
     * returned `terminate: true` (undefined before the first one ends). */
    private toolBatch;
    constructor(tui: TUI, theme: Theme, session: AgentSession);
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session: AgentSession): void;
    /** Shows `target` in the floating inspector, replacing one already open; it has the keyboard
     * until closed, then focus goes back to whatever had it. */
    inspect(target: InspectTarget): void;
    closeInspector(): void;
    /** The highest `[Image #N]` label in this session's user messages: those shown, and those
     * handed to the session but not shown yet (queued, steered, or still on the way). The editor
     * numbers its next chip above it (D11). */
    get highestImageNumber(): number;
    /** A user message's text was shown or handed to the session: its labels are used up. */
    noteImageLabels(text: string): void;
    /** The extensions' all-blocks toggle (pi.ui.setToolsExpanded): every tool block, and every user
     * message collapsed past 3 lines. Off, the blocks Ctrl+O opened stay open. */
    setToolsExpanded(expanded: boolean): void;
    /** Ctrl+O (docs/tui-ctrl-o-per-block-design.md §4.2): opens or closes the most recent tool block
     * only. False when there is none. */
    toggleLastToolBlock(): boolean;
    /** Ctrl+T (docs/tui-design.md 4.2/4.6, `app.thinking.toggle`): expands or collapses every
     * thinking run in every assistant message at once, independent of Ctrl+O's tool/user-message
     * toggle. */
    setThinkingExpanded(expanded: boolean): void;
    /**
     * A notice ("/tree is not in Epi TUI v2 yet", an extension load warning) is not a real
     * message: it must not count toward messageCount, which gates the welcome page's header.
     */
    notice(text: string, tone?: "info" | "warning" | "error"): void;
    /** A block from the host (command output, info panels), separated like any other message. */
    addBlock(component: Component): void;
    handle(event: AgentSessionEvent): void;
    private messageStarted;
    private messageEnded;
    private retryFailed;
    private toolEnded;
    private compactionEnded;
    /**
     * `gap: false` for components that already start with a blank row (Pi's assistant and tool
     * components). `counts: false` for a notice, which shares the spacer rhythm but must not hide
     * the welcome page (see `notice()`).
     */
    private add;
    private assistant;
    /** The user stopped the running prompt (Esc, Ctrl+C, an extension's ctx.abort()): its footer
     * reads "Stopped after" even when no event says so -- an automatic compaction it cancelled ends
     * with only `compaction_end.aborted`, the same as one an extension cancelled (dogfood D17). Only
     * inside a timed run: outside one (a manual /compact) there is no footer to mark, and the next
     * run must not inherit it. */
    markStopped(): void;
    /** Item 2 (docs/tui-design.md 4.2): `Worked for Ns` below the last block of a settled turn,
     * `Stopped after Ns` for one that ended aborted. Called from a queued follow-up's user message
     * for the turn before it, and once from `agent_settled` for the last one -- the whole prompt run
     * (every retry and compaction recovery) is over by then, so
     * `lastTurnMessages` holds the *last* `agent_end`'s payload, the one whose stopReason actually
     * decides the label; an empty array (a cancelled retry with no final assistant message at all)
     * just falls back to `turnAborted` alone. */
    private turnFooter;
    private addFinishedMessage;
    private syncToolCalls;
    private tool;
}
//# sourceMappingURL=transcript.d.ts.map