export type Motion = {
    kind: "step";
    rows: number;
} | {
    kind: "page";
    pages: number;
} | {
    kind: "top";
} | {
    kind: "bottom";
}
/** `NG` / `Ngg`: line N in the page's own numbering (1-based). */
 | {
    kind: "line";
    line: number;
};
export type MotionResult = 
/** A count digit or the first `g` was typed (or Esc cleared one): nothing else to do. */
{
    kind: "pending";
} | {
    kind: "motion";
    motion: Motion;
}
/** Not a motion: the page handles `data`; `count` is the count typed before it, if any. */
 | {
    kind: "key";
    count: number | undefined;
};
export interface MotionOptions {
    /** Count prefixes; off where digits mean something else (the /trace detail tabs). */
    counts?: boolean;
    /** Space pages down; off where it is taken (marking a file in /preview). */
    space?: boolean;
}
export declare class MotionKeys {
    private count;
    private pendingG;
    private readonly counts;
    private readonly space;
    constructor(options?: MotionOptions);
    /** What is typed but not finished (`12`, `g`), for a footer. */
    get pending(): string;
    reset(): void;
    handle(data: string): MotionResult;
    private motion;
}
/**
 * Where `motion` takes position `at` (a cursor or a scroll offset), clamped to `0..last`. `page` is
 * the page's step for a full page (a half page is half of it, rounded down, as before); `lineAt`
 * maps a 1-based line number to a position, for pages whose rows are not lines.
 */
export declare function applyMotion(motion: Motion, at: number, page: number, last: number, lineAt?: (line: number) => number): number;
//# sourceMappingURL=motion-keys.d.ts.map