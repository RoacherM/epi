// Shape Pi's ToolExecutionComponent accepts for drawing a tool. Pi exports neither ToolRenderers nor
// ToolRenderContext from its package entry, so they are declared here with the same structure.
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export interface ToolRenderContext<TState = any, TArgs = any> {
  args: TArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages?: boolean;
  isError?: boolean;
}

export interface ToolRenderers {
  /** "self": no background box around the rendered call and result. */
  renderShell?: "default" | "self";
  renderCall?: (args: any, theme: Theme, context: ToolRenderContext) => Component;
  renderResult?: (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext,
  ) => Component;
}
