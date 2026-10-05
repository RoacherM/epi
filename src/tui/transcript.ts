// Session events -> transcript blocks. v0 reuses Pi's exported message components; grok-style
// blocks replace them in M4 (docs/tui-design.md 4.2).
import {
  type AgentSession,
  type AgentSessionEvent,
  CustomMessageComponent,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";

import { AssistantBlock } from "./assistant-block.js";
import { UserBashBlock } from "./bash-block.js";
import { formatDuration, messageText, UserMessageBlock } from "./chrome.js";
import { rewritePiText } from "../pi-output.js";
import { imageLabelNumbers } from "./paste-chips.js";
import { piTui } from "./pi-tui.js";
import { toolBlock } from "./tools/block.js";
import { asGroupKind, GroupedMessages, ToolEntry } from "./tools/group.js";
import { builtInToolRenderers } from "./tools/index.js";

type AgentMessage = AgentSession["messages"][number];

// grok block layout: a 1-column rail plus 2 columns of padding before block content.
const CONTENT_PAD = 3;

export class Transcript {
  /** Scrolled content: the welcome page (extension header) until the first message, then messages. */
  readonly root: Container = new piTui.Container();
  readonly header: Container = new piTui.Container();
  private readonly messages: Container = new piTui.Container();
  private readonly groupedMessages: GroupedMessages;
  private messageCount = 0;
  private highestImage = 0;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly userMessages: UserMessageBlock[] = [];
  private readonly assistantBlocks: AssistantBlock[] = [];
  private streaming: AssistantBlock | undefined;
  private toolsExpanded = false;
  private thinkingExpanded = false;
  /** Set on the *first* `agent_start` of a prompt run (item 2's `Worked for Ns` footer), read and
   * cleared on `agent_settled` -- this process's own clock, not anything from the event stream,
   * since none of these events carry a timestamp. Not reset on a later `agent_start`: `agent.
   * continue()` (a retry, a compaction recovery) re-emits it for the *same* run, and the footer
   * times the whole run from when the user asked for it, not its last leg. A queued follow-up
   * restarts it at its own user message instead (`finishedReply`, dogfood D23). */
  private turnStartedAt: number | undefined;
  /** The most recent `agent_end`'s own messages, read back on `agent_settled` (the point that's
   * actually "this run is over") to find the last assistant reply's `stopReason`. */
  private lastTurnMessages: readonly { role: string; stopReason?: string }[] = [];
  /** Set by `auto_retry_end`'s "Retry cancelled" and by `markStopped()` (Esc during a retry's
   * backoff sleep or a post-run compaction never reaches another `agent_end`, so it has no
   * `stopReason` of its own to read back from `lastTurnMessages` -- this is the only signal it
   * leaves behind). `turnFooter()` ORs this with `lastTurnMessages`'s own
   * aborted check, the ordinary case (Esc during a normal response). */
  private turnAborted = false;
  /** The timed turn's last assistant reply, once it ended with no tool calls or its tool batch
   * ended with every tool returning `terminate: true`: the agent would have stopped there, so a
   * user message arriving after it (a queued follow-up, or a steer the loop picked up at that
   * point) starts a new turn with its own footer (dogfood D23, D43). Cleared as soon as another
   * assistant message starts. A steer delivered between tool calls finds this unset and stays part
   * of the running turn. */
  private finishedReply: { role: string; stopReason?: string } | undefined;
  /** The last reply with tool calls, and whether every tool of its batch that has ended so far
   * returned `terminate: true` (undefined before the first one ends). */
  private toolBatch: { reply: { role: string; stopReason?: string }; terminates: boolean | undefined } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private session: AgentSession,
  ) {
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
  reset(session: AgentSession): void {
    this.session = session;
    // Drop pending completion-flash timers (tools/flash.ts) before the entries they belong to go
    // away, and the same for any group line mid-flash.
    for (const tool of this.tools.values()) tool.dispose();
    for (const block of this.assistantBlocks) block.dispose();
    this.groupedMessages.dispose();
    this.messages.clear();
    this.messageCount = 0;
    this.highestImage = 0;
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
    this.finishedReply = undefined;
    this.toolBatch = undefined;
    for (const message of session.messages) {
      this.addFinishedMessage(message);
    }
    // After a compaction, session.messages start at the summary; the compacted-away user messages
    // are still on the branch, and the summary may still name their labels, so those stay used
    // (D11). Test stand-ins without getBranch have no compaction to account for.
    for (const entry of session.sessionManager.getBranch?.() ?? []) {
      if (entry.type === "message" && entry.message.role === "user") this.noteImageLabels(messageText(entry.message.content));
    }
  }

  /** The highest `[Image #N]` label in this session's user messages: those shown, and those
   * handed to the session but not shown yet (queued, steered, or still on the way). The editor
   * numbers its next chip above it (D11). */
  get highestImageNumber(): number {
    return this.highestImage;
  }

  /** A user message's text was shown or handed to the session: its labels are used up. */
  noteImageLabels(text: string): void {
    this.highestImage = Math.max(this.highestImage, ...imageLabelNumbers(text));
  }

  /** Ctrl+O (docs/tui-design.md 4.3, item 5): the same toggle that expands tool output also
   * expands a user message collapsed past 3 lines, instead of a second toggle. */
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.tools.values()) tool.setExpanded(expanded);
    for (const block of this.userMessages) block.setExpanded(expanded);
    // Ctrl+O is authoritative over grouping too: it always wins over a group left unfolded (or
    // partly revealed) by a click (tools/group.ts's GroupedMessages doc comment).
    this.groupedMessages.setToolsExpanded(expanded);
  }

  /** Ctrl+T (docs/tui-design.md 4.2/4.6, `app.thinking.toggle`): expands or collapses every
   * thinking run in every assistant message at once, independent of Ctrl+O's tool/user-message
   * toggle. */
  setThinkingExpanded(expanded: boolean): void {
    this.thinkingExpanded = expanded;
    for (const block of this.assistantBlocks) block.setGlobalExpanded(expanded);
  }

  /**
   * A notice ("/tree is not in Epi TUI v2 yet", an extension load warning) is not a real
   * message: it must not count toward messageCount, which gates the welcome page's header.
   */
  notice(text: string, tone: "info" | "warning" | "error" = "info"): void {
    const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
    // Every notice passes here, including Pi's errors ("No API key found for ...", dogfood D55).
    this.add(new piTui.Text(this.theme.fg(color, rewritePiText(text)), 1, 0), true, false);
    this.tui.requestRender();
  }

  /** A block from the host (command output, info panels), separated like any other message. */
  addBlock(component: Component): void {
    this.add(component);
    this.tui.requestRender();
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        this.messageStarted(event.message);
        break;
      case "message_update":
        if (event.message.role === "assistant") {
          this.streaming ??= this.assistant(event.message, true);
          this.streaming.updateContent(event.message, true, event.assistantMessageEvent);
          this.syncToolCalls(event.message, false);
        }
        break;
      case "message_end":
        this.messageEnded(event.message);
        break;
      case "agent_start":
        // `??=`, not `=`: `agent.continue()` (a retry, a compaction continuation) re-emits
        // agent_start for the *same* prompt run -- overwriting this would reset the clock on every
        // continuation instead of timing the whole run from when the user actually asked for it. A
        // queued follow-up's own clock starts at its user message_start (above).
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
        // and "print the (last turn's) footer exactly once", regardless of how many
        // agent_start/agent_end pairs happened along the way.
        this.turnFooter(this.lastTurnMessages);
        break;
      case "auto_retry_end":
        if (!event.success) this.retryFailed(event.finalError);
        break;
      case "tool_execution_start":
        // Nested calls (from codemode scripts) render inside their parent's own block (Pi's
        // "CallToolResult"/console output there); a separate top-level block for the same call
        // would duplicate it. Mirrors Pi's own interactive-mode.js: "Nested calls (from codemode
        // scripts) are shown inside their parent's row" -- `if (event.parentToolCallId) break;`.
        // Unlike Pi's pendingTools.get() (a plain no-op lookup for an unknown id), Epi's tool()
        // helper always creates a new entry on first reference, so update/end must skip explicitly
        // too, not just rely on start never having created one.
        if (event.parentToolCallId !== undefined) break;
        this.tool(event.toolName, event.toolCallId, event.args).markExecutionStarted();
        break;
      case "tool_execution_update":
        if (event.parentToolCallId !== undefined) break;
        this.tool(event.toolName, event.toolCallId).updateResult({ ...event.partialResult, isError: false }, true);
        break;
      case "tool_execution_end":
        if (event.parentToolCallId !== undefined) break;
        this.toolEnded(event);
        break;
      case "compaction_end":
        this.compactionEnded(event);
        break;
      case "auto_retry_start":
        this.notice(`Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`, "warning");
        break;
      default:
        break;
    }
    this.tui.requestRender();
  }

  private messageStarted(message: AgentMessage): void {
    if (message.role === "user") {
      // Pi delivers a queued follow-up inside the same run (agent-loop.js's runLoop drains
      // getFollowUpMessages when the agent would stop, then emits turn_start + this user
      // message_start) or, when it was queued after the loop's last poll, through
      // agent.continue() (another agent_start, then this message_start). This user message is
      // the one boundary both paths share: close the previous turn's footer above it. That turn
      // finished on its own, so a stop pending here (Esc after its reply ended, while
      // prepareNextTurn still compacts) belongs to the new turn, not to its label.
      if (this.turnStartedAt !== undefined && this.finishedReply !== undefined) {
        const stopPending = this.turnAborted;
        this.turnAborted = false;
        this.turnFooter([this.finishedReply]);
        this.turnStartedAt = Date.now();
        this.turnAborted = stopPending;
      }
      this.addFinishedMessage(message);
    } else if (message.role === "assistant") {
      this.finishedReply = undefined;
      this.toolBatch = undefined;
      this.streaming = this.assistant(message, true);
    }
  }

  private messageEnded(message: AgentMessage): void {
    if (message.role === "assistant") {
      (this.streaming ?? this.assistant(message, false)).updateContent(message, false);
      this.syncToolCalls(message, true);
      this.streaming = undefined;
      const hasToolCalls = message.content.some((part) => part.type === "toolCall");
      this.finishedReply = hasToolCalls ? undefined : message;
      this.toolBatch = hasToolCalls ? { reply: message, terminates: undefined } : undefined;
    } else if (message.role === "custom") {
      this.addFinishedMessage(message);
    }
  }

  private retryFailed(finalError: string | undefined): void {
    this.notice(`Retry failed: ${finalError ?? "unknown error"}`, "error");
    // Esc during the retry backoff sleep (AgentSession.abortRetry, called from the general
    // abort path) surfaces here as `finalError: "Retry cancelled"` (agent-session.js's
    // _finishCancelledRetry) -- the only signal this event carries that the *user* stopped
    // it, as opposed to the retries simply running out.
    if (finalError === "Retry cancelled") this.turnAborted = true;
  }

  private toolEnded(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
    this.tool(event.toolName, event.toolCallId).updateResult({ ...event.result, isError: event.isError }, false);
    // Pi also stops, and drains follow-ups, after a batch whose every tool returned `terminate:
    // true` (agent-loop.js shouldTerminateToolBatch; each of the batch's calls ends here once).
    if (this.toolBatch !== undefined) {
      this.toolBatch.terminates = (this.toolBatch.terminates ?? true) && event.result?.terminate === true;
      this.finishedReply = this.toolBatch.terminates ? this.toolBatch.reply : undefined;
    }
  }

  private compactionEnded(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): void {
    // event.errorMessage already reads e.g. "Compaction failed: ..." or "Auto-compaction
    // failed: ..." (agent-session.js); Pi's own interactive mode shows it verbatim too.
    if (event.errorMessage !== undefined) this.notice(event.errorMessage, "error");
    // Pi's own Esc-during-compaction notice (interactive-mode.js ~2883-2889): "Compaction
    // cancelled" for a manual /compact the user stopped, "Auto-compaction cancelled" (a lower
    // key, since nothing the user asked for was lost) for one the agent started on its own.
    else if (event.aborted) this.notice(event.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled", event.reason === "manual" ? "error" : "info");
    else this.notice("Context compacted.");
    // `aborted` is also set when an extension's session_before_compact cancels it, so it can't
    // mean the user stopped the run; markStopped() carries that (dogfood D17).
  }

  /**
   * `gap: false` for components that already start with a blank row (Pi's assistant and tool
   * components). `counts: false` for a notice, which shares the spacer rhythm but must not hide
   * the welcome page (see `notice()`).
   */
  private add(component: Component, gap = true, counts = true): void {
    if (gap && this.messages.children.length > 0) this.messages.addChild(new piTui.Spacer(1));
    this.messages.addChild(component);
    if (counts) this.messageCount += 1;
  }

  private assistant(message: Extract<AgentMessage, { role: "assistant" }>, streaming: boolean): AssistantBlock {
    // The current Ctrl+T state goes in at construction (not a `setGlobalExpanded()` call right
    // after), so a replayed message only ever rebuilds once instead of twice.
    const component = new AssistantBlock(this.theme, message, this.session.extensionRunner.getMarkdownTransformers(), streaming, this.thinkingExpanded, () => this.tui.requestRender());
    this.assistantBlocks.push(component);
    this.add(component, false);
    return component;
  }

  /** The user stopped the running prompt (Esc, Ctrl+C, an extension's ctx.abort()): its footer
   * reads "Stopped after" even when no event says so -- an automatic compaction it cancelled ends
   * with only `compaction_end.aborted`, the same as one an extension cancelled (dogfood D17). Only
   * inside a timed run: outside one (a manual /compact) there is no footer to mark, and the next
   * run must not inherit it. */
  markStopped(): void {
    if (this.turnStartedAt !== undefined) this.turnAborted = true;
  }

  /** Item 2 (docs/tui-design.md 4.2): `Worked for Ns` below the last block of a settled turn,
   * `Stopped after Ns` for one that ended aborted. Called from a queued follow-up's user message
   * for the turn before it, and once from `agent_settled` for the last one -- the whole prompt run
   * (every retry and compaction recovery) is over by then, so
   * `lastTurnMessages` holds the *last* `agent_end`'s payload, the one whose stopReason actually
   * decides the label; an empty array (a cancelled retry with no final assistant message at all)
   * just falls back to `turnAborted` alone. */
  private turnFooter(messages: readonly { role: string; stopReason?: string }[]): void {
    if (this.turnStartedAt === undefined) return;
    const duration = Date.now() - this.turnStartedAt;
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    const aborted = this.turnAborted || lastAssistant?.stopReason === "aborted";
    this.turnStartedAt = undefined;
    this.lastTurnMessages = [];
    this.turnAborted = false;
    this.finishedReply = undefined;
    this.toolBatch = undefined;
    const label = aborted ? "Stopped after" : "Worked for";
    this.add(new piTui.Text(this.theme.fg("muted", `${label} ${formatDuration(duration)}`), CONTENT_PAD, 0), true, false);
  }

  private addFinishedMessage(message: AgentMessage): void {
    switch (message.role) {
      case "user": {
        this.noteImageLabels(messageText(message.content));
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
          this.add(new CustomMessageComponent(
            message,
            this.session.extensionRunner.getMessageRenderer(message.customType),
            getMarkdownTheme(),
          ));
        }
        break;
      default:
        break;
    }
  }

  private syncToolCalls(message: Extract<AgentMessage, { role: "assistant" }>, complete: boolean): void {
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const tool = this.tool(part.name, part.id, part.arguments);
      if (complete) tool.setArgsComplete();
    }
  }

  private tool(toolName: string, toolCallId: string, args?: unknown): ToolEntry {
    const existing = this.tools.get(toolCallId);
    if (existing !== undefined) {
      if (args !== undefined) existing.updateArgs(args);
      return existing;
    }
    // Pi's built-in tools come with Pi's own renderers; Epi swaps in its grok-style ones. Extension
    // tools, including an extension overriding a built-in name, keep their own renderers.
    const definition = this.session.getToolDefinition(toolName);
    const isBuiltIn = this.session.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
    const renderers = toolBlock(toolName, (isBuiltIn ? builtInToolRenderers[toolName] : undefined) ?? definition);
    const component = new ToolEntry(
      toolName,
      toolCallId,
      args ?? {},
      renderers,
      this.tui,
      this.session.sessionManager.getCwd(),
      this.theme,
      asGroupKind(toolName, isBuiltIn),
    );
    component.setExpanded(this.toolsExpanded);
    this.tools.set(toolCallId, component);
    // Pi's tool component starts with its own blank row.
    this.add(component, false);
    return component;
  }
}
