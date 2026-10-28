// Floating viewer for a block's full content (docs/tui-buffer-components.md): the transcript cuts
// long tool output to a few rows; clicking the `… N more lines` row opens this overlay with every
// line, read-only. A frame (title, close button, scrollbar edge, footer) around a BufferViewport.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "../pi-tui.js";
import { scrollbar } from "./scrollbar.js";
import { printable } from "./search.js";
import { BufferViewport } from "./viewport.js";

const { matchesKey, truncateToWidth, visibleWidth } = piTui;

/** What a block hands the inspector: the untruncated lines and how to label them. */
export interface InspectTarget {
  /** e.g. `read src/app.ts:1-100`, `$ npm test`. */
  title: string;
  /** e.g. `129 lines · exit 0`. */
  subtitle?: string;
  /** Styled lines, one per logical line. */
  lines: readonly string[];
  /** Gutter number of lines[0]; no gutter when the lines carry their own numbers (a diff). */
  firstLineNumber?: number;
  /** Plain text `y` copies. */
  text: string;
  /** Start with long lines wrapped (prose); off by default (code, logs). */
  wrap?: boolean;
  /** Set when the content can be edited: `e` closes the inspector and calls it. */
  edit?: () => void;
  /** Content that changes while shown (a running task): the inspector starts at the end, calls
   * `subscribe` once open, and stops the subscription when it closes. */
  live?: { subscribe(update: (target: InspectTarget) => void): () => void };
  /** Lines that open something (a list of tasks): a click on logical line `line` (0-based), or
   * Enter on the first line shown, opens the page this returns on top; Esc comes back. */
  openLine?: (line: number) => InspectTarget | undefined;
}

export interface InspectorActions {
  close(): void;
  /** Copies `text`; rejects when the clipboard is unavailable. */
  copy(text: string): Promise<void>;
  requestRender(): void;
  /** Terminal rows, read on every render so a resize resizes the overlay. */
  terminalRows(): number;
}

// Share of the terminal's height the overlay may take (design: max height 82%).
const MAX_HEIGHT_SHARE = 0.82;
const CLOSE_LABEL = " [× Esc] ";
const WHEEL_ROWS = 3;

/** One page of the inspector: a list opens an item on top of itself, and Esc goes back. */
interface View {
  target: InspectTarget;
  viewport: BufferViewport;
  stopLive?: () => void;
}

export class BlockInspectorOverlay implements Component {
  private readonly views: View[] = [];

  constructor(
    private readonly theme: Theme,
    target: InspectTarget,
    private readonly actions: InspectorActions,
  ) {
    this.push(target);
  }

  /** The page on top. */
  get viewport(): BufferViewport {
    return this.view.viewport;
  }

  private get view(): View {
    return this.views[this.views.length - 1]!;
  }

  private get target(): InspectTarget {
    return this.view.target;
  }

  private push(target: InspectTarget): void {
    const content = target.firstLineNumber === undefined
      ? { lines: target.lines }
      : { lines: target.lines, firstLineNumber: target.firstLineNumber };
    const viewport = new BufferViewport(content, {
      gutter: (text) => this.theme.fg("dim", text),
      separator: (text) => this.theme.fg("borderMuted", text),
      match: (text) => this.theme.inverse(text),
    });
    viewport.wrap = target.wrap === true;
    const view: View = { target, viewport };
    this.views.push(view);
    if (target.live !== undefined) {
      viewport.scrollTop = Number.MAX_SAFE_INTEGER;
      view.stopLive = target.live.subscribe((next) => this.update(view, next));
    }
  }

  /** Leaves the page on top for the one under it; false when it is the only one. */
  private back(): boolean {
    if (this.views.length <= 1) return false;
    this.views.pop()?.stopLive?.();
    this.actions.requestRender();
    return true;
  }

  private close(): void {
    if (!this.back()) this.actions.close();
  }

  /** Ends live updates; the host calls it when it hides the overlay. */
  dispose(): void {
    for (const view of this.views) view.stopLive?.();
  }

  /** New content for a live page (a running task): the position is kept, and a page scrolled to
   * the end follows new lines. */
  private update(view: View, target: InspectTarget): void {
    const following = view.viewport.scrollTop >= view.viewport.maxScroll;
    view.target = target;
    view.viewport.setLines(target.lines);
    if (following) view.viewport.scrollTop = Number.MAX_SAFE_INTEGER;
    this.actions.requestRender();
  }

  /** `openLine`'s page for logical line `line`, opened on top. */
  private open(line: number): void {
    const next = this.target.openLine?.(line);
    if (next !== undefined) this.push(next);
    this.actions.requestRender();
  }

