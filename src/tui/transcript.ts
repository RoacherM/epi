// Session events -> transcript blocks. v0 reuses Pi's exported message components; grok-style
// blocks replace them in M4 (docs/tui-design.md 4.2).
import {
  type AgentSession,
  type AgentSessionEvent,
  AssistantMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  type Theme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";

import { UserBashBlock } from "./bash-block.js";
import { UserMessageBlock } from "./chrome.js";
import { piTui } from "./pi-tui.js";
import { toolBlock } from "./tools/block.js";
import { builtInToolRenderers } from "./tools/index.js";

type AgentMessage = AgentSession["messages"][number];

// grok block layout: a 1-column rail plus 2 columns of padding before block content.
const CONTENT_PAD = 3;

export class Transcript {
  /** Scrolled content: the welcome page (extension header) until the first message, then messages. */
  readonly root: Container = new piTui.Container();
  readonly header: Container = new piTui.Container();
  private readonly messages: Container = new piTui.Container();
  private messageCount = 0;
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly userMessages: UserMessageBlock[] = [];
  private streaming: AssistantMessageComponent | undefined;
  private toolsExpanded = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private session: AgentSession,
  ) {
    this.root.addChild({
      render: (width) => (this.messageCount === 0 ? this.header.render(width) : []),
      invalidate: () => this.header.invalidate(),
    });
    this.root.addChild(this.messages);
  }

  /** New session after /new, /resume, /reload: clear and replay its history. */
  reset(session: AgentSession): void {
    this.session = session;
    this.messages.clear();
    this.messageCount = 0;
    this.tools.clear();
    this.userMessages.length = 0;
    this.streaming = undefined;
    for (const message of session.messages) {
      this.addFinishedMessage(message);
    }
  }

  /** Ctrl+O (docs/tui-design.md 4.3, item 5): the same toggle that expands tool output also
   * expands a user message collapsed past 3 lines, instead of a second toggle. */
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.tools.values()) tool.setExpanded(expanded);
    for (const block of this.userMessages) block.setExpanded(expanded);
  }

  /**
   * A notice ("/tree is not in MMP TUI v2 yet", an extension load warning) is not a real
   * message: it must not count toward messageCount, which gates the welcome page's header.
   */
  notice(text: string, tone: "info" | "warning" | "error" = "info"): void {
    const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
    this.add(new piTui.Text(this.theme.fg(color, text), 1, 0), true, false);
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
        if (event.message.role === "user") {
          this.addFinishedMessage(event.message);
        } else if (event.message.role === "assistant") {
          this.streaming = this.assistant(event.message, true);
        }
        break;
      case "message_update":
        if (event.message.role === "assistant") {
          this.streaming ??= this.assistant(event.message, true);
          this.streaming.updateContent(event.message, true);
          this.syncToolCalls(event.message, false);
        }
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          (this.streaming ?? this.assistant(event.message, false)).updateContent(event.message, false);
          this.syncToolCalls(event.message, true);
          this.streaming = undefined;
        } else if (event.message.role === "custom") {
          this.addFinishedMessage(event.message);
        }
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
        if (event.errorMessage !== undefined) this.notice(event.errorMessage, "error");
        // Pi's own Esc-during-compaction notice (interactive-mode.js ~2883-2889): "Compaction
        // cancelled" for a manual /compact the user stopped, "Auto-compaction cancelled" (a lower
        // key, since nothing the user asked for was lost) for one the agent started on its own.
        else if (event.aborted) this.notice(event.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled", event.reason === "manual" ? "error" : "info");
        else this.notice("Context compacted.");
        break;
      case "auto_retry_start":
        this.notice(`Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`, "warning");
        break;
      case "auto_retry_end":
        if (!event.success) this.notice(`Retry failed: ${event.finalError ?? "unknown error"}`, "error");
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
  private add(component: Component, gap = true, counts = true): void {
    if (gap && this.messages.children.length > 0) this.messages.addChild(new piTui.Spacer(1));
    this.messages.addChild(component);
    if (counts) this.messageCount += 1;
  }

  private assistant(message: Extract<AgentMessage, { role: "assistant" }>, streaming: boolean): AssistantMessageComponent {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      undefined,
      CONTENT_PAD,
      this.session.extensionRunner.getMarkdownTransformers(),
    );
    component.updateContent(message, streaming);
    this.add(component, false);
    return component;
  }

  private addFinishedMessage(message: AgentMessage): void {
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

  private tool(toolName: string, toolCallId: string, args?: unknown): ToolExecutionComponent {
    const existing = this.tools.get(toolCallId);
    if (existing !== undefined) {
      if (args !== undefined) existing.updateArgs(args);
      return existing;
    }
    // Pi's built-in tools come with Pi's own renderers; MMP swaps in its grok-style ones. Extension
    // tools, including an extension overriding a built-in name, keep their own renderers.
    const definition = this.session.getToolDefinition(toolName);
    const isBuiltIn = this.session.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
    const renderers = toolBlock(toolName, (isBuiltIn ? builtInToolRenderers[toolName] : undefined) ?? definition);
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args ?? {},
      undefined,
      renderers as never,
      this.tui,
      this.session.sessionManager.getCwd(),
    );
    component.setExpanded(this.toolsExpanded);
    this.tools.set(toolCallId, component);
    // Pi's tool component starts with its own blank row.
    this.add(component, false);
    return component;
  }
}
