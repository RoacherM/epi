// Session events -> transcript blocks. v0 reuses Pi's exported message components; grok-style
// blocks replace them in M4 (docs/tui-design.md 4.2).
import { CustomMessageComponent, getMarkdownTheme, } from "@earendil-works/pi-coding-agent";
import { AssistantBlock } from "./assistant-block.js";
import { UserBashBlock } from "./bash-block.js";
import { formatDuration, UserMessageBlock } from "./chrome.js";
import { piTui } from "./pi-tui.js";
import { toolBlock } from "./tools/block.js";
import { asGroupKind, GroupedMessages, ToolEntry } from "./tools/group.js";
import { builtInToolRenderers } from "./tools/index.js";
// grok block layout: a 1-column rail plus 2 columns of padding before block content.
const CONTENT_PAD = 3;
export class Transcript {
    tui;
    theme;
    session;
    /** Scrolled content: the welcome page (extension header) until the first message, then messages. */
    root = new piTui.Container();
    header = new piTui.Container();
    messages = new piTui.Container();
    groupedMessages;
    messageCount = 0;
    tools = new Map();
    userMessages = [];
    assistantBlocks = [];
    streaming;
    toolsExpanded = false;
    thinkingExpanded = false;
    /** Set on the *first* `agent_start` of a prompt run (item 2's `Worked for Ns` footer), read and
     * cleared on `agent_settled` -- this process's own clock, not anything from the event stream,
     * since none of these events carry a timestamp. Not reset on a later `agent_start`: `agent.
     * continue()` (a retry, a compaction recovery, a queued continuation) re-emits it for the *same*
     * run, and the footer times the whole run from when the user asked for it, not its last leg. */
    turnStartedAt;
    /** The most recent `agent_end`'s own messages, read back on `agent_settled` (the point that's
     * actually "this run is over") to find the last assistant reply's `stopReason`. */
    lastTurnMessages = [];
    /** Set only by `auto_retry_end`'s "Retry cancelled" (Esc during a retry's backoff sleep never
     * reaches another `agent_end`, so it has no `stopReason` of its own to read back from
     * `lastTurnMessages` -- this is the only signal it leaves behind). `turnFooter()` ORs this with
     * `lastTurnMessages`'s own aborted check, the ordinary case (Esc during a normal response). */
    turnAborted = false;
    constructor(tui, theme, session) {
        this.tui = tui;
        this.theme = theme;
        this.session = session;
        this.groupedMessages = new GroupedMessages(this.messages, this.tui, this.theme);
        this.root.addChild({
            render: (width) => (this.messageCount === 0 ? this.header.render(width) : []),
            invalidate: () => this.header.invalidate(),
        });
        // Grouping (docs/tui-design.md 4.2, tools/group.ts) is a render-time fold over `messages`'s own
        // children, so `add()` and everything below it are untouched -- only what wraps `messages` here.
        this.root.addChild(this.groupedMessages);
    }
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session) {
        this.session = session;
        // Drop pending completion-flash timers (tools/flash.ts) before the entries they belong to go
        // away, and the same for any group line mid-flash.
        for (const tool of this.tools.values())
            tool.dispose();
        this.groupedMessages.dispose();
        this.messages.clear();
        this.messageCount = 0;
        this.tools.clear();
        this.userMessages.length = 0;
        this.assistantBlocks.length = 0;
        this.streaming = undefined;
        // A turn from the outgoing session can never reach its agent_end here; drop it rather than
        // print a "Worked for" footer timed against the wrong session (and, per docs/tui-design.md
        // 4.2, replayed history doesn't get one anyway).
        this.turnStartedAt = undefined;
        this.lastTurnMessages = [];
        this.turnAborted = false;
        for (const message of session.messages) {
            this.addFinishedMessage(message);
        }
    }
    /** Ctrl+O (docs/tui-design.md 4.3, item 5): the same toggle that expands tool output also
     * expands a user message collapsed past 3 lines, instead of a second toggle. */
    setToolsExpanded(expanded) {
        this.toolsExpanded = expanded;
        for (const tool of this.tools.values())
            tool.setExpanded(expanded);
        for (const block of this.userMessages)
            block.setExpanded(expanded);
        // Ctrl+O is authoritative over grouping too: it always wins over a group left unfolded (or
        // partly revealed) by a click (tools/group.ts's GroupedMessages doc comment).
        this.groupedMessages.setToolsExpanded(expanded);
    }
    /** Ctrl+T (docs/tui-design.md 4.2/4.6, `app.thinking.toggle`): expands or collapses every
     * thinking run in every assistant message at once, independent of Ctrl+O's tool/user-message
     * toggle. */
    setThinkingExpanded(expanded) {
        this.thinkingExpanded = expanded;
        for (const block of this.assistantBlocks)
            block.setGlobalExpanded(expanded);
    }
    /**
     * A notice ("/tree is not in MMP TUI v2 yet", an extension load warning) is not a real
     * message: it must not count toward messageCount, which gates the welcome page's header.
     */
    notice(text, tone = "info") {
        const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
        this.add(new piTui.Text(this.theme.fg(color, text), 1, 0), true, false);
        this.tui.requestRender();
    }
    /** A block from the host (command output, info panels), separated like any other message. */
    addBlock(component) {
        this.add(component);
        this.tui.requestRender();
    }
    handle(event) {
        switch (event.type) {
            case "message_start":
                if (event.message.role === "user") {
                    this.addFinishedMessage(event.message);
                }
                else if (event.message.role === "assistant") {
                    this.streaming = this.assistant(event.message, true);
                }
                break;
            case "message_update":
                if (event.message.role === "assistant") {
                    this.streaming ??= this.assistant(event.message, true);
                    this.streaming.updateContent(event.message, true, event.assistantMessageEvent);
                    this.syncToolCalls(event.message, false);
                }
                break;
            case "message_end":
                if (event.message.role === "assistant") {
                    (this.streaming ?? this.assistant(event.message, false)).updateContent(event.message, false);
                    this.syncToolCalls(event.message, true);
                    this.streaming = undefined;
                }
                else if (event.message.role === "custom") {
                    this.addFinishedMessage(event.message);
                }
                break;
            case "agent_start":
                // `??=`, not `=`: `agent.continue()` (a queued follow-up, a retry, a compaction
                // continuation) re-emits agent_start for the *same* prompt run -- overwriting this would
                // reset the clock on every continuation instead of timing the whole run from when the user
                // actually asked for it.
                this.turnStartedAt ??= Date.now();
                break;
            case "agent_end":
                // Not the footer yet: agent_end fires once per continuation (a retry, a compaction
                // recovery), so the *last* one's messages -- read again by agent_settled below, once the
                // whole prompt run has actually finished -- are what decide the label.
                this.lastTurnMessages = event.messages;
                break;
            case "agent_settled":
                // Fired exactly once per session.prompt()/steer()/followUp() call, after every retry,
                // compaction recovery and queued continuation has run its course (agent-session.js
                // _runAgentPrompt's finally block) -- the one point that's both "the turn is really over"
                // and "print the footer exactly once", regardless of how many agent_start/agent_end pairs
                // happened along the way.
                this.turnFooter(this.lastTurnMessages);
                break;
            case "auto_retry_end":
                if (!event.success) {
                    this.notice(`Retry failed: ${event.finalError ?? "unknown error"}`, "error");
                    // Esc during the retry backoff sleep (AgentSession.abortRetry, called from the general
                    // abort path) surfaces here as `finalError: "Retry cancelled"` (agent-session.js's
                    // _finishCancelledRetry) -- the only signal this event carries that the *user* stopped
                    // it, as opposed to the retries simply running out.
                    if (event.finalError === "Retry cancelled")
                        this.turnAborted = true;
                }
                break;
            case "tool_execution_start":
                // Nested calls (from codemode scripts) render inside their parent's own block (Pi's
                // "CallToolResult"/console output there); a separate top-level block for the same call
                // would duplicate it. Mirrors Pi's own interactive-mode.js: "Nested calls (from codemode
                // scripts) are shown inside their parent's row" -- `if (event.parentToolCallId) break;`.
                // Unlike Pi's pendingTools.get() (a plain no-op lookup for an unknown id), MMP's tool()
                // helper always creates a new entry on first reference, so update/end must skip explicitly
                // too, not just rely on start never having created one.
                if (event.parentToolCallId !== undefined)
                    break;
                this.tool(event.toolName, event.toolCallId, event.args).markExecutionStarted();
                break;
            case "tool_execution_update":
                if (event.parentToolCallId !== undefined)
                    break;
                this.tool(event.toolName, event.toolCallId).updateResult({ ...event.partialResult, isError: false }, true);
                break;
            case "tool_execution_end":
                if (event.parentToolCallId !== undefined)
                    break;
                this.tool(event.toolName, event.toolCallId).updateResult({ ...event.result, isError: event.isError }, false);
                break;
            case "compaction_end":
                // event.errorMessage already reads e.g. "Compaction failed: ..." or "Auto-compaction
                // failed: ..." (agent-session.js); Pi's own interactive mode shows it verbatim too.
                if (event.errorMessage !== undefined)
                    this.notice(event.errorMessage, "error");
                // Pi's own Esc-during-compaction notice (interactive-mode.js ~2883-2889): "Compaction
                // cancelled" for a manual /compact the user stopped, "Auto-compaction cancelled" (a lower
                // key, since nothing the user asked for was lost) for one the agent started on its own.
                else if (event.aborted)
                    this.notice(event.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled", event.reason === "manual" ? "error" : "info");
                else
                    this.notice("Context compacted.");
                break;
            case "auto_retry_start":
                this.notice(`Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`, "warning");
                break;
            default:
                break;
        }
        this.tui.requestRender();
    }
    /**
     * `gap: false` for components that already start with a blank row (Pi's assistant and tool
     * components). `counts: false` for a notice, which shares the spacer rhythm but must not hide
     * the welcome page (see `notice()`).
     */
    add(component, gap = true, counts = true) {
        if (gap && this.messages.children.length > 0)
            this.messages.addChild(new piTui.Spacer(1));
        this.messages.addChild(component);
        if (counts)
            this.messageCount += 1;
    }
    assistant(message, streaming) {
        // The current Ctrl+T state goes in at construction (not a `setGlobalExpanded()` call right
        // after), so a replayed message only ever rebuilds once instead of twice.
        const component = new AssistantBlock(this.theme, message, this.session.extensionRunner.getMarkdownTransformers(), streaming, this.thinkingExpanded);
        this.assistantBlocks.push(component);
        this.add(component, false);
        return component;
    }
    /** Item 2 (docs/tui-design.md 4.2): `Worked for Ns` below the last block of a settled turn,
     * `Stopped after Ns` for one that ended aborted. Called once, from `agent_settled` -- the whole
     * prompt run (every retry, compaction recovery and queued continuation) is over by then, so
     * `lastTurnMessages` holds the *last* `agent_end`'s payload, the one whose stopReason actually
     * decides the label; an empty array (a cancelled retry with no final assistant message at all)
     * just falls back to `turnAborted` alone. */
    turnFooter(messages) {
        if (this.turnStartedAt === undefined)
            return;
        const duration = Date.now() - this.turnStartedAt;
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        const aborted = this.turnAborted || lastAssistant?.stopReason === "aborted";
        this.turnStartedAt = undefined;
        this.lastTurnMessages = [];
        this.turnAborted = false;
        const label = aborted ? "Stopped after" : "Worked for";
        this.add(new piTui.Text(this.theme.fg("muted", `${label} ${formatDuration(duration)}`), CONTENT_PAD, 0), true, false);
    }
    addFinishedMessage(message) {
        switch (message.role) {
            case "user": {
                const block = new UserMessageBlock(this.theme, message.content, new Date(message.timestamp ?? Date.now()));
                block.setExpanded(this.toolsExpanded);
                this.userMessages.push(block);
                this.add(block);
                break;
            }
            case "assistant":
                this.assistant(message, false);
                this.syncToolCalls(message, true);
                break;
            case "toolResult":
                this.tool(message.toolName, message.toolCallId).updateResult(message, false);
                break;
            case "bashExecution":
                this.add(UserBashBlock.fromMessage(this.theme, message));
                break;
            case "custom":
                if (message.display) {
                    this.add(new CustomMessageComponent(message, this.session.extensionRunner.getMessageRenderer(message.customType), getMarkdownTheme()));
                }
                break;
            default:
                break;
        }
    }
    syncToolCalls(message, complete) {
        for (const part of message.content) {
            if (part.type !== "toolCall")
                continue;
            const tool = this.tool(part.name, part.id, part.arguments);
            if (complete)
                tool.setArgsComplete();
        }
    }
    tool(toolName, toolCallId, args) {
        const existing = this.tools.get(toolCallId);
        if (existing !== undefined) {
            if (args !== undefined)
                existing.updateArgs(args);
            return existing;
        }
        // Pi's built-in tools come with Pi's own renderers; MMP swaps in its grok-style ones. Extension
        // tools, including an extension overriding a built-in name, keep their own renderers.
        const definition = this.session.getToolDefinition(toolName);
        const isBuiltIn = this.session.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
        const renderers = toolBlock(toolName, (isBuiltIn ? builtInToolRenderers[toolName] : undefined) ?? definition);
        const component = new ToolEntry(toolName, toolCallId, args ?? {}, renderers, this.tui, this.session.sessionManager.getCwd(), this.theme, asGroupKind(toolName, isBuiltIn));
        component.setExpanded(this.toolsExpanded);
        this.tools.set(toolCallId, component);
        // Pi's tool component starts with its own blank row.
        this.add(component, false);
        return component;
    }
}
//# sourceMappingURL=transcript.js.map