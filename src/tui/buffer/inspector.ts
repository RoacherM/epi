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

export class BlockInspectorOverlay implements Component {
  readonly viewport: BufferViewport;

  constructor(
    private readonly theme: Theme,
    private readonly target: InspectTarget,
    private readonly actions: InspectorActions,
  ) {
    const content = target.firstLineNumber === undefined
      ? { lines: target.lines }
      : { lines: target.lines, firstLineNumber: target.firstLineNumber };
    this.viewport = new BufferViewport(content, {
      gutter: (text) => theme.fg("dim", text),
      separator: (text) => theme.fg("borderMuted", text),
      match: (text) => theme.inverse(text),
    });
  }

  handleInput(data: string): void {
    if (piTui.isKeyRelease(data)) return;
    // Esc in a prompt only leaves the prompt; Esc in NORMAL (nothing pending) closes.
    const result = this.viewport.handleInput(data);
    if (result === "close") {
      this.actions.close();
      return;
    }
    if (result === "yank") this.yank();
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
      this.actions.close();
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
    const hint = prompt === undefined
      ? `j/k · gg/G · / search · :line · w wrap:${viewport.wrap ? "on" : "off"} · y copy · q close`
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
