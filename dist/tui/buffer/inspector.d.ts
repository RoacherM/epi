import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { BufferViewport } from "./viewport.js";
/** What a block hands the inspector: the untruncated lines and how to label them. */
export interface InspectTarget {
    /** e.g. `read src/app.ts:1-100`, `$ npm test`. */
    title: string;
    /** e.g. `129 lines · exit 0`. */
    subtitle?: string;
    /** Styled lines, one per logical line. */
    lines: readonly string[];
    /** Gutter number of lines[0]; no gutter when the lines carry their own numbers (a diff). */
    firstLineNumber?: number;
    /** Plain text `y` copies. */
    text: string;
}
export interface InspectorActions {
    close(): void;
    /** Copies `text`; rejects when the clipboard is unavailable. */
    copy(text: string): Promise<void>;
    requestRender(): void;
    /** Terminal rows, read on every render so a resize resizes the overlay. */
    terminalRows(): number;
}
export declare class BlockInspectorOverlay implements Component {
    private readonly theme;
    private readonly target;
    private readonly actions;
    readonly viewport: BufferViewport;
    constructor(theme: Theme, target: InspectTarget, actions: InspectorActions);
    handleInput(data: string): void;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult;
    render(width: number): string[];
    invalidate(): void;
    private topBorder;
    private bottomBorder;
    private yank;
}
//# sourceMappingURL=inspector.d.ts.map