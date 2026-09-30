// grok-build chrome (docs/tui-design.md 4.1, grok notes 2.1-2.2): header bar, user message block,
// turn status row, framed prompt, shortcuts bar. Pure render functions of the state they are given.
import { homedir } from "node:os";
import { basename, sep } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorComponent, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "./pi-tui.js";

const { truncateToWidth, visibleWidth } = piTui;

/** Shared with assistant-block.ts (the assistant-message timestamp reuses this row layout). */
export function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…");
}

/** Left and right segments on one row; the left side is truncated first. */
/** Columns kept free for a message's time on every row ("12:00 PM"), so text wraps at the same place
 * whatever the time reads; a longer locale string widens it. */
export function clockColumns(clock: string): number {
  return Math.max(8, visibleWidth(clock));
}

export function spread(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return fit(right, width);
  const leftFitted = fit(left, width - rightWidth - 1);
  return `${leftFitted}${" ".repeat(Math.max(1, width - visibleWidth(leftFitted) - rightWidth))}${right}`;
}

/** grok: `~` for home, middle components shortened to their first letter, last two kept full. */
export function shortenPath(path: string, home = homedir()): string {
  const withHome = path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
  const parts = withHome.split(sep);
  return parts
    .map((part, index) => (index === 0 || index >= parts.length - 2 || part === "" ? part : [...part][0]))
    .join(sep);
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands >= 100 ? `${Math.round(thousands)}K` : `${thousands.toFixed(1).replace(/\.0$/, "")}K`;
}

/** Shared with transcript.ts (turn footer) and assistant-block.ts (thinking duration). */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
}

function line(render: (width: number) => string): Component {
  return { render: (width) => [render(width)], invalidate() {} };
}

// ── header bar ────────────────────────────────────────────────────────────────

export interface HeaderState {
  branch: string | undefined;
  cwd: string;
  contextTokens: number | undefined;
  contextWindow: number | undefined;
}

export function headerBar(theme: Theme, state: () => HeaderState): Component {
  return line((width) => {
    const { branch, cwd, contextTokens, contextWindow } = state();
    const left = `${branch === undefined ? "" : `${theme.fg("dim", branch)} `}${theme.fg("text", shortenPath(cwd))}`;
    const right = contextWindow === undefined
      ? ""
      : theme.fg("text", `${formatTokens(contextTokens ?? 0)} / ${formatTokens(contextWindow)}`);
    return spread(left, right, width);
  });
}

// ── user message block ────────────────────────────────────────────────────────

const FILE_BLOCK_RE = /<file name="([^"]*)">[\s\S]*?<\/file>\n?/g;

/** A user message's own display text: `<file name="...">...</file>` blocks (file-arguments.ts's
 * `@file` inlining) collapse to `[File: name]`, and image content parts (never inlined as text)
 * show as `[Image #N]` -- the model still gets the full `content` array unchanged; this only
 * affects what's drawn in the transcript (item 5, docs/tui-design.md 4.3's 发送 row). */
function displayText(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part): part is { type: "text"; text: string } => part?.type === "text").map((part) => part.text).join("")
      : "";
  const imageCount = Array.isArray(content) ? content.filter((part) => part?.type === "image").length : 0;
  const withFileChips = text.replace(FILE_BLOCK_RE, (_match, name: string) => `[File: ${basename(name)}]\n`).trim();
  const images = Array.from({ length: imageCount }, (_, index) => `[Image #${index + 1}]`).join(" ");
  return [withFileChips, images].filter((part) => part !== "").join("\n");
}

const COLLAPSED_LINES = 3;
/** A line holding nothing but `[Image #N]` / `[File: name]` chips (what displayText() emits for
 * attachments and `@file` blocks). */
