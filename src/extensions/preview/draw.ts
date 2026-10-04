// Drawing helpers shared by the browser and the viewer: fixed-width cells, scrollbars, images.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ImageDimensions } from "@earendil-works/pi-tui";

import { piTui } from "../../tui/pi-tui.js";

const { getCellDimensions, getImageDimensions, Image, truncateToWidth, visibleWidth } = piTui;

export function pad(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function imageBody(
  base64: string,
  mimeType: string,
  theme: Theme,
  width: number,
  height: number,
  filename?: string,
  dimensions?: ImageDimensions,
  imageId?: number,
  center = false,
): { lines: string[]; imageId?: number } {
  const options = {
    maxWidthCells: width,
    maxHeightCells: height,
    ...(filename ? { filename } : {}),
    ...(imageId !== undefined ? { imageId } : {}),
  };
  const component = new Image(base64, mimeType, { fallbackColor: (text: string) => theme.fg("dim", text) }, options, dimensions);
  const rendered = component.render(width + 2).slice(0, height);
  while (rendered.length < height) rendered.push("");
  const id = component.getImageId();
  const indent = " ".repeat(center ? imageIndent(base64, mimeType, width, height, dimensions) : 0);
  return { lines: rendered.map((line: string) => pad(indent + line, width)), ...(id !== undefined ? { imageId: id } : {}) };
}

/** Columns to the left of an image fitted into width × height cells so it sits centered. */
function imageIndent(base64: string, mimeType: string, width: number, height: number, dimensions?: ImageDimensions): number {
  const size = dimensions ?? getImageDimensions(base64, mimeType);
  if (!size) return 0;
  const cell = getCellDimensions();
  const scale = Math.min((width * cell.widthPx) / size.widthPx, (height * cell.heightPx) / size.heightPx);
  const columns = Math.min(width, Math.ceil((size.widthPx * scale) / cell.widthPx));
  return Math.max(0, Math.floor((width - columns) / 2));
}

/** Rows of a vertical scrollbar; blank when everything fits. */
export function scrollbar(theme: Theme, total: number, visible: number, offset: number, height: number): string[] {
  if (total <= visible) return Array<string>(height).fill(" ");
  const size = Math.max(1, Math.round((height * visible) / total));
  const start = Math.round(((height - size) * offset) / Math.max(1, total - visible));
  return Array.from({ length: height }, (_, row) =>
    row >= start && row < start + size ? theme.fg("accent", "┃") : theme.fg("dim", "│"),
  );
}

export function scrollFromBar(row: number, height: number, total: number, visible: number): number {
  const ratio = Math.max(0, Math.min(1, row / Math.max(1, height - 1)));
  return Math.round(ratio * Math.max(0, total - visible));
}

export function centered(text: string, width: number, height: number): string[] {
  const lines = Array<string>(height).fill(" ".repeat(Math.max(0, width)));
  const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  lines[Math.floor(height / 2)] = " ".repeat(pad) + truncateToWidth(text, width - pad);
  return lines;
}