  handleInput(data: string): void {
    if (piTui.isKeyRelease(data)) return;
    // Esc in a prompt only leaves the prompt; Esc in NORMAL (nothing pending) goes back or closes.
    const result = this.viewport.handleInput(data);
    if (result === "close") {
      this.close();
      return;
    }
    if (result === "yank") this.yank();
    if (result === "ignored" && data === "e" && this.target.edit !== undefined) {
      const edit = this.target.edit;
      this.actions.close();
      edit();
      return;
    }
    if (result === "ignored" && matchesKey(data, "enter") && this.target.openLine !== undefined) {
      this.open(this.viewport.visibleLines().first - 1);
      return;
    }
    if (result === "ignored" && matchesKey(data, "ctrl+c")) {
      this.actions.close();
      return;
    }
    this.actions.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (event.type === "wheel") {
      this.viewport.wheel((event.wheelDelta ?? 1) * WHEEL_ROWS);
      return { handled: true, render: true };
    }
    if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= event.width - visibleWidth(CLOSE_LABEL) - 2) {
      this.close();
      return { handled: true, render: true };
    }
    // Body rows start under the top border.
    const line = event.type === "click" && event.button === "left" ? this.viewport.lineAtRow(event.y - 1) : undefined;
    if (line !== undefined && this.target.openLine !== undefined) {
      this.open(line);
      return { handled: true, render: true };
    }
    // Clicks inside never fall through to the transcript underneath.
    return { handled: true };
  }

  render(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(1, width - 4);
    const maxBody = Math.max(1, Math.floor(this.actions.terminalRows() * MAX_HEIGHT_SHARE) - 2);
    const bodyHeight = Math.max(1, Math.min(maxBody, this.viewport.measure(inner)));
    const body = this.viewport.render(inner, bodyHeight);
    // The right frame edge doubles as the scrollbar; a plain edge when everything fits.
    const bar = scrollbar(th, this.viewport.rowCount, bodyHeight, this.viewport.scrollTop, bodyHeight, { thumb: "accent", track: "borderMuted", fits: "borderAccent" });
    const rows = body.map((row, index) => `${th.fg("borderAccent", "│")} ${truncateToWidth(row, inner, "…", true)} ${bar[index]}`);
    return [this.topBorder(width), ...rows, this.bottomBorder(width)];
  }

  invalidate(): void {}

  private topBorder(width: number): string {
    const th = this.theme;
    const close = th.fg("warning", CLOSE_LABEL);
    const room = Math.max(0, width - 3 - visibleWidth(CLOSE_LABEL) - 2);
    const subtitle = this.target.subtitle === undefined ? "" : ` ${th.fg("muted", `(${this.target.subtitle})`)}`;
    const title = truncateToWidth(` ${th.bold(th.fg("accent", this.target.title))}${subtitle} `, room, "…");
    const fill = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(CLOSE_LABEL) - 2);
    return `${th.fg("borderAccent", "╭─")}${title}${th.fg("borderAccent", "─".repeat(fill))}${close}${th.fg("borderAccent", "─╮")}`;
  }

  private bottomBorder(width: number): string {
    const th = this.theme;
    const viewport = this.viewport;
    const { prompt, status, pending: typed } = viewport.navigation;
    let left: string;
    if (prompt !== undefined) {
      left = th.fg("text", ` ${prompt.kind}${printable(prompt.text)}█ `);
    } else if (status !== undefined) {
      left = th.fg(status.tone === "error" ? "error" : "success", ` ${status.text} `);
    } else {
      const { first, last } = viewport.visibleLines();
      const percent = viewport.maxScroll === 0 ? 100 : Math.round((viewport.scrollTop / viewport.maxScroll) * 100);
      const pending = typed === "" ? "" : ` · ${typed}`;
      left = ` ${th.fg("accent", viewport.mode)}${th.fg("muted", ` · L${first}–${last}/${viewport.lineCount} (${percent}%)${pending}`)} `;
    }
    const edit = this.target.edit !== undefined ? "e edit · " : this.target.openLine !== undefined ? "click/Enter open · " : "";
    const close = this.views.length > 1 ? "q back" : "q close";
    const hint = prompt === undefined
      ? `${edit}j/k · gg/G · / search · :line · w wrap:${viewport.wrap ? "on" : "off"} · y copy · ${close}`
      : prompt.kind === "/" ? "Enter search · Esc back" : "Enter go to line · Esc back";
    const room = Math.max(0, width - 4);
    const leftFitted = truncateToWidth(left, room, "…");
    const hintRoom = room - visibleWidth(leftFitted) - 2;
    const right = hintRoom >= 12 ? ` ${th.fg("muted", truncateToWidth(hint, hintRoom - 1, "…"))} ` : "";
    const fill = Math.max(0, room - visibleWidth(leftFitted) - visibleWidth(right));
    return `${th.fg("borderAccent", "╰─")}${leftFitted}${th.fg("borderAccent", "─".repeat(fill))}${right}${th.fg("borderAccent", "─╯")}`;
  }

  private yank(): void {
    const count = this.target.lines.length;
    void this.actions.copy(this.target.text).then(
      () => {
        this.viewport.navigation.status = { text: `Copied ${count} ${count === 1 ? "line" : "lines"}`, tone: "info" };
        this.actions.requestRender();
      },
      (error: unknown) => {
        this.viewport.navigation.status = { text: `Copy failed: ${error instanceof Error ? error.message : String(error)}`, tone: "error" };
        this.actions.requestRender();
      },
    );
  }
}
