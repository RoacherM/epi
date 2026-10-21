const PAGE_STYLE = { thumb: "accent", track: "dim" };
/** `height` rows of the scrollbar for `total` rows, `visible` of them shown from `offset`. */
export function scrollbar(theme, total, visible, offset, height, style = PAGE_STYLE) {
    if (total <= visible)
        return Array(height).fill(style.fits === undefined ? " " : theme.fg(style.fits, "│"));
    const size = Math.max(1, Math.round((height * visible) / total));
    const start = Math.round(((height - size) * offset) / Math.max(1, total - visible));
    return Array.from({ length: height }, (_, row) => row >= start && row < start + size ? theme.fg(style.thumb, "┃") : theme.fg(style.track, "│"));
}
/** The scroll offset for a click or drag on scrollbar row `row` of `height`. */
export function scrollFromBar(row, height, total, visible) {
    const ratio = Math.max(0, Math.min(1, row / Math.max(1, height - 1)));
    return Math.round(ratio * Math.max(0, total - visible));
}
//# sourceMappingURL=scrollbar.js.map