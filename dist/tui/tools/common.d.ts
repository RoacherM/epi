import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "./types.js";
/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export declare class LinesComponent implements Component {
    private lines;
    constructor(lines: string[] | string);
    setLines(lines: string[] | string): void;
    invalidate(): void;
    render(width: number): string[];
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export declare function createOrUpdateLines(context: ToolRenderContext, lines: string[]): Component;
/** The text parts of a tool result joined by "\n"; images and malformed parts are skipped. */
export declare function textContent(result: AgentToolResult<unknown>): string;
export declare function isErrorResult(result: AgentToolResult<unknown>, context: ToolRenderContext | undefined): boolean;
/**
 * grok truncation rule (docs/tui-design.md 4.2): up to 5 lines in full, otherwise the first 2, an
 * ellipsis row, and the last 3. `ellipsis` styles that row; callers pick its colour (8.4 keeps the
 * model's bash block `muted` and the `!cmd` block `toolOutput`).
 */
export declare function truncateOutputLines(lines: string[], ellipsis: (text: string) => string): string[];
//# sourceMappingURL=common.d.ts.map