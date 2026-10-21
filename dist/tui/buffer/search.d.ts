export type PromptKind = "/" | ":";
/** Text that is safe to draw: the terminal must never interpret what a file is called or contains,
 * or what was typed into a prompt. ESC becomes a visible mark; other C0 and C1 controls (a lone
 * U+009B is CSI to some terminals), line breaks and bidi overrides are removed. Tabs are left to
 * the caller. */
export declare function printable(text: string): string;
/** The one-line input at the bottom while typing a search or a line number. */
export declare class LinePrompt {
    readonly kind: PromptKind;
    text: string;
    constructor(kind: PromptKind);
    /** "submit" or "cancel" ends the prompt; undefined keeps it open. */
    handleInput(data: string): "submit" | "cancel" | undefined;
}
export declare class Finder {
    query: string;
    /** Row indices that contain the query, in order. */
    matches(rows: readonly string[]): number[];
    /** The next match after `from` (or before it, backwards), wrapping around; undefined if none. */
    next(rows: readonly string[], from: number, backwards: boolean): number | undefined;
    /** A row with the matches shown inverted. The row loses its own colors when it matches. */
    highlight(row: string, invert: (text: string) => string): string;
}
//# sourceMappingURL=search.d.ts.map