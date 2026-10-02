// Pieces shared by the built-in tool renderers, the tool block fallback and the `!cmd` block.
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { piTui } from "../pi-tui.js";
import type { ToolRenderContext } from "./types.js";

/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export class LinesComponent implements Component {
  private lines: string[] = [];

  constructor(lines: string[] | string) {
    this.setLines(lines);
  }

  setLines(lines: string[] | string): void {
    if (typeof lines === "string") {
      this.lines = lines ? lines.split("\n") : [];
    } else {
      this.lines = lines.flatMap((line) => line.split("\n"));
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.lines.map((line) => piTui.truncateToWidth(line, width));
  }
}

/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export function createOrUpdateLines(context: ToolRenderContext, lines: string[]): Component {
  if (context.lastComponent instanceof LinesComponent) {
    context.lastComponent.setLines(lines);
    return context.lastComponent;
  }
  return new LinesComponent(lines);
}

/** The text parts of a tool result joined by "\n"; images and malformed parts are skipped. */
export function textContent(result: AgentToolResult<unknown>): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function isErrorResult(result: AgentToolResult<unknown>, context: ToolRenderContext | undefined): boolean {
  return Boolean(context?.isError || (result as { isError?: boolean } | undefined)?.isError);
}

/**
 * grok truncation rule (docs/tui-design.md 4.2): up to 5 lines in full, otherwise the first 2, an
 * ellipsis row, and the last 3. `ellipsis` styles that row; callers pick its colour (8.4 keeps the
 * model's bash block `muted` and the `!cmd` block `toolOutput`).
 */
export function truncateOutputLines(lines: string[], ellipsis: (text: string) => string): string[] {
  if (lines.length <= 5) return lines;
  return [...lines.slice(0, 2), ellipsis(`… +${lines.length - 5} lines`), ...lines.slice(-3)];
}
