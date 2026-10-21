import { blend, motionTime, railBlend } from "./motion.js";
import { flashBlend, isFlashing } from "./tools/flash.js";
export function spineMember(component) {
    return "spineRole" in component ? component : undefined;
}
// The animated tip: the live turn's last rows, one pulse period (motion.ts RAIL_PERIOD). Small enough to
// stay on screen in any terminal the transcript has room in.
const TIP_ROWS = 8;
const ESCAPES = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
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
            current = undefined;
            return;
        }
        if (member === "spacer" || lines.length === 0) {
            current?.blocks.push(index);
            return;
        }
        current ??= turns[turns.push({ blocks: [], strong: false, closed: false }) - 1];
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
/** One spine cell. `flash`: the block's completion flash color, if one runs; `tip`: the row is in a
 * live turn's animated tip; `running`: the turn is live (a running tool's branch lights up). */
function paintRow(context, line, glyph, member, cell) {
    const { theme, t } = context;
    if (glyph === "fail")
        return overlay(line, theme.fg("error", "├─"), 2);
    const pulsing = cell.flash === undefined && cell.tip;
    const tone = cell.flash ?? (pulsing ? railBlend(theme, cell.row, t) : blend(theme, "borderMuted", "borderMuted", 0));
    if (glyph === "trunk")
        return overlay(line, tone.paint(pulsing ? "┃" : "│"), 1);
    if (glyph === "close")
        return overlay(line, tone.paint("╰─"), 2);
    // A running tool's branch holds steady between accent and thinkingHigh while the tip pulses past.
    const branch = cell.flash === undefined && cell.running && member.spineRunning ? blend(theme, "accent", "thinkingHigh", 0.5) : tone;
    return overlay(line, branch.paint("├─"), 2);
}
function paintTurn(context, blocks, turn, live) {
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
    const tipStart = live ? Math.max(0, last - first + 1 - TIP_ROWS) : Infinity;
    rows.slice(first, last + 1).forEach((position, index) => {
        const { block, row } = position;
        const placed = blocks[block];
        const member = placed.member === "spacer" ? { spineRole: "trunk" } : placed.member;
        const glyph = placed.member === "spacer" ? "trunk" : glyphFor(blocks, position, firstContentRow.get(block) ?? -1);
        const flashState = member.spineFlash?.(row);
        const flash = flashState !== undefined && isFlashing(flashState, context.now) ? flashBlend(flashState, context.theme, context.now) : undefined;
        placed.lines[row] = paintRow(context, placed.lines[row], glyph, member, { flash, tip: index >= tipStart, running: live, row: index });
    });
}
/**
 * Paints the spine into `blocks`' lines in place. `running`: a turn is in progress, so the last turn
 * that has no footer yet is live. Narrower than 4 columns there is no room for it.
 */
export function paintSpine(theme, blocks, width, running, now = Date.now()) {
    if (width < 4)
        return;
    const turns = findTurns(blocks);
    const context = { theme, t: motionTime(now), now };
    turns.forEach((turn, index) => paintTurn(context, blocks, turn, running && !turn.closed && index === turns.length - 1));
}
//# sourceMappingURL=spine.js.map