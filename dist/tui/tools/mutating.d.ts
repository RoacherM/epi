import type { ToolRenderers } from "./types.js";
interface DiffLine {
    kind: "add" | "remove" | "context";
    lineNum: number;
    text: string;
    /** Pi's "..." skip marker sits directly above this row: unchanged lines were left out here. */
    afterSkip: boolean;
}
interface ParsedDiff {
    lines: DiffLine[];
    additions: number;
    removals: number;
    trailingSkipped: boolean;
}
/** Exported for test/pi-internals.test.mjs's `edit-diff-format` check (docs/pi-internals.md). */
export declare function parseDiffString(diffStr: string): ParsedDiff;
export declare const bashRenderers: ToolRenderers;
export declare const editRenderers: ToolRenderers;
export declare const writeRenderers: ToolRenderers;
export declare const mutatingRenderers: Record<string, ToolRenderers>;
export {};
//# sourceMappingURL=mutating.d.ts.map