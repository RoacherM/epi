// grok tool block frame (docs/tui-design.md 4.2): `┃` rail while the tool runs (a pulse slides down
// it, docs/tui-motion-design.md M4), `◆` before the call line, and result rows indented under it.
// Replaces Pi's background box (`renderShell: "self"`).
import type { AgentToolResult, ToolRenderers as PiToolRenderers, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import type { InspectTarget } from "../buffer/inspector.js";
import { motionTime, railGlyph } from "../motion.js";
import { piTui } from "../pi-tui.js";
import { CallLine, LinesComponent, textContent } from "./common.js";
import type { ToolRenderContext, ToolRenderers } from "./types.js";

// Rail column, then padding so `◆` lines up with assistant text (transcript CONTENT_PAD = 3).
const CALL_PREFIX = 3;
// Result rows start under the call text, after `◆ `.
const RESULT_PREFIX = CALL_PREFIX + 2;
// grok: web and MCP tool output shows at most 10 lines until expanded.
const FALLBACK_LINES = 10;

type Tone = "running" | "done" | "error";

function toneOf(context: ToolRenderContext): Tone {
  if (context.isError === true) return "error";
  return context.isPartial ? "running" : "done";
}

/** Opens a block's full content in the inspector (Transcript.inspect). */
export type OnInspect = (target: InspectTarget) => void;

class Railed implements Component {
  constructor(
    readonly inner: Component,
    private readonly theme: Theme,
    private readonly tone: Tone,
    private readonly isCall: boolean,
    private readonly onInspect: OnInspect | undefined,
  ) {}

  /** A left click on a row the renderer marked inspectable (`… N more lines`) opens the inspector;
   * anywhere else falls through to Pi's own click-to-expand. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left" || this.onInspect === undefined) return undefined;
    if (!(this.inner instanceof LinesComponent)) return undefined;
    const target = this.inner.inspectTargetAt(event.y);
    if (target === undefined) return undefined;
    this.onInspect(target);
    return { handled: true };
  }

  render(width: number): string[] {
    const prefix = this.isCall ? CALL_PREFIX : RESULT_PREFIX;
    const t = motionTime();
    // The result's rows continue the call line's pulse, one row further down.
    const firstRow = this.isCall ? 0 : 1;
    const rail = (index: number) => (this.tone === "running" ? railGlyph(this.theme, firstRow + index, t) : " ");
    const bullet = this.marker();
    const contentWidth = Math.max(1, width - prefix - (this.isCall ? 2 : 0));
    return this.inner.render(contentWidth).map((line, index) => {
      const lead = `${rail(index)}${" ".repeat(prefix - 1)}`;
      if (!this.isCall) return lead + line;
      return lead + (index === 0 ? bullet : "  ") + line;
    });
  }

  /** `$` stays the shell's amber unless the command failed; `◆` follows the tool's state. */
  private marker(): string {
    if (this.inner instanceof CallLine && this.inner.marker === "$") return this.theme.fg(this.tone === "error" ? "error" : "bashMode", "$ ");
    return this.theme.fg(this.tone === "error" ? "error" : this.tone === "running" ? "accent" : "muted", "◆ ");
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

/** Renderers that reuse their last component see their own component, not the frame around it. */
function unwrap(context: ToolRenderContext): ToolRenderContext {
  const last = context.lastComponent;
  return last instanceof Railed ? { ...context, lastComponent: last.inner } : context;
}

function fallbackCall(toolName: string, theme: Theme): Component {
  return new piTui.Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
}

function hasMalformedContent(result: AgentToolResult<unknown>): boolean {
  if (!Array.isArray(result?.content)) return true;
  return result.content.some((part) => {
    if (part?.type === "text") return typeof part.text !== "string";
    if (part?.type === "image") return typeof part.data !== "string" || typeof part.mimeType !== "string";
    return true;
  });
}

function fallbackResult(result: AgentToolResult<unknown>, expanded: boolean, theme: Theme): Component {
  const text = textContent(result).trimEnd();
  const lines = text === "" ? [] : text.split("\n");
  const shown = expanded ? lines : lines.slice(0, FALLBACK_LINES);
  const rows = shown.map((line) => theme.fg("toolOutput", line));
  if (shown.length < lines.length) rows.push(theme.fg("muted", `… +${lines.length - shown.length} lines (Ctrl+O to expand)`));
  if (hasMalformedContent(result)) rows.push(theme.fg("muted", "(unrenderable tool result)"));
  return new piTui.Text(rows.join("\n"), 0, 0);
}

/**
 * Frames any tool's renderers in a grok block. A definition that draws its own frame
 * (`renderShell: "self"`) is left alone. `onInspect` receives clicks on inspectable rows.
 */
export function toolBlock(
  toolName: string,
  renderers: ToolRenderers | PiToolRenderers | ToolDefinition | undefined,
  onInspect?: OnInspect,
): ToolRenderers {
  if (renderers !== undefined && "renderShell" in renderers && renderers.renderShell === "self") return renderers as ToolRenderers;
  const { renderCall, renderResult } = (renderers ?? {}) as ToolRenderers;
  const framed: ToolRenderers = {
    ...(renderers as object),
    renderShell: "self",
    renderCall(args, theme, context) {
      const inner = renderCall?.(args, theme, unwrap(context)) ?? fallbackCall(toolName, theme);
      return new Railed(inner, theme, toneOf(context), true, onInspect);
    },
    renderResult(result, options, theme, context) {
      const inner = renderResult?.(result, options, theme, unwrap(context)) ?? fallbackResult(result, options.expanded, theme);
      return new Railed(inner, theme, toneOf(context), false, onInspect);
    },
  };
  return framed;
}
