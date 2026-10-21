import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { InspectTarget } from "../buffer/inspector.js";
import type { ToolRenderContext } from "./types.js";
/** Rows of a rendered block that open the inspector (the `… N more lines` row), and what they open. */
export interface Inspectable {
    rows: readonly number[];
    target: InspectTarget;
}
/**
 * Lines cut to the viewport width. Entries may hold several rows separated by "\n". A single string
 * is split the same way, except that "" gives no rows at all (an empty array entry gives one).
 */
export declare class LinesComponent implements Component {
    private lines;
    private inspectable;
    constructor(lines: string[] | string, inspectable?: Inspectable);
    /** `inspectable` row indices count the rows as split here, one per "\n"-separated part. */
    setLines(lines: string[] | string, inspectable?: Inspectable): void;
    /** The inspector target behind rendered row `row`, if that row opens one. */
    inspectTargetAt(row: number): InspectTarget | undefined;
    invalidate(): void;
    render(width: number): string[];
}
/** Reuses the renderer's previous LinesComponent (Pi hands it back as `lastComponent`) when there is one. */
export declare function createOrUpdateLines(context: ToolRenderContext, lines: string[], inspectable?: Inspectable): Component;
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