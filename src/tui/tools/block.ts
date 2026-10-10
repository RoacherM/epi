// grok tool block frame (docs/tui-design.md 4.2): `┃` rail in `accent` while the tool runs, `◆` before
// the call line, and result rows indented under it. Replaces Pi's background box (`renderShell: "self"`).
import type { AgentToolResult, ToolRenderers as PiToolRenderers, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { piTui } from "../pi-tui.js";
import { textContent } from "./common.js";
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

class Railed implements Component {
  constructor(
    readonly inner: Component,
    private readonly theme: Theme,
    private readonly tone: Tone,
    private readonly isCall: boolean,
  ) {}

  render(width: number): string[] {
    const prefix = this.isCall ? CALL_PREFIX : RESULT_PREFIX;
    const rail = this.tone === "running" ? this.theme.fg("accent", "┃") : " ";
    const bullet = this.theme.fg(this.tone === "error" ? "error" : this.tone === "running" ? "accent" : "muted", "◆ ");
    const contentWidth = Math.max(1, width - prefix - (this.isCall ? 2 : 0));
    return this.inner.render(contentWidth).map((line, index) => {
      const lead = `${rail}${" ".repeat(prefix - 1)}`;
      if (!this.isCall) return lead + line;
      return lead + (index === 0 ? bullet : "  ") + line;
    });
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
 * (`renderShell: "self"`) is left alone.
 */
export function toolBlock(toolName: string, renderers: ToolRenderers | PiToolRenderers | ToolDefinition | undefined): ToolRenderers {
  if (renderers !== undefined && "renderShell" in renderers && renderers.renderShell === "self") return renderers as ToolRenderers;
  const { renderCall, renderResult } = (renderers ?? {}) as ToolRenderers;
  const framed: ToolRenderers = {
    ...(renderers as object),
    renderShell: "self",
    renderCall(args, theme, context) {
      const inner = renderCall?.(args, theme, unwrap(context)) ?? fallbackCall(toolName, theme);
      return new Railed(inner, theme, toneOf(context), true);
    },
    renderResult(result, options, theme, context) {
      const inner = renderResult?.(result, options, theme, unwrap(context)) ?? fallbackResult(result, options.expanded, theme);
      return new Railed(inner, theme, toneOf(context), false);
    },
  };
  return framed;
}
