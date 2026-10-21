// Pieces shared by the built-in tool renderers, the tool block fallback and the `!cmd` block.
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { InspectTarget } from "../buffer/inspector.js";
import { piTui } from "../pi-tui.js";
import type { ToolRenderContext } from "./types.js";

/** Rows of a rendered block that open the inspector (the `… N more lines` row), and what they open. */
export interface Inspectable {
  rows: readonly number[];
  target: InspectTarget;
}

/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export class LinesComponent implements Component {
  private lines: string[] = [];
  private inspectable: Inspectable | undefined;

  constructor(lines: string[] | string, inspectable?: Inspectable) {
    this.setLines(lines, inspectable);
  }

  /** `inspectable` row indices count the rows as split here, one per "\n"-separated part. */
  setLines(lines: string[] | string, inspectable?: Inspectable): void {
    if (typeof lines === "string") {
      this.lines = lines ? lines.split("\n") : [];
    } else {
      this.lines = lines.flatMap((line) => line.split("\n"));
    }
    this.inspectable = inspectable;
  }

  /** The inspector target behind rendered row `row`, if that row opens one. */
  inspectTargetAt(row: number): InspectTarget | undefined {
    return this.inspectable?.rows.includes(row) ? this.inspectable.target : undefined;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.lines.map((line) => piTui.truncateToWidth(line, width));
  }
}

/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export function createOrUpdateLines(context: ToolRenderContext, lines: string[], inspectable?: Inspectable): Component {
  if (context.lastComponent instanceof LinesComponent) {
    context.lastComponent.setLines(lines, inspectable);
    return context.lastComponent;
  }
  return new LinesComponent(lines, inspectable);
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
