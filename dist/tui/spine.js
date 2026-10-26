import { blend } from "./motion.js";
import { flashBlend, isFlashing } from "./tools/flash.js";
/** The last row of `lines` with text, or undefined: where a block being written writes. */
export function lastTextRow(lines) {
    const row = lines.findLastIndex((line) => !isBlank(line));
    return row === -1 ? undefined : row;
}
export function spineMember(component) {
    return "spineRole" in component ? component : undefined;
}
// The animated tip: the live turn's last rows. Small enough to stay on screen in any terminal the
// transcript has room in, and to hold a call row and its running output (RUNNING_SLICE_ROWS). Running
// duration bars obey it too (tools/group.ts, ClockGated).
export const TIP_ROWS = 8;
export function isClockGated(component) {
    return "clockLive" in component;
}
const ESCAPES = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// pi-tui's image lines (terminal-image.js isImageLine, not exported): Kitty and iTerm2 sequences.
const IMAGE = /\x1b_G|\x1b\]1337;File=/;
const KITTY_PARAMS = /\x1b_G([^;]*);/;
const ITERM2_MOVE_UP = /(?:\x1b\[(\d+)A)?\x1b\]1337;File=/;
// Prompt-zone markers (OSC 133) only: an image line's own escape sequence is not a margin to draw in.
const LEADING_OSC = /^(?:\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\))*/;
function plain(line) {
    return line.replace(ESCAPES, "");
}
function isBlank(line) {
    return plain(line).trim() === "";
}
/** Consecutive turn blocks (spacers and empty blocks between them included), cut at anything that
 * isn't part of a turn and closed by a footer. */
function findTurns(blocks) {
    const turns = [];
    let current;
    blocks.forEach(({ lines, member }, index) => {
        if (member === undefined) {
            if (lines.length > 0)
                for (const turn of turns)
                    turn.cut = true;
            current = undefined;
            return;
        }
        if (member === "spacer" || lines.length === 0) {
            current?.blocks.push(index);
            return;
        }
        current ??= turns[turns.push({ blocks: [], strong: false, closed: false, cut: false }) - 1];
        current.blocks.push(index);
        if (member.spineRole !== "bash")
            current.strong = true;
        if (member.spineRole === "footer") {
            current.closed = true;
            current = undefined;
        }
    });
    return turns.filter((turn) => turn.strong);
}
function glyphFor(blocks, { block, row }, firstContentRow) {
    const member = blocks[block].member;
    if (member.spineRole === "footer")
        return "close";
    if (member.spineRole !== "tool" && member.spineRole !== "bash")
        return "trunk";
    if (row === firstContentRow)
        return "branch";
    // tools/common.ts failureRow(): a failure is the row whose text starts with `✗`.
    return plain(blocks[block].lines[row]).trimStart().startsWith("✗ ") ? "fail" : "trunk";
}
/** Columns 1-2 of `line` replaced by `glyphs` (one or two columns), when the block left them blank;
 * otherwise the line as it was. Zero-width OSC markers at the start (prompt zones) stay first. */
function overlay(line, glyphs, columns) {
    const marker = LEADING_OSC.exec(line)?.[0] ?? "";
    const rest = line.slice(marker.length);
    const needed = columns + 1;
    if (rest === "" || /^ *$/.test(rest))
        return `${marker} ${glyphs}`;
    if (!rest.startsWith(" ".repeat(needed)))
        return line;
    return `${marker} ${glyphs}${rest.slice(needed)}`;
}
/** One spine cell. `flash`: the block's completion flash color, if one runs (only ever inside the
 * last turn's tip); `carriage`: the row being written (only ever in a live turn's tip). */
function paintRow(theme, line, glyph, cell) {
    if (glyph === "fail")
        return overlay(line, theme.fg("error", "├─"), 2);
    const tone = cell.flash ?? blend(theme, "borderMuted", "borderMuted", 0);
    if (glyph === "trunk")
        return overlay(line, cell.carriage ? theme.fg("accent", "┃") : tone.paint("│"), 1);
    if (glyph === "close")
        return overlay(line, tone.paint("╰─"), 2);
    return overlay(line, cell.carriage ? theme.fg("accent", "┝") + tone.paint("─") : tone.paint("├─"), 2);
}
/** Where the carriage sits in `rows` (an index), if anywhere: the last row a block of the turn is
 * writing. */
