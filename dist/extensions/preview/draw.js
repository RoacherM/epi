import { piTui } from "../../tui/pi-tui.js";
const { getCellDimensions, getImageDimensions, Image, truncateToWidth, visibleWidth } = piTui;
export function pad(text, width) {
    if (width <= 0)
        return "";
    const clipped = truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
export function imageBody(base64, mimeType, theme, width, height, filename, dimensions, imageId, center = false) {
    const options = {
        maxWidthCells: width,
        maxHeightCells: height,
        ...(filename ? { filename } : {}),
        ...(imageId !== undefined ? { imageId } : {}),
    };
    const component = new Image(base64, mimeType, { fallbackColor: (text) => theme.fg("dim", text) }, options, dimensions);
    const rendered = component.render(width + 2).slice(0, height);
    while (rendered.length < height)
        rendered.push("");
    const id = component.getImageId();
    const indent = " ".repeat(center ? imageIndent(base64, mimeType, width, height, dimensions) : 0);
    return { lines: rendered.map((line) => pad(indent + line, width)), ...(id !== undefined ? { imageId: id } : {}) };
}
/** Columns to the left of an image fitted into width × height cells so it sits centered. */
function imageIndent(base64, mimeType, width, height, dimensions) {
    const size = dimensions ?? getImageDimensions(base64, mimeType);
    if (!size)
        return 0;
    const cell = getCellDimensions();
    const scale = Math.min((width * cell.widthPx) / size.widthPx, (height * cell.heightPx) / size.heightPx);
    const columns = Math.min(width, Math.ceil((size.widthPx * scale) / cell.widthPx));
    return Math.max(0, Math.floor((width - columns) / 2));
}
export function centered(text, width, height) {
    const lines = Array(height).fill(" ".repeat(Math.max(0, width)));
    const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
    lines[Math.floor(height / 2)] = " ".repeat(pad) + truncateToWidth(text, width - pad);
    return lines;
}
//# sourceMappingURL=draw.js.map