// The turn spine (docs/tui-transcript-layout-design.md §7.3 "V-S", docs/tui-transcript-layout-
// implementation.md W7/W8): one agent turn reads as one line down column 1 -- a `│` trunk beside the
// reply text and thinking, a `├─` branch into each tool call (red into a failure row), `╰─` into the
// `Worked for` footer, all a quiet `borderMuted`. While the turn runs, one accent cell marks the row
// being written, the carriage (docs/tui-ctrl-o-per-block-design.md §9.1): `┃` on a trunk row, `┝` on
// a call row. It moves down a row per new line and jumps back up when a running tool's output folds
// away. A finished tool or thinking run flashes its stretch (docs/tui-motion-design.md M6).
//
// Only the tip moves, never the whole turn: pi-tui's main-screen renderer can only patch rows still
// on screen, and a changed row that has scrolled off forces a full redraw (scrollback cleared and
// everything written again). So the carriage and the completion flash stay inside the tip (a
// carriage that would fall above it is not drawn); rows above it look exactly as they will once the
// turn settles, so settling doesn't touch them either.
//
// Painted at render time over the rows the transcript's blocks drew, like tools/group.ts's grouping,
// so a /resume replay gets the same spine as a live run. Only glyphs in columns 1-2 change, never a
// row count, so click routing is untouched. Only blocks that declare a role join a turn (a whitelist):
// user messages, notices, extension messages and anything unknown break the spine.
import type { Theme } from "@earendil-works/pi-coding-agent";

import { type Blend, blend } from "./motion.js";
import { type FlashState, flashBlend, isFlashing } from "./tools/flash.js";

/** `trunk`: every row on the trunk (reply text, thinking). `tool`: a branch into its first row.
 * `bash`: like `tool`, but a `!cmd` alone (no turn around it) gets no spine. `footer`: closes the turn. */
export type SpineRole = "trunk" | "tool" | "bash" | "footer";

/** What a transcript block tells the spine about itself, declared on the component. */
export interface SpineMember {
  readonly spineRole: SpineRole;
  /** The flash running on `row` of the block's last render, if any. */
  spineFlash?(row: number): FlashState | undefined;
  /** The row of `lines` (the block's rows as placed) being written right now -- a streaming reply's
   * last row, a running tool's last output row or its call row -- or undefined when nothing is. */
  spineWriteRow?(lines: readonly string[]): number | undefined;
}

/** The last row of `lines` with text, or undefined: where a block being written writes. */
export function lastTextRow(lines: readonly string[]): number | undefined {
  const row = lines.findLastIndex((line) => !isBlank(line));
  return row === -1 ? undefined : row;
}

export function spineMember(component: object): SpineMember | undefined {
  return "spineRole" in component ? (component as SpineMember) : undefined;
}

/** One block's rows as GroupedMessages placed them. `member` undefined: not part of a turn. */
export interface SpineBlock {
  lines: string[];
  member: SpineMember | "spacer" | undefined;
}

type Glyph = "trunk" | "branch" | "fail" | "close";

// The animated tip: the live turn's last rows. Small enough to stay on screen in any terminal the
// transcript has room in, and to hold a call row and its running output (RUNNING_SLICE_ROWS). Running
// duration bars obey it too (tools/group.ts, ClockGated).
export const TIP_ROWS = 8;

/**
 * A block whose rows change with the clock alone (a running tool's duration bar), not only when
 * something happens. While its clock row (the first row with text: the call row) is outside the
 * transcript's last TIP_ROWS rows, it draws at the time it last showed inside them (clock.ts), or
 * every frame would change a row that may have scrolled off -- the full redraw the spine's tip exists
 * to avoid. GroupedMessages sets `clockLive` before each render; an event (new arguments, output,
 * the result) still changes the rows wherever they are.
 */
export interface ClockGated {
  clockLive: boolean;
  /** The row that moves with the clock, when not the first row with text (a thinking run after the
   * reply's text). */
  readonly clockRow?: number | undefined;
}

export function isClockGated(component: object): component is ClockGated {
  return "clockLive" in component;
}

