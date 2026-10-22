// Pieces shared by the built-in tool renderers, the tool block fallback and the `!cmd` block.
import { homedir } from "node:os";

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { InspectTarget } from "../buffer/inspector.js";
import { formatDuration } from "../chrome.js";
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

/** A tool's run time on its call line: `2.1s`, `2m20s`; under a second in milliseconds, since
 * `0.0s`/`0.1s` say nothing about a 30ms grep. */
export function formatToolDuration(ms: number): string {
  if (ms < 950) return `${Math.max(1, Math.round(ms))}ms`;
  return formatDuration(ms);
}

/** `body` cut to fit `width` together with `tail`, which is never cut (docs/tui-transcript-layout-
 * design.md §4-C: a long command must not eat its `· +8 lines`). A tail wider than the line is
 * dropped rather than cut. */
export function fitWithTail(body: string, tail: string, width: number, ellipsis: string): string {
  const tailWidth = piTui.visibleWidth(tail);
  if (tailWidth >= width) return piTui.truncateToWidth(body, Math.max(0, width), ellipsis);
  return piTui.truncateToWidth(body, width - tailWidth, ellipsis) + tail;
}

/** The marker a call line puts in the marker column: `$` for shell commands, `◆` for the rest.
 * tools/block.ts paints it in the color of the tool's state. */
export type CallMarker = "$" | "◆";

/**
 * A built-in tool's one-row call line (docs/tui-transcript-layout-implementation.md W3): the body
 * (`read src/a.ts`, the command) cut to fit, then a dim tail that is never cut -- a summary the
 * result renderer leaves in `context.state.callSummary` (`· 120 lines`, `· +3 −1`) and the run
 * time. The tail is read at render time, after Pi's updateDisplay() has run the result renderer
 * too, so a summary only the result knows still lands on the call row; a successful collapsed
 * result then needs no row of its own ("成功不占行").
 */
export class CallLine implements Component {
  constructor(
    readonly marker: CallMarker,
    private readonly theme: Theme,
    private readonly body: string,
    private readonly context: Pick<ToolRenderContext, "state" | "durationMs" | "isError" | "isPartial">,
    private readonly extra = "",
  ) {}

  /** The tail as it reads right now: `extra`, the result's summary, then the run time. A failed
   * result's own row says what happened, so a summary left by an earlier (partial) result is dropped. */
  tail(): string {
    const summary = typeof this.context.state?.callSummary === "string" && !this.context.isError ? this.context.state.callSummary : "";
    const parts = [this.extra, summary].filter((part) => part !== "");
    const dot = parts.map((part) => `${this.theme.fg("dim", " · ")}${part}`).join("");
    const { durationMs, isError, isPartial } = this.context;
    const time = durationMs !== undefined && !isError && !isPartial ? `  ${this.theme.fg("dim", formatToolDuration(durationMs))}` : "";
    return dot + time;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [fitWithTail(this.body, this.tail(), width, this.theme.fg("dim", "…"))];
  }
}

/** A result renderer's summary for the call line's tail (see `CallLine`). */
export function setCallSummary(context: ToolRenderContext, summary: string | undefined): void {
  if (context.state === undefined || context.state === null) return;
  context.state.callSummary = summary;
}

/** A failure row (`✗ exit 1 · npm ERR! …`): the one case a collapsed result takes a row of its own.
 * Starts with `✗` so the turn spine can give it a red branch (src/tui/spine.ts). */
export function failureRow(theme: Theme, text: string): string {
  return theme.fg("error", `✗ ${text}`);
}

/**
 * The command as a call line shows it (docs/tui-transcript-layout-design.md §4-C): its first line,
 * without a leading `cd <session cwd> &&` / `cd <session cwd>;` (the cwd is already the session's),
 * and with the home directory written `~`. `extraLines` counts the lines left out (a heredoc), for
 * the `· +N lines` tail. Display only: the inspector and copying still use the real command.
 */
export function shortenCommand(command: string, cwd: string | undefined, home = homedir()): { text: string; extraLines: number } {
  const lines = command.trimEnd().split("\n");
  let text = lines[0] ?? "";
  if (cwd) {
    const spellings = [cwd, ...(home && cwd.startsWith(`${home}/`) ? [`~${cwd.slice(home.length)}`] : [])];
    const quoted = spellings.map(escapeRegExp).join("|");
    text = text.replace(new RegExp(`^\\s*cd\\s+(["']?)(?:${quoted})/?\\1\\s*(?:&&|;)\\s*`), "");
  }
  if (home && home !== "/") text = text.replace(new RegExp(`${escapeRegExp(home)}(?=$|[/\\s"':;)])`, "g"), "~");
  return { text, extraLines: lines.length - 1 };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
