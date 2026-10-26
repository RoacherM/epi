// grok tool block frame (docs/tui-design.md 4.2): a marker before the call line and result rows
// indented under it. The marker is the rotating x while the call runs, then `$` for shell commands and
// `◆` for the rest (docs/tui-glyphs-design.md, src/tui/glyphs.ts). While a call runs, its result shows
// as the running slice: the newest RUNNING_SLICE_ROWS rows, whatever renderer drew them (codemode's
// nested calls, an MCP tool's progress, an extension's own rows). Replaces Pi's background box
// (`renderShell: "self"`).
import type { AgentToolResult, ToolRenderers as PiToolRenderers, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import type { InspectTarget } from "../buffer/inspector.js";
import { GLYPHS, type MarkerState, paintMarker, takePhase } from "../glyphs.js";
import { piTui } from "../pi-tui.js";
import { CallLine, LinesComponent, RUNNING_SLICE_ROWS, textContent } from "./common.js";
import type { ToolRenderContext, ToolRenderers } from "./types.js";

// Rail column, then padding so `◆` lines up with assistant text (transcript CONTENT_PAD = 3).
const CALL_PREFIX = 3;
// Result rows start under the call text, after `◆ `.
const RESULT_PREFIX = CALL_PREFIX + 2;
// grok: web and MCP tool output shows at most 10 lines until expanded.
const FALLBACK_LINES = 10;

/** What the marker column shows: `pending` while the arguments stream or the call waits its turn. */
function markerStateOf(context: ToolRenderContext): MarkerState {
  if (context.isError === true) return "error";
  if (!context.isPartial) return "done";
  return context.executionStarted ? "running" : "pending";
}

/** The call's marker timing, kept in Pi's per-call renderer state: a phase when it starts running, so
 * calls side by side don't turn in step, and when it ended, for the landing shake. Only a call drawn
 * while it ran shakes: one that finished between two frames (a 4ms read) or a replayed one was never
 * seen turning, so it settles at once. */
interface MarkerTiming {
  markerPhase?: number;
  markerShownRunning?: boolean;
  markerEndedAt?: number;
}

function noteMarkerTiming(context: ToolRenderContext): MarkerTiming | undefined {
  const state = context.state as MarkerTiming | undefined | null;
  if (state === undefined || state === null || typeof state !== "object") return undefined;
  const marker = markerStateOf(context);
  if (marker === "running") state.markerPhase ??= takePhase();
  else if ((marker === "done" || marker === "error") && state.markerShownRunning === true) state.markerEndedAt ??= Date.now();
  return state;
}

/** Opens a block's full content in the inspector (Transcript.inspect). */
export type OnInspect = (target: InspectTarget) => void;

class Railed implements Component {
  constructor(
    readonly inner: Component,
    private readonly theme: Theme,
    private readonly state: MarkerState,
    private readonly timing: MarkerTiming | undefined,
    /** `running`: a running call's result, of which only the newest RUNNING_SLICE_ROWS rows show. */
    private readonly kind: "call" | "result" | "running",
    private readonly onInspect: OnInspect | undefined,
  ) {}

  private get isCall(): boolean {
    return this.kind === "call";
  }

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

  /** The first columns stay blank for the turn spine (src/tui/spine.ts), which also carries the
   * carriage. */
  render(width: number): string[] {
    const prefix = this.isCall ? CALL_PREFIX : RESULT_PREFIX;
    const bullet = this.marker();
    const contentWidth = Math.max(1, width - prefix - (this.isCall ? 2 : 0));
    const lead = " ".repeat(prefix);
    const rows = this.inner.render(contentWidth);
    return (this.kind === "running" ? rows.slice(-RUNNING_SLICE_ROWS) : rows).map((line, index) => {
      if (!this.isCall) return lead + line;
      return lead + (index === 0 ? bullet : "  ") + line;
    });
  }

  /** The rotating x while the call runs, then `$` in the shell's amber or a muted `◆`; a red `×` if
   * it failed. Read at displayNow(), so a call held still outside the tip holds its marker too. */
  private marker(): string {
    if (this.state === "running" && this.timing !== undefined) this.timing.markerShownRunning = true;
    const shell = this.inner instanceof CallLine && this.inner.marker === GLYPHS.shell;
    const glyph = paintMarker(this.theme, {
      state: this.state,
      glyph: shell ? GLYPHS.shell : GLYPHS.tool,
      color: shell ? "bashMode" : "muted",
      endedAt: this.timing?.markerEndedAt,
      phase: this.timing?.markerPhase,
    });
    return `${glyph} `;
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

function fallbackResult(result: AgentToolResult<unknown>, expanded: boolean, theme: Theme, running: boolean): Component {
  const text = textContent(result).trimEnd();
  const lines = text === "" ? [] : text.split("\n");
  if (running) return new piTui.Text(lines.slice(-RUNNING_SLICE_ROWS).map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
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
      return new Railed(inner, theme, markerStateOf(context), noteMarkerTiming(context), "call", onInspect);
    },
    renderResult(result, options, theme, context) {
      // An opened block (Ctrl+O) shows everything, running or not (the v3 prototype's `open`).
      const running = options.isPartial && context.executionStarted && !options.expanded;
      const inner = renderResult?.(result, options, theme, unwrap(context)) ?? fallbackResult(result, options.expanded, theme, running);
      return new Railed(inner, theme, markerStateOf(context), undefined, running ? "running" : "result", onInspect);
    },
  };
  return framed;
}
