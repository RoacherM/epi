// A one-column vertical scrollbar beside a scrolling body, and the scroll position a click or drag
// on it means (docs/tui-buffer-components.md). Shared by /preview, /review, /trace and the block
// inspector, which differ only in how the column looks.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export interface ScrollbarStyle {
  /** Color of the thumb `┃`. */
  thumb: ThemeColor;
  /** Color of the track `│`. */
  track: ThemeColor;
  /** The column when everything fits: blank (default), or a plain `│` in this color (a frame edge). */
  fits?: ThemeColor;
}

const PAGE_STYLE: ScrollbarStyle = { thumb: "accent", track: "dim" };

/** `height` rows of the scrollbar for `total` rows, `visible` of them shown from `offset`. */
export function scrollbar(theme: Theme, total: number, visible: number, offset: number, height: number, style: ScrollbarStyle = PAGE_STYLE): string[] {
  if (total <= visible) return Array<string>(height).fill(style.fits === undefined ? " " : theme.fg(style.fits, "│"));
  const size = Math.max(1, Math.round((height * visible) / total));
  const start = Math.round(((height - size) * offset) / Math.max(1, total - visible));
  return Array.from({ length: height }, (_, row) =>
    row >= start && row < start + size ? theme.fg(style.thumb, "┃") : theme.fg(style.track, "│"),
  );
}

/** The scroll offset for a click or drag on scrollbar row `row` of `height`. */
export function scrollFromBar(row: number, height: number, total: number, visible: number): number {
  const ratio = Math.max(0, Math.min(1, row / Math.max(1, height - 1)));
  return Math.round(ratio * Math.max(0, total - visible));
}
