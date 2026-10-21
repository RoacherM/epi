import type { ToolRenderers } from "./types.js";
/** A read result split into the file's own lines and Pi's "there is more" notice, as a short
 * label (`lines 1–955 of 1098 · 50.0KB limit`, `142 more lines in file`); exported for
 * test/pi-internals.test.mjs's `read-continuation-notice` check. */
export declare function splitReadNotice(output: string): {
    content: string;
    notice: string | undefined;
};
export declare const readRenderers: ToolRenderers;
export declare const grepRenderers: ToolRenderers;
export declare const findRenderers: ToolRenderers;
export declare const lsRenderers: ToolRenderers;
export declare const readOnlyRenderers: Record<string, ToolRenderers>;
//# sourceMappingURL=read-only.d.ts.map