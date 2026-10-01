import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ChipInfo } from "./paste-chips.js";
/** Empty when nothing is being previewed, so it costs zero rows in the layout otherwise. */
export declare function pastePreview(theme: Theme, getChip: () => ChipInfo | undefined): Component;
//# sourceMappingURL=paste-preview.d.ts.map