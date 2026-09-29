// Session events -> transcript blocks. v0 reuses Pi's exported message components; grok-style
// blocks replace them in M4 (docs/tui-design.md 4.2).
import { CustomMessageComponent, getMarkdownTheme, ToolExecutionComponent, } from "@earendil-works/pi-coding-agent";
import { AssistantBlock } from "./assistant-block.js";
import { UserBashBlock } from "./bash-block.js";
import { formatDuration, UserMessageBlock } from "./chrome.js";
import { piTui } from "./pi-tui.js";
import { toolBlock } from "./tools/block.js";
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
    messageCount = 0;
    tools = new Map();
    userMessages = [];
    assistantBlocks = [];
    streaming;
    toolsExpanded = false;
    thinkingExpanded = false;
    /** Set on `agent_start`, read (and cleared) on `agent_end`/`auto_retry_end` for the `Worked
     * for Ns` footer (item 2) -- this process's own clock, not anything from the event stream, since
     * neither event carries a timestamp. */
    turnStartedAt;
    constructor(tui, theme, session) {
        this.tui = tui;
        this.theme = theme;
        this.session = session;
        this.root.addChild({
            render: (width) => (this.messageCount === 0 ? this.header.render(width) : []),
            invalidate: () => this.header.invalidate(),
        });
        this.root.addChild(this.messages);
    }
    /** New session after /new, /resume, /reload: clear and replay its history. */
    reset(session) {
        this.session = session;
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
                this.turnStartedAt = Date.now();
                break;
            case "agent_end":
                // A run about to auto-retry isn't over yet (docs/tui-design.md 4.2's "each agent turn" is
                // this one from the user's point of view too): the footer waits for the retry's own
                // agent_end, or -- if the retry gives up -- auto_retry_end below.
                if (!event.willRetry)
                    this.turnFooter(event.messages);
                break;
            case "auto_retry_end":
                if (!event.success)
                    this.turnFooter([]);
                break;
            case "tool_execution_start":
                this.tool(event.toolName, event.toolCallId, event.args).markExecutionStarted();
                break;
            case "tool_execution_update":
                this.tool(event.toolName, event.toolCallId).updateResult({ ...event.partialResult, isError: false }, true);
                break;
            case "tool_execution_end":
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
            case "auto_retry_end":
                if (!event.success)
                    this.notice(`Retry failed: ${event.finalError ?? "unknown error"}`, "error");
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
        const component = new AssistantBlock(this.theme, message, this.session.extensionRunner.getMarkdownTransformers());
        component.setGlobalExpanded(this.thinkingExpanded);
        this.assistantBlocks.push(component);
        this.add(component, false);
        return component;
    }
    /** Item 2 (docs/tui-design.md 4.2): `Worked for Ns` below the last block of a settled turn,
     * `Stopped after Ns` for one that ended aborted. `messages` is `agent_end`'s own payload (this
     * run's messages, not the whole session) so the scan for the last assistant reply's `stopReason`
     * only ever looks at this turn -- an empty array (auto_retry_end giving up with no final
     * assistant message at all) just falls back to "Worked for". */
    turnFooter(messages) {
        if (this.turnStartedAt === undefined)
            return;
        const duration = Date.now() - this.turnStartedAt;
        this.turnStartedAt = undefined;
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        const label = lastAssistant?.stopReason === "aborted" ? "Stopped after" : "Worked for";
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
        const component = new ToolExecutionComponent(toolName, toolCallId, args ?? {}, undefined, renderers, this.tui, this.session.sessionManager.getCwd());
        component.setExpanded(this.toolsExpanded);
        this.tools.set(toolCallId, component);
        // Pi's tool component starts with its own blank row.
        this.add(component, false);
        return component;
    }
}
//# sourceMappingURL=transcript.js.map