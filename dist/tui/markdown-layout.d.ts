import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
/** The content column: body text and code start here, under a tool's call text (R3). */
export declare const CONTENT_COLUMN = 5;
type Transform = (markdown: string, availableWidth: number) => string;
interface Segment {
    kind: "prose" | "table" | "code";
    source: string;
}
/** Top-level tokens, consecutive prose merged. Only top-level code blocks and tables split: one inside a
 * list item or a quote stays with it, or the list's numbering and indentation would break. */
export declare function splitMarkdownSegments(source: string): Segment[];
/**
 * One text part of an assistant reply. `transform` is the reply's markdown transformers (Pi's
 * createMarkdownTransform); it runs per segment, so a transformer sees a fragment of the reply -- a
 * code block on its own, at the code's width -- rather than the whole text. `measure` is the most
 * columns of body text per row (Infinity: no limit).
 */
export declare class MeasuredMarkdown implements Component {
    private readonly theme;
    private readonly transform;
    private readonly measure;
    private readonly segments;
    private readonly markdownTheme;
    private readonly prose;
    private cache;
    constructor(theme: Theme, text: string, transform: Transform, measure?: number);
    invalidate(): void;
    render(width: number): string[];
    private renderSegment;
    /** A mermaid block as box art behind the code rail, under a dim `mermaid` label; its source, with
     * the label saying why, when it can't be drawn or doesn't fit (docs/mermaid-design.md §4.3). */
    private mermaidRows;
    private rail;
    /** The segment's Pi `Markdown`, kept across renders so its own per-width cache is reused. A code
     * segment a transformer rewrote passes its new text each render (it may differ per width). */
    private markdown;
    /** A code block without its fence rows: an optional dim language label, then the code, every row
     * behind a `│` rail in the marker column and wrapped (not cut) at the full width. */
    private codeRows;
}
export {};
//# sourceMappingURL=markdown-layout.d.ts.map