const CHIP_ONLY_LINE = /^\s*(?:\[(?:Image #\d+|File: [^\]\n]*)\]\s*)+$/;

/** Cuts the text after its `COLLAPSED_LINES`-th logical line and appends `…`. Chip-only lines don't
 * count toward the limit: three `@file` arguments plus a one-line question must still show the
 * question. */
function collapseUserText(text: string): string {
  const lines = text.split("\n");
  let counted = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (CHIP_ONLY_LINE.test(lines[index] ?? "")) continue;
    counted += 1;
    if (counted > COLLAPSED_LINES) return [...lines.slice(0, index), "…"].join("\n");
  }
  return text;
}

/** Full-width `userMessageBg` block with one row of padding, `❯ text` and the time on the right.
 * Collapses past `COLLAPSED_LINES` *logical* lines (not wrapped rows) to `…` -- observed in grok
 * 1.0.44 (docs/tui-design.md 4.2/4.3): a sent 12-line paste renders as its first 3 lines then `…`.
 * Counting logical lines, not wrapped rows, means a single long line never collapses just because a
 * narrow terminal wraps it into more than 3 screen rows. Expanded back with Ctrl+O -- the same
 * toggle that expands tool output (item 5). */
export class UserMessageBlock implements Component {
  private readonly text: string;
  private expanded = false;

  constructor(
    private readonly theme: Theme,
    content: unknown,
    private readonly time: Date,
  ) {
    this.text = displayText(content);
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const paint = (content: string) => this.theme.bg("userMessageBg", content + " ".repeat(Math.max(0, width - visibleWidth(content))));
    const clock = this.theme.fg("muted", this.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    const bodyWidth = Math.max(1, width - 4 - clockColumns(clock) - 3);
    const source = this.expanded ? this.text : collapseUserText(this.text);
    const lines = piTui.wrapTextWithAnsi(source, bodyWidth);
    const rows = lines.map((text, index) => {
      const prefix = index === 0 ? `${this.theme.fg("muted", "❯")} ` : "  ";
      const left = `  ${prefix}${this.theme.fg("userMessageText", text)}`;
      return index === 0 ? spread(left, `${clock}  `, width) : fit(left, width);
    });
    return [paint(""), ...rows.map(paint), paint("")];
  }

  invalidate(): void {}
}

// ── turn status row ───────────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const SPINNER_MS = 133;

export interface TurnState {
  startedAt: number;
  phaseStartedAt: number;
  activity: string;
  outputTokens: number;
  estimated: boolean;
}

/** `⠧ Waiting for response… 2.4s ····· 2.4s ⇣2.3k [stop]`; zero rows when idle. */
export class TurnStatus implements Component {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly state: () => TurnState | undefined,
    private readonly requestRender: () => void,
  ) {}

  render(width: number): string[] {
    const turn = this.state();
    if (turn === undefined) {
      this.stop();
      return [];
    }
    this.timer ??= setInterval(this.requestRender, SPINNER_MS).unref();
    const now = Date.now();
    const frame = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length] ?? SPINNER[0];
    const phase = width >= 60 ? ` ${this.theme.fg("muted", formatDuration(now - turn.phaseStartedAt))}` : "";
    const left = `${this.theme.fg("accent", frame ?? "")} ${this.theme.fg("text", turn.activity)}${phase}`;
    const tokens = turn.outputTokens > 0 ? ` ${turn.estimated ? "~" : ""}⇣${formatTokens(turn.outputTokens).toLowerCase()}` : "";
    const right = `${this.theme.fg("muted", `${formatDuration(now - turn.startedAt)}${tokens}`)} ${this.theme.fg("muted", "[stop]")}`;
    return [spread(left, right, width)];
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}
}

// ── framed prompt ─────────────────────────────────────────────────────────────

/**
 * Wraps pi-tui's Editor in a rounded frame with `model (level)` on the bottom border. The editor
 * draws its own top and bottom rules (possibly with a `↑ N more` label); those rows are replaced,
 * content rows get side rails, and anything below the bottom rule (autocomplete) stays outside.
 */
/** Columns before the editor's own content starts inside the frame: `│` + space + the 2-column
 * `❯ `/`  ` prompt. Shared by render() and handleMouse() so a click lands on the same character
 * it's drawn on; exported so tests can compute click coordinates without duplicating it. */
export const PROMPT_COLUMNS = 4;

function plainText(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isBorderRule(text: string): boolean {
  const plain = plainText(text);
  return plain.includes("─") && /^[─↑↓\d\s a-z]+$/.test(plain);
}

/** Item 4 (docs/tui-design.md 4.1/4.2): at ≤12 rows, crop the editor's content down to the row
 * holding the cursor (its reverse-video marker, same as the Editor itself emits it) instead of an
 * arbitrary window -- the point of the cap is to keep editing visible, not just short. Falls back to
 * the last row (unfocused editors don't mark a cursor at all) so this never returns nothing. Returns
 * the window's bounds, not just the cropped slice, so `handleMouse()` can shift a click's `y` by the
 * same `start` offset `render()` cropped by -- otherwise a click lands on the row it would be at
 * without the crop, not the one actually drawn on screen. */
function cropWindow(lines: readonly string[], maxRows: number): { start: number; end: number } {
  if (lines.length <= maxRows) return { start: 0, end: lines.length };
  const cursorIndex = lines.findIndex((line) => line.includes("\x1b[7m"));
  const end = Math.min(lines.length, Math.max(maxRows, (cursorIndex === -1 ? lines.length - 1 : cursorIndex) + 1));
  return { start: end - maxRows, end };
}

function cropToCursor(lines: readonly string[], maxRows: number): string[] {
  const { start, end } = cropWindow(lines, maxRows);
  return lines.slice(start, end);
}

export class PromptFrame implements Component {
  constructor(
    private readonly theme: Theme,
    readonly editor: EditorComponent,
    private readonly label: () => string,
    private readonly borderColor: () => (text: string) => string,
    private readonly maxContentRows: () => number | undefined = () => undefined,
  ) {}

  get focused(): boolean {
    return (this.editor as unknown as { focused?: boolean }).focused ?? false;
  }

  set focused(value: boolean) {
    (this.editor as unknown as { focused?: boolean }).focused = value;
  }

  /** Finds the editor's own top/bottom border rows within its rendered output at `inner` width,
   * so render() and handleMouse() agree on which rows are content. */
  private contentBounds(inner: number): { lines: string[]; top: number; bottom: number } {
    const lines = this.editor.render(inner);
    const top = lines.findIndex(isBorderRule);
    let bottom = -1;
    for (let index = lines.length - 1; index > top; index -= 1) {
      if (isBorderRule(lines[index] ?? "")) {
        bottom = index;
        break;
      }
    }
    return { lines, top, bottom };
  }

  render(width: number): string[] {
    const color = this.borderColor();
    // Frame (2 columns each side) plus the `❯ ` prompt column.
    const inner = Math.max(1, width - 6);
    const { lines, top, bottom } = this.contentBounds(inner);
    if (top === -1 || bottom === -1) return lines.map((text) => fit(text, width));

    // Keep the editor's scroll hints (`↑ 3 more`, `↓ 2 more`) inside the new borders.
    const hint = (rule: string) => plainText(rule).replace(/─/g, "").trim();
    const border = (left: string, right: string, text: string) => {
      const label = text === "" ? "" : ` ${text} `;
      const fill = Math.max(0, width - 3 - visibleWidth(label));
      return visibleWidth(label) + 4 <= width
        ? `${color(`${left}─`)}${this.theme.fg("muted", label)}${color(`${"─".repeat(fill - 0)}${right}`)}`
        : color(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
    };
    const bottomLabel = [hint(lines[bottom] ?? ""), this.label()].filter((part) => part !== "").join(" · ");
    const out = [border("╭", "╮", hint(lines[top] ?? ""))];
    const maxRows = this.maxContentRows();
    const content = maxRows === undefined ? lines.slice(top + 1, bottom) : cropToCursor(lines.slice(top + 1, bottom), maxRows);
    content.forEach((line, index) => {
      const prompt = index === 0 ? this.theme.fg("muted", "❯ ") : "  ";
      const padded = line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
      out.push(`${color("│")} ${prompt}${padded} ${color("│")}`);
    });
    // grok puts the model label on the right of the bottom border.
    const label = ` ${bottomLabel} `;
    const fill = Math.max(0, width - 3 - visibleWidth(label));
    out.push(visibleWidth(label) + 4 <= width
      ? `${color(`╰${"─".repeat(fill)}`)}${this.theme.fg("muted", label)}${color("─╯")}`
      : color(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
    for (const extra of lines.slice(bottom + 1)) out.push(fit(extra, width));
    return out;
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  /** Forwards a click/double-click inside the content rows to the editor, translated into its own
   * coordinate space (docs/tui-design.md 4.3: double-click on a chip expands it). Clicks on the
   * border or the autocomplete dropdown below it are left unhandled, matching prior behavior. At the
   * ≤12-row cap (`maxContentRows`), a click's `y` is shifted by the same crop-window offset
   * `render()` used, so a double-click on a chip on a row *within the drawn window* still lands on
   * the right line of the editor's own (uncropped) content -- a click on a screen position outside
   * the drawn window can't occur in practice (nothing else is drawn there) but is also harmless: it
   * maps past the editor's real content and simply falls through unhandled below. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const inner = Math.max(1, event.width - 6);
    const { lines, top, bottom } = this.contentBounds(inner);
    if (top === -1 || bottom === -1) return undefined;
    const contentHeight = bottom - top - 1;
    if (event.y < 1 || event.y > contentHeight) return undefined;
    const x = event.x - PROMPT_COLUMNS;
    if (x < 0 || x >= inner) return undefined;
    const maxRows = this.maxContentRows();
    const offset = maxRows === undefined ? 0 : cropWindow(lines.slice(top + 1, bottom), maxRows).start;
    return this.editor.handleMouse?.({ ...event, x, y: event.y + offset, width: inner, height: contentHeight });
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}

// ── shortcuts bar ─────────────────────────────────────────────────────────────

export interface Shortcut {
  key: string;
  label: string;
}

/** `Key:label  │  Key:label` on the left; extension statuses and notices on the right. */
export function shortcutsBar(theme: Theme, state: () => { shortcuts: Shortcut[]; right: string }): Component {
  return line((width) => {
    const { shortcuts, right } = state();
    const left = shortcuts
      .map(({ key, label }) => `${theme.bold(theme.fg("text", key))}${theme.fg("muted", `:${label}`)}`)
      .join(theme.fg("dim", "  │  "));
    return right === "" ? fit(left, width) : spread(left, right, width);
  });
}

// ── queued messages ─────────────────────────────────────────────────────────────

export interface QueuedMessagesState {
  steering: readonly string[];
  followUp: readonly string[];
}

/**
 * Messages queued while a turn runs (4.1 排队区), between the turn status row and the prompt.
 * At most 3 lines: Pi's `Steering:` / `Follow-up:` lines, plus an Alt+Up hint if there is room.
 */
export function queuedMessagesBar(theme: Theme, state: () => QueuedMessagesState): Component {
  return {
    render(width: number): string[] {
      const { steering, followUp } = state();
      const lines = [
        ...steering.map((message) => `Steering: ${message}`),
        ...followUp.map((message) => `Follow-up: ${message}`),
      ].slice(0, 3);
      if (lines.length === 0) return [];
      if (lines.length < 3) lines.push("↳ Alt+Up to edit all queued messages");
      return lines.map((text) => fit(theme.fg("dim", text), width));
    },
    invalidate() {},
  };
}
