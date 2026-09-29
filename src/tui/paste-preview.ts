// Paste/image preview popup (docs/tui-design.md 4.3): shown right above the prompt frame whenever
// the caret sits on a chip. A grok-style rounded box, styled like chrome.ts's PromptFrame border.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { ChipInfo } from "./paste-chips.js";
import { piTui } from "./pi-tui.js";

const { truncateToWidth, visibleWidth } = piTui;

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…");
}

/** Rounded box with an optional dim hint centered in the bottom border, matching PromptFrame. */
function box(theme: Theme, width: number, bodyLines: string[], hint: string | undefined): string[] {
  const color = (text: string) => theme.fg("border", text);
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

function textPopup(theme: Theme, chip: Extract<ChipInfo, { kind: "text" }>, width: number): string[] {
  const inner = Math.max(1, width - 4);
  const lines = chip.content.split("\n");
  const body = lines.length <= 6
    ? lines
    : [...lines.slice(0, 3), `⋮ (${lines.length - 6} more lines)`, ...lines.slice(-3)];
  const hint = chip.justPasted ? "paste again or double-click to expand" : "enter or double-click to expand";
  return box(theme, width, body.map((line) => fit(line, inner)), hint);
}

function imagePopup(theme: Theme, chip: Extract<ChipInfo, { kind: "image" }>, width: number): string[] {
  const { image } = chip;
  const format = image.mimeType.split("/")[1]?.toUpperCase() ?? "IMAGE";
  const dimensions = image.width !== undefined && image.height !== undefined ? `${image.width}x${image.height} · ` : "";
  const size = `${(image.byteLength / 1024).toFixed(1)} KB`;
  const inner = Math.max(1, width - 4);
  const title = fit(`Image #${image.id} ─ ${format} · ${dimensions}${size}`, inner);
  const capabilities = piTui.getCapabilities();
  if (!capabilities.images) return box(theme, width, [title], undefined);
  const picture = new piTui.Image(image.base64, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, {
    maxWidthCells: inner,
  });
  return box(theme, width, [title, ...picture.render(inner)], undefined);
}

/** Empty when nothing is being previewed, so it costs zero rows in the layout otherwise. */
export function pastePreview(theme: Theme, getChip: () => ChipInfo | undefined): Component {
  return {
    render(width: number): string[] {
      const chip = getChip();
      if (chip === undefined) return [];
      return chip.kind === "text" ? textPopup(theme, chip, width) : imagePopup(theme, chip, width);
    },
    invalidate() {},
  };
}