const ESCAPES = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// pi-tui's image lines (terminal-image.js isImageLine, not exported): Kitty and iTerm2 sequences.
const IMAGE = /\x1b_G|\x1b\]1337;File=/;
const KITTY_PARAMS = /\x1b_G([^;]*);/;
const ITERM2_MOVE_UP = /(?:\x1b\[(\d+)A)?\x1b\]1337;File=/;
// Prompt-zone markers (OSC 133) only: an image line's own escape sequence is not a margin to draw in.
const LEADING_OSC = /^(?:\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\))*/;

function plain(line: string): string {
  return line.replace(ESCAPES, "");
}

function isBlank(line: string): boolean {
  return plain(line).trim() === "";
}

interface Turn {
  blocks: number[];
  strong: boolean;
  closed: boolean;
  /** Something that isn't part of a turn (a user message, a notice) came after it: it can't be live. */
  cut: boolean;
}

/** Consecutive turn blocks (spacers and empty blocks between them included), cut at anything that
 * isn't part of a turn and closed by a footer. */
function findTurns(blocks: readonly SpineBlock[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  blocks.forEach(({ lines, member }, index) => {
    if (member === undefined) {
      if (lines.length > 0) for (const turn of turns) turn.cut = true;
      current = undefined;
      return;
    }
    if (member === "spacer" || lines.length === 0) {
      current?.blocks.push(index);
      return;
    }
    current ??= turns[turns.push({ blocks: [], strong: false, closed: false, cut: false }) - 1];
    current!.blocks.push(index);
    if (member.spineRole !== "bash") current!.strong = true;
    if (member.spineRole === "footer") {
      current!.closed = true;
      current = undefined;
    }
  });
  return turns.filter((turn) => turn.strong);
}

interface Row {
  block: number;
  row: number;
}

function glyphFor(blocks: readonly SpineBlock[], { block, row }: Row, firstContentRow: number): Glyph {
  const member = blocks[block]!.member as SpineMember;
  if (member.spineRole === "footer") return "close";
  if (member.spineRole !== "tool" && member.spineRole !== "bash") return "trunk";
  if (row === firstContentRow) return "branch";
  // tools/common.ts failureRow(): a failure is the row whose text starts with `✗`.
  return plain(blocks[block]!.lines[row]!).trimStart().startsWith("✗ ") ? "fail" : "trunk";
}

/** Columns 1-2 of `line` replaced by `glyphs` (one or two columns), when the block left them blank;
 * otherwise the line as it was. Zero-width OSC markers at the start (prompt zones) stay first. */
function overlay(line: string, glyphs: string, columns: number): string {
  const marker = LEADING_OSC.exec(line)?.[0] ?? "";
  const rest = line.slice(marker.length);
  const needed = columns + 1;
  if (rest === "" || /^ *$/.test(rest)) return `${marker} ${glyphs}`;
  if (!rest.startsWith(" ".repeat(needed))) return line;
  return `${marker} ${glyphs}${rest.slice(needed)}`;
}

interface PaintContext {
  theme: Theme;
  now: number;
}

/** One spine cell. `flash`: the block's completion flash color, if one runs (only ever inside the
 * last turn's tip); `carriage`: the row being written (only ever in a live turn's tip). */
function paintRow(theme: Theme, line: string, glyph: Glyph, cell: { flash: Blend | undefined; carriage: boolean }): string {
  if (glyph === "fail") return overlay(line, theme.fg("error", "├─"), 2);
  const tone = cell.flash ?? blend(theme, "borderMuted", "borderMuted", 0);
  if (glyph === "trunk") return overlay(line, cell.carriage ? theme.fg("accent", "┃") : tone.paint("│"), 1);
  if (glyph === "close") return overlay(line, tone.paint("╰─"), 2);
  return overlay(line, cell.carriage ? theme.fg("accent", "┝") + tone.paint("─") : tone.paint("├─"), 2);
}

/** Where the carriage sits in `rows` (an index), if anywhere: the last row a block of the turn is
 * writing. */
function carriageIndex(blocks: readonly SpineBlock[], rows: readonly Row[]): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const { block, row } = rows[index]!;
    const placed = blocks[block]!;
    if (row !== placed.lines.length - 1 || placed.member === undefined || placed.member === "spacer") continue;
    const written = placed.member.spineWriteRow?.(placed.lines);
    if (written !== undefined) return index - row + written;
  }
  return undefined;
}

