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
    /** Start with long lines wrapped (prose); off by default (code, logs). */
    wrap?: boolean;
    /** Set when the content can be edited: `e` closes the inspector and calls it. */
    edit?: () => void;
    /** Content that changes while shown (a running task): the inspector starts at the end, calls
     * `subscribe` once open, and stops the subscription when it closes. */
    live?: {
        subscribe(update: (target: InspectTarget) => void): () => void;
    };
    /** Lines that open something (a list of tasks): a click on logical line `line` (0-based), or
     * Enter on the first line shown, opens the page this returns on top; Esc comes back. */
    openLine?: (line: number) => InspectTarget | undefined;
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
    private readonly actions;
    private readonly views;
    constructor(theme: Theme, target: InspectTarget, actions: InspectorActions);
    /** The page on top. */
    get viewport(): BufferViewport;
    private get view();
    private get target();
    private push;
    /** Leaves the page on top for the one under it; false when it is the only one. */
    private back;
    private close;
    /** Ends live updates; the host calls it when it hides the overlay. */
    dispose(): void;
    /** New content for a live page (a running task): the position is kept, and a page scrolled to
     * the end follows new lines. */
    private update;
    /** `openLine`'s page for logical line `line`, opened on top. */
    private open;
    handleInput(data: string): void;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult;
    render(width: number): string[];
    invalidate(): void;
    private topBorder;
    private bottomBorder;
    private yank;
}
//# sourceMappingURL=inspector.d.ts.map