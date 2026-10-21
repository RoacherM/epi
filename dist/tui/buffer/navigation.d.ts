import { LinePrompt } from "./search.js";
/** What navigation reads from and moves in the view it serves. Navigation does all clamping. */
export interface NavigationTarget {
    /** The rows as searched (styled text; colors are ignored), one per screen row. */
    rows(): readonly string[];
    /** The first row on screen. */
    top(): number;
    /** Move the first row on screen; always a value in `0..maxTop()`. */
    setTop(row: number): void;
    /** The last valid top: rows minus the body height, at least 0. */
    maxTop(): number;
    /** Rows a full page moves; a half page is half of it, rounded down. */
    page(): number;
    /** `:N` and `NG`: the row where line N (the view's own numbering) starts, an error to show, or
     * undefined for nothing to do. Without it, line N is row N - 1. */
    goToLine?(line: number): {
        row: number;
    } | {
        error: string;
    } | undefined;
}
/** One line for the footer: an error (not found, not a line number) or a note (a match count). */
export interface NavigationStatus {
    text: string;
    tone: "error" | "info";
}
export type NavigationResult = 
/** Navigation used the key (or it only extended a count or `g`): redraw. */
{
    kind: "taken";
}
/** Not a navigation key: the view handles it, with the count typed before it, if any. */
 | {
    kind: "key";
    count: number | undefined;
};
export declare class TextNavigation {
    private readonly target;
    /** The open `/` or `:` prompt; every key goes to it until Enter or Esc. */
    prompt: LinePrompt | undefined;
    /** Shown until the next key; the view may set its own (wrap on, copied, no change below). */
    status: NavigationStatus | undefined;
    private readonly finder;
    private readonly motions;
    /** The row `n`/`N` last landed on, with its text. Near the end, revealing a match can leave it
     * below the top, and searching on from the top would find it again forever, so `n` continues from
     * it -- while that row is on screen and still reads the same (rewrapping, a raw/Markdown switch
     * or a reloaded file changes it). Every move (keys, `:N`, the view's own `scrollTo`) forgets it. */
    private current;
    constructor(target: NavigationTarget);
    /** A count or `g` typed but not finished (`12`, `g`), for the footer. */
    get pending(): string;
    get query(): string;
    /** The view moved itself (mouse wheel, scrollbar drag, a diff's `]c`): clamps `row` and puts it
     * on top. Views move only through this or `handle()`, so the clamping stays in one place. */
    scrollTo(row: number): void;
    /** A row with the current query's matches shown by `invert`. */
    highlight(row: string, invert: (text: string) => string): string;
    handle(data: string): NavigationResult;
    /** The top as it shows: before a render it may still be past the end (a restored position). */
    private top;
    private reveal;
    /** Where `n`/`N` search from: the row they last landed on while it is on screen and unchanged,
     * else the top. On screen: from the top through the body height (rows − maxTop), or every row
     * when everything fits. */
    private searchFrom;
    private goToLine;
    private submit;
    /** The next match after row `from` (before it, backwards), wrapping around. */
    private findNext;
}
//# sourceMappingURL=navigation.d.ts.map