/** Rows a block's image keeps for itself, as pi-tui's Image lays it out (components/image.js): Kitty
 * puts its sequence on the first row (its `r=` parameter is the height) and keeps the rows after it,
 * which pi-tui searches back through to draw an image whose first row has scrolled off; iTerm2 keeps
 * the rows before its last row, which moves the cursor up over them (`ESC[<n>A`; none for a one-row
 * image). A Kitty sequence with no `r=` (encodeKitty with columns only: the terminal picks the
 * height) takes every blank row after it. Those rows must stay as the block drew them (empty, or padded
 * with spaces inside Markdown) on every frame: pi-tui patching one would erase part of the image
 * without drawing it again. */
function imageRows(lines: readonly string[]): Set<number> {
  const rows = new Set<number>();
  const reserved = (row: number) => row >= 0 && row < lines.length && !IMAGE.test(lines[row]!) && plain(lines[row]!).trim() === "";
  lines.forEach((line, row) => {
    const kitty = KITTY_PARAMS.exec(line);
    const iterm = kitty === null ? ITERM2_MOVE_UP.exec(line) : null;
    if (kitty === null && iterm === null) return;
    rows.add(row);
    if (iterm !== null) {
      for (let up = row - 1; up >= row - Number(iterm[1] ?? 0) && reserved(up); up -= 1) rows.add(up);
      return;
    }
    const stated = /(?:^|,)r=(\d+)/.exec(kitty![1]!)?.[1];
    const last = stated === undefined ? lines.length : row + Number(stated);
    for (let below = row + 1; below < last && reserved(below); below += 1) rows.add(below);
  });
  return rows;
}

/** `tipped`: the newest turn, whose last rows may move (flashes; the carriage too while `live`). */
function paintTurn(context: PaintContext, blocks: SpineBlock[], turn: Turn, tipped: boolean, live: boolean): void {
  const rows: Row[] = turn.blocks.flatMap((block) => blocks[block]!.lines.map((_, row) => ({ block, row })));
  const first = rows.findIndex(({ block, row }) => !isBlank(blocks[block]!.lines[row]!));
  if (first === -1) return;
  let last = rows.length - 1;
  while (isBlank(blocks[rows[last]!.block]!.lines[rows[last]!.row]!)) last -= 1;
  const firstContentRow = new Map<number, number>();
  for (const { block, row } of rows.slice(first, last + 1)) {
    if (!firstContentRow.has(block) && !isBlank(blocks[block]!.lines[row]!)) firstContentRow.set(block, row);
  }
  const tipStart = tipped ? Math.max(0, last - first + 1 - TIP_ROWS) : Infinity;
  const written = live ? carriageIndex(blocks, rows) : undefined;
  const carriage = written !== undefined && written - first >= tipStart ? written : undefined;
  const images = new Map(turn.blocks.map((block) => [block, imageRows(blocks[block]!.lines)]));
  rows.slice(first, last + 1).forEach((position, index) => {
    const { block, row } = position;
    const placed = blocks[block]!;
    if (images.get(block)!.has(row)) return;
    const member = placed.member === "spacer" ? undefined : (placed.member as SpineMember);
    const glyph = placed.member === "spacer" ? "trunk" : glyphFor(blocks, position, firstContentRow.get(block) ?? -1);
    const tip = index >= tipStart;
    const flashState = tip ? member?.spineFlash?.(row) : undefined;
    const flash = flashState !== undefined && isFlashing(flashState, context.now) ? flashBlend(flashState, context.theme, context.now) : undefined;
    placed.lines[row] = paintRow(context.theme, placed.lines[row]!, glyph, { flash, carriage: index + first === carriage });
  });
}

/**
 * Paints the spine into `blocks`' lines in place. `running`: a turn is in progress, so the last turn
 * is live if it has no footer yet and nothing outside a turn (the new prompt's user message) came
 * after it. Narrower than 4 columns there is no room for it.
 */
export function paintSpine(theme: Theme, blocks: SpineBlock[], width: number, running: boolean, now = Date.now()): void {
  if (width < 4) return;
  const turns = findTurns(blocks);
  const context: PaintContext = { theme, now };
  turns.forEach((turn, index) => {
    const tipped = !turn.cut && index === turns.length - 1;
    paintTurn(context, blocks, turn, tipped, tipped && running && !turn.closed);
  });
}