function carriageIndex(blocks, rows) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const { block, row } = rows[index];
        const placed = blocks[block];
        if (row !== placed.lines.length - 1 || placed.member === undefined || placed.member === "spacer")
            continue;
        const written = placed.member.spineWriteRow?.(placed.lines);
        if (written !== undefined)
            return index - row + written;
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
function imageRows(lines) {
    const rows = new Set();
    const reserved = (row) => row >= 0 && row < lines.length && !IMAGE.test(lines[row]) && plain(lines[row]).trim() === "";
    lines.forEach((line, row) => {
        const kitty = KITTY_PARAMS.exec(line);
        const iterm = kitty === null ? ITERM2_MOVE_UP.exec(line) : null;
        if (kitty === null && iterm === null)
            return;
        rows.add(row);
        if (iterm !== null) {
            for (let up = row - 1; up >= row - Number(iterm[1] ?? 0) && reserved(up); up -= 1)
                rows.add(up);
            return;
        }
        const stated = /(?:^|,)r=(\d+)/.exec(kitty[1])?.[1];
        const last = stated === undefined ? lines.length : row + Number(stated);
        for (let below = row + 1; below < last && reserved(below); below += 1)
            rows.add(below);
    });
    return rows;
}
/** `tipped`: the newest turn, whose last rows may move (flashes; the carriage too while `live`). */
function paintTurn(context, blocks, turn, tipped, live) {
    const rows = turn.blocks.flatMap((block) => blocks[block].lines.map((_, row) => ({ block, row })));
    const first = rows.findIndex(({ block, row }) => !isBlank(blocks[block].lines[row]));
    if (first === -1)
        return;
    let last = rows.length - 1;
    while (isBlank(blocks[rows[last].block].lines[rows[last].row]))
        last -= 1;
    const firstContentRow = new Map();
    for (const { block, row } of rows.slice(first, last + 1)) {
        if (!firstContentRow.has(block) && !isBlank(blocks[block].lines[row]))
            firstContentRow.set(block, row);
    }
    const tipStart = tipped ? Math.max(0, last - first + 1 - TIP_ROWS) : Infinity;
    const written = live ? carriageIndex(blocks, rows) : undefined;
    const carriage = written !== undefined && written - first >= tipStart ? written : undefined;
    const images = new Map(turn.blocks.map((block) => [block, imageRows(blocks[block].lines)]));
    rows.slice(first, last + 1).forEach((position, index) => {
        const { block, row } = position;
        const placed = blocks[block];
        if (images.get(block).has(row))
            return;
        const member = placed.member === "spacer" ? undefined : placed.member;
        const glyph = placed.member === "spacer" ? "trunk" : glyphFor(blocks, position, firstContentRow.get(block) ?? -1);
        const tip = index >= tipStart;
        const flashState = tip ? member?.spineFlash?.(row) : undefined;
        const flash = flashState !== undefined && isFlashing(flashState, context.now) ? flashBlend(flashState, context.theme, context.now) : undefined;
        placed.lines[row] = paintRow(context.theme, placed.lines[row], glyph, { flash, carriage: index + first === carriage });
    });
}
/**
 * Paints the spine into `blocks`' lines in place. `running`: a turn is in progress, so the last turn
 * is live if it has no footer yet and nothing outside a turn (the new prompt's user message) came
 * after it. Narrower than 4 columns there is no room for it.
 */
export function paintSpine(theme, blocks, width, running, now = Date.now()) {
    if (width < 4)
        return;
    const turns = findTurns(blocks);
    const context = { theme, now };
    turns.forEach((turn, index) => {
        const tipped = !turn.cut && index === turns.length - 1;
        paintTurn(context, blocks, turn, tipped, tipped && running && !turn.closed);
    });
}
//# sourceMappingURL=spine.js.map