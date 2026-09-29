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
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";

import { piTui } from "./pi-tui.js";

type AgentMessage = AgentSession["messages"][number];

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("");
}

export class Transcript {
  /** Scrolled content: extension header first, then messages. */
  readonly root: Container = new piTui.Container();
  readonly header: Container = new piTui.Container();
  private readonly messages: Container = new piTui.Container();
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private streaming: AssistantMessageComponent | undefined;
  private toolsExpanded = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly cwd: string,
    private session: AgentSession,
  ) {
    this.root.addChild(this.header);
    this.root.addChild(this.messages);
  }

  /** New session after /new, /resume, /reload: clear and replay its history. */
  reset(session: AgentSession): void {
    this.session = session;
    this.messages.clear();
    this.tools.clear();
    this.streaming = undefined;
    for (const message of session.messages) {
      this.addFinishedMessage(message);
    }
  }

  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.tools.values()) tool.setExpanded(expanded);
  }

  notice(text: string, tone: "info" | "warning" | "error" = "info"): void {
    const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
    this.add(new piTui.Text(this.theme.fg(color, text), 1, 0));
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
        if (event.errorMessage !== undefined) this.notice(`Compaction failed: ${event.errorMessage}`, "error");
        else if (!event.aborted) this.notice("Context compacted.");
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

  private add(component: Component): void {
    this.messages.addChild(new piTui.Spacer(1));
    this.messages.addChild(component);
  }

  private assistant(message: Extract<AgentMessage, { role: "assistant" }>, streaming: boolean): AssistantMessageComponent {
    const component = new AssistantMessageComponent(
      undefined,
      false,
      getMarkdownTheme(),
      undefined,
      undefined,
      this.session.extensionRunner.getMarkdownTransformers(),
    );
    component.updateContent(message, streaming);
    this.add(component);
    return component;
  }

  private addFinishedMessage(message: AgentMessage): void {
    switch (message.role) {
      case "user":
        this.add(new UserMessageComponent(messageText(message.content), getMarkdownTheme()));
        break;
      case "assistant":
        this.assistant(message, false);
        this.syncToolCalls(message, true);
        break;
      case "toolResult":
        this.tool(message.toolName, message.toolCallId).updateResult(message, false);
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
    // Built-in tool renderers are not exported by Pi; they get the generic card until M4.
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args ?? {},
      undefined,
      this.session.getToolDefinition(toolName),
      this.tui,
      this.cwd,
    );
    component.setExpanded(this.toolsExpanded);
    this.tools.set(toolCallId, component);
    this.add(component);
    return component;
  }
}
