import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ChipInfo } from "./paste-chips.js";
/** Empty when nothing is being previewed, so it costs zero rows in the layout otherwise. A left
 * click on a text chip's popup hands the chip to `onView` (the full text, editable). */
export declare function pastePreview(theme: Theme, getChip: () => ChipInfo | undefined, onView?: (chip: Extract<ChipInfo, {
    kind: "text";
}>) => void): Component;
//# sourceMappingURL=paste-preview.d.ts.map