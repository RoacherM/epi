export interface DiffRow {
    kind: "add" | "remove" | "context" | "gap";
    oldNo?: number;
    newNo?: number;
    /** For "gap": how many unchanged lines are not shown. */
    text: string;
    /** Character ranges of `text` that changed within the line. */
    emphasis?: Array<[number, number]>;
}
export interface FileDiff {
    rows: DiffRow[];
    added: number;
    removed: number;
    /** Row index of the first changed row of each hunk. */
    changeStarts: number[];
}
/** Text as it is drawn: one form for both sides, so the diff matches what the viewer shows. */
export declare function displayLines(text: string): string[];
/** The diff from `before` to `after`, or undefined when there are too many changes to compute. */
export declare function diffTexts(before: string, after: string): FileDiff | undefined;
//# sourceMappingURL=diff.d.ts.map