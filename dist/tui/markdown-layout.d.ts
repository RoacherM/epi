import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
/** Columns of body text per row (Bringhurst's 45–75 characters; WCAG 1.4.8 asks for ≤ 80). */
export declare const DEFAULT_MEASURE = 76;
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
    /** The segment's Pi `Markdown`, kept across renders so its own per-width cache is reused. */
    private markdown;
    /** A code block without its fence rows: an optional dim language label, then the code, every row
     * behind a `│` rail in the marker column and wrapped (not cut) at the full width. */
    private codeRows;
}
export {};
//# sourceMappingURL=markdown-layout.d.ts.map