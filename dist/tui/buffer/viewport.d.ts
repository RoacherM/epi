import { TextNavigation } from "./navigation.js";
export interface BufferContent {
    /** Styled lines, one per logical line. */
    lines: readonly string[];
    /** Number shown for lines[0] in the gutter; no gutter when undefined (text that carries its own
     * numbers, such as a diff). `:N` and `NG` count from it either way. */
    firstLineNumber?: number;
}
export interface BufferStyle {
    gutter(text: string): string;
    separator(text: string): string;
    match(text: string): string;
}
/** What one key did, for the host: close the view, copy its text, or just redraw. */
export type BufferInputResult = "close" | "yank" | "handled" | "ignored";
export declare class BufferViewport {
    private readonly content;
    private readonly style;
    scrollTop: number;
    wrap: boolean;
    readonly navigation: TextNavigation;
    private height;
    private rowsCache;
    private lastRows;
    private renderedWidth;
    constructor(content: BufferContent, style: BufferStyle);
    get mode(): "NORMAL" | "SEARCH" | "COMMAND";
    get lineCount(): number;
    private get firstLineNumber();
    /** The logical-line range on screen, 1-based in the content's own numbering. */
    visibleLines(): {
        first: number;
        last: number;
    };
    get rowCount(): number;
    /** Rows the content takes at `width` (wrapping counts), before any render. */
    measure(width: number): number;
    get maxScroll(): number;
    handleInput(data: string): BufferInputResult;
    /** Mouse wheel: `delta` rows, positive down. */
    wheel(delta: number): void;
    /**
     * `height` body rows at `width` columns. Records both for the next key, so paging and the
     * position readout match what was drawn.
     */
    render(width: number, height: number): string[];
    private gutterWidth;
    private rows;
    private scrollTo;
    /** The first row of logical line `line` (0-based), clamped to the content. */
    private rowOfLine;
    private toggleWrap;
}
//# sourceMappingURL=viewport.d.ts.map