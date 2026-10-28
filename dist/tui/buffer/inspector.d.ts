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
    /** Content that changes while shown (a running task): the inspector calls `subscribe` once open
     * and stops the subscription when it closes. With `follow`, the page starts at the end and stays
     * there while new lines arrive (a log); without, it keeps its place (a list, newest first). */
    live?: {
        subscribe(update: (target: InspectTarget) => void): () => void;
        follow?: boolean;
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
    /** New content for a live page: the position is kept, and a following page at the end moves to
     * the new end at once, so a key or click before the next frame sees where it will be drawn. The
     * page keeps its own `live` (a refresh's content need not carry it). */
    private update;
    /** `openLine`'s page for logical line `line`, opened on top. */
    private open;
    /** After the reader moved: a following page follows again once back at the end. */
    private noteScroll;
    handleInput(data: string): void;
    private handleKey;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult;
    render(width: number): string[];
    invalidate(): void;
    private topBorder;
    /** The position readout on the bottom border's left, or the prompt/status in its place. */
    private positionLabel;
    /** The keys the bottom border lists: the page's own action first, `q back` on a page opened from
     * a list. */
    private keyHint;
    private bottomBorder;
    private yank;
}
//# sourceMappingURL=inspector.d.ts.map