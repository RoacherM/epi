import { piTui } from "./pi-tui.js";
const { truncateToWidth, visibleWidth } = piTui;
function fit(text, width) {
    return truncateToWidth(text, Math.max(0, width), "…");
}
/** Rounded box with an optional dim hint centered in the bottom border, matching PromptFrame. */
function box(theme, width, bodyLines, hint) {
    const color = (text) => theme.fg("border", text);
    const top = color(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const rows = bodyLines.map((line) => {
        const padded = line + " ".repeat(Math.max(0, width - 4 - visibleWidth(line)));
        return `${color("│")} ${padded} ${color("│")}`;
    });
    const label = hint === undefined ? "" : ` ${hint} `;
    const fill = Math.max(0, width - 2 - visibleWidth(label));
    const bottom = visibleWidth(label) + 2 <= width
        ? `${color("╰")}${theme.fg("muted", label)}${color(`${"─".repeat(fill)}╯`)}`
        : color(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
    return [top, ...rows, bottom];
}
function textPopup(theme, chip, width) {
    const inner = Math.max(1, width - 4);
    const lines = chip.content.split("\n");
    const body = lines.length <= 6
        ? lines
        : [...lines.slice(0, 3), `⋮ (${lines.length - 6} more lines)`, ...lines.slice(-3)];
    const hint = chip.justPasted ? "paste again or double-click to expand" : "enter or double-click to expand";
    return box(theme, width, body.map((line) => fit(line, inner)), hint);
}
function imagePopup(theme, chip, width) {
    const { image } = chip;
    const format = image.mimeType.split("/")[1]?.toUpperCase() ?? "IMAGE";
    const dimensions = image.width !== undefined && image.height !== undefined ? `${image.width}x${image.height} · ` : "";
    const size = `${(image.byteLength / 1024).toFixed(1)} KB`;
    const inner = Math.max(1, width - 4);
    const title = fit(`Image #${image.id} ─ ${format} · ${dimensions}${size}`, inner);
    const capabilities = piTui.getCapabilities();
    if (!capabilities.images)
        return box(theme, width, [title], undefined);
    const picture = new piTui.Image(image.base64, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, {
        maxWidthCells: inner,
    });
    return box(theme, width, [title, ...picture.render(inner)], undefined);
}
/** Empty when nothing is being previewed, so it costs zero rows in the layout otherwise. */
export function pastePreview(theme, getChip) {
    return {
        render(width) {
            const chip = getChip();
            if (chip === undefined)
                return [];
            return chip.kind === "text" ? textPopup(theme, chip, width) : imagePopup(theme, chip, width);
        },
        invalidate() { },
    };
}
//# sourceMappingURL=paste-preview.js.map