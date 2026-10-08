import { dropTrailingNewline } from "./paste-chips.js";
import { piTui } from "./pi-tui.js";
const { truncateToWidth, visibleWidth } = piTui;
function fit(text, width) {
    return truncateToWidth(text, Math.max(0, width), "…");
}
// grok's popup reads roughly 40 columns against a much wider input box (item 7, docs/tui-design.md
// 4.3): never narrower than the content needs, but widened toward (not capped at -- min() below
// still bounds it by whatever space the caller actually has) 60% of that space so a short hint or
// title doesn't sit in an oddly cramped box.
const WIDTH_FRACTION = 0.6;
const MIN_WIDTH = 10;
function popupWidth(available, bodyLines, label) {
    const bodyNeeded = Math.max(0, ...bodyLines.map((line) => visibleWidth(line))) + 4; // 2 borders + 2 padding
    const labelNeeded = label === undefined ? 0 : visibleWidth(label) + 6; // 2 borders + 1 dash each side + " label "
    const needed = Math.max(bodyNeeded, labelNeeded, MIN_WIDTH);
    const grokish = Math.floor(available * WIDTH_FRACTION);
    return Math.min(available, Math.max(needed, grokish));
}
/** `corner + fill dashes + " label " + one more dash + corner`, e.g. `╰─ hint ─╯` -- a dash right
 * after the corner on both ends, not a bare corner-then-label (item 7). Mirrors PromptFrame's own
 * bottom border (chrome.ts), generalized to either edge; `label` of `undefined` is a plain rule,
 * same as a label that can't fit at all (dropped rather than overflowing `width`). */
function borderRow(theme, left, right, label, width) {
    const color = (text) => theme.fg("border", text);
    const text = label === undefined ? undefined : ` ${label} `;
    if (text === undefined || visibleWidth(text) + 4 > width)
        return color(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
    const fill = Math.max(1, width - 2 - visibleWidth(text) - 1);
    return `${color(left)}${color("─".repeat(fill))}${theme.fg("muted", text)}${color("─")}${color(right)}`;
}
/** Rounded box; either edge can carry a label (image popups put their title on top, text popups
 * put their hint on the bottom -- docs/tui-design.md 4.3). */
function box(theme, width, bodyLines, topLabel, bottomLabel) {
    const color = (text) => theme.fg("border", text);
    const rows = bodyLines.map((line) => {
        const padded = line + " ".repeat(Math.max(0, width - 4 - visibleWidth(line)));
        return `${color("│")} ${padded} ${color("│")}`;
    });
    return [borderRow(theme, "╭", "╮", topLabel, width), ...rows, borderRow(theme, "╰", "╯", bottomLabel, width)];
}
function textPopup(theme, chip, width) {
    // Matches decidePasteChip's own line count (item 4): a trailing newline is the last line's
    // terminator, not an extra blank line, so the popup's "N more lines" agrees with the chip label.
    const lines = dropTrailingNewline(chip.content).split("\n");
    const body = lines.length <= 6
        ? lines
        : [...lines.slice(0, 3), `⋮ (${lines.length - 6} more lines)`, ...lines.slice(-3)];
    const hint = chip.justPasted ? "paste again or double-click to expand" : "enter or double-click to expand";
    const boxWidth = popupWidth(width, body, hint);
    const inner = Math.max(1, boxWidth - 4);
    return box(theme, boxWidth, body.map((line) => fit(line, inner)), undefined, hint);
}
function pictureFor(theme, image, cache) {
    let picture = cache.get(image);
    if (picture === undefined) {
        // No width cap here: render(inner) already limits the picture to the box.
        picture = new piTui.Image(image.base64, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, {
            maxWidthCells: Number.POSITIVE_INFINITY,
        });
        cache.set(image, picture);
    }
    return picture;
}
function imagePopup(theme, chip, width, cache) {
    const { image } = chip;
    const format = image.mimeType.split("/")[1]?.toUpperCase() ?? "IMAGE";
    const dimensions = image.width !== undefined && image.height !== undefined ? `${image.width}x${image.height} · ` : "";
    const size = `${(image.byteLength / 1024).toFixed(1)} KB`;
    const title = `Image #${image.id} ─ ${format} · ${dimensions}${size}`;
    const boxWidth = popupWidth(width, [], title);
    const inner = Math.max(1, boxWidth - 4);
    const fittedTitle = fit(title, Math.max(1, boxWidth - 6));
    const capabilities = piTui.getCapabilities();
    if (!capabilities.images)
        return box(theme, boxWidth, [], fittedTitle, undefined);
    return box(theme, boxWidth, pictureFor(theme, image, cache).render(inner), fittedTitle, undefined);
}
/** Empty when nothing is being previewed, so it costs zero rows in the layout otherwise. */
export function pastePreview(theme, getChip) {
    const pictures = new WeakMap();
    return {
        render(width) {
            const chip = getChip();
            if (chip === undefined)
                return [];
            return chip.kind === "text" ? textPopup(theme, chip, width) : imagePopup(theme, chip, width, pictures);
        },
        invalidate() { },
    };
}
//# sourceMappingURL=paste-preview.js.map