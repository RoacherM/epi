import type { Component, TUI } from "@earendil-works/pi-tui";
import type { InspectTarget } from "./buffer/inspector.js";
import { type ChipEditor, type ChipInfo } from "./paste-chips.js";
export interface ChipViewHost {
    readonly tui: TUI;
    inspect(target: InspectTarget): void;
    takeEditorSlot(component: Component): () => void;
    notice(text: string, tone: "info" | "warning" | "error"): void;
}
type TextChip = Extract<ChipInfo, {
    kind: "text";
}>;
export declare function viewTextChip(host: ChipViewHost, editor: ChipEditor, chip: TextChip): void;
export {};
//# sourceMappingURL=chip-view.d.ts.map