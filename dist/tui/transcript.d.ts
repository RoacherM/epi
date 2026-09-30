import { type AgentSession, type AgentSessionEvent, type Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
/** Images handed to the session in a message that isn't shown yet, and the numbers their chips had. */
export interface ImageReservation {
    numbers: number[];
    data: string[];
    text: string;
    /** direct: `session.prompt` on an idle session (Pi may resize or drop the images);
     * steer / followUp: queued while a turn runs; compaction: held by MMP until compaction ends. */
    mode: "direct" | "steer" | "followUp" | "compaction";
}
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
    private reservations;
    private readonly tools;
    private readonly userMessages;
    private readonly assistantBlocks;
    private streaming;
    private toolsExpanded;
    private thinkingExpanded;
    /** Set on the *first* `agent_start` of a prompt run (item 2's `Worked for Ns` footer), read and
     * cleared on `agent_settled` -- this process's own clock, not anything from the event stream,
     * since none of these events carry a timestamp. Not reset on a later `agent_start`: `agent.
     * continue()` (a retry, a compaction recovery, a queued continuation) re-emits it for the *same*
     * run, and the footer times the whole run from when the user asked for it, not its last leg. */
    private turnStartedAt;
    /** The most recent `agent_end`'s own messages, read back on `agent_settled` (the point that's
     * actually "this run is over") to find the last assistant reply's `stopReason`. */
    private lastTurnMessages;
    /** Set only by `auto_retry_end`'s "Retry cancelled" (Esc during a retry's backoff sleep never
     * reaches another `agent_end`, so it has no `stopReason` of its own to read back from
     * `lastTurnMessages` -- this is the only signal it leaves behind). `turnFooter()` ORs this with
     * `lastTurnMessages`'s own aborted check, the ordinary case (Esc during a normal response). */
    private turnAborted;
    constructor(tui: TUI, theme: Theme, session: AgentSession);
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session: AgentSession): void;
    /** The highest `[Image #N]` number in use: shown in a user message, or held by a reservation.
     * The editor numbers its next chip above it (D11). */
    get highestImageNumber(): number;
    /** Records that `images` (with the numbers their chips had) were handed over for sending in a
     * message that isn't shown yet, so the transcript shows them under those numbers once it is.
     * Returns undefined when there is nothing to keep. */
    reserveImages(images: readonly ImageContent[], text: string, mode: ImageReservation["mode"]): ImageReservation | undefined;
    /** The reservation's message was rejected, never shown (an extension handled it), or taken back. */
    releaseImages(reservation: ImageReservation | undefined): void;
    /** Takes back the queued message that carried exactly these images (Esc / Alt+Up restore): its
     * reservation is dropped and its numbers returned, so a restored chip keeps its number. */
    claimImages(images: readonly {
        data: string;
    }[], text: string): readonly number[] | undefined;
    /** The reservation for a message Pi delivers: the exact same images, preferring the same text,
     * then steering before follow-ups (Pi delivers them in that order), then the oldest. */
    private bestReservation;
    /** The numbers a live user message's images are shown under. A queued or steered message is
     * found by its images; the one direct prompt in flight can have been resized or lost images on
     * the way (Pi's `[Image omitted]`), so its survivors are matched to its originals one by one
     * and a dropped image's number is simply not used. Anything else gets fresh numbers. */
    private liveImageNumbers;
    /** A run ended and the session holds nothing queued: whatever is still reserved for a message
     * that never showed up (an extension's input handler took it) will not show up. */
    private dropStaleReservations;
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
     * `Stopped after Ns` for one that ended aborted. Called once, from `agent_settled` -- the whole
     * prompt run (every retry, compaction recovery and queued continuation) is over by then, so
     * `lastTurnMessages` holds the *last* `agent_end`'s payload, the one whose stopReason actually
     * decides the label; an empty array (a cancelled retry with no final assistant message at all)
     * just falls back to `turnAborted` alone. */
    private turnFooter;
    private addFinishedMessage;
    private syncToolCalls;
    private tool;
}
//# sourceMappingURL=transcript.d.ts.map