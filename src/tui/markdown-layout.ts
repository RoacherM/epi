// An assistant reply's markdown laid out by segment (docs/tui-transcript-layout-design.md R1, §4-F/G/H):
// body text wraps at a reading measure (76 columns of text by default) from the content column, while
// top-level code blocks and tables are data and get the full width. Pi's `Markdown` draws one width for
// everything and shows code fences as raw ```` ```lang ```` rows, so a reply is split into top-level
// segments here and each is drawn on its own: prose and tables through Pi's `Markdown`, code blocks
// directly (fence rows dropped, a dim language label, a `│` rail in the marker column).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";

import { piTui } from "./pi-tui.js";

/** The block-level token fields this file reads; marked's own types aren't an Epi dependency. */
interface BlockToken {
  type: string;
  raw: string;
  lang?: string;
  text?: string;
}

// The marked copy pi-tui parses with (pi-internals row `pi-tui-marked`: a dependency of pi-tui, not of
// Epi), so a segment boundary falls where Pi's own Markdown sees a block boundary.
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const piTuiEntry = createRequire(piEntry).resolve("@earendil-works/pi-tui");
const { Lexer } = (await import(pathToFileURL(createRequire(piTuiEntry).resolve("marked")).href)) as {
  Lexer: { lex(source: string): BlockToken[] };
};

/** Columns of body text per row (Bringhurst's 45–75 characters; WCAG 1.4.8 asks for ≤ 80). */
export const DEFAULT_MEASURE = 76;
/** The content column: body text and code start here, under a tool's call text (R3). */
export const CONTENT_COLUMN = 5;
// The code rail sits in the marker column, like a tool's `◆`.
const CODE_RAIL_COLUMN = 3;
// Languages whose label says nothing; a bare fence gets none either.
const UNLABELLED = new Set(["", "text", "txt", "plain", "plaintext"]);

type Transform = (markdown: string, availableWidth: number) => string;

interface Segment {
  kind: "prose" | "table" | "code";
  source: string;
}

/** Top-level tokens, consecutive prose merged. Only top-level code blocks and tables split: one inside a
 * list item or a quote stays with it, or the list's numbering and indentation would break. */
export function splitMarkdownSegments(source: string): Segment[] {
  const segments: Segment[] = [];
  let prose = "";
  for (const token of Lexer.lex(source)) {
    if (token.type === "code" || token.type === "table") {
      if (prose !== "") segments.push({ kind: "prose", source: prose });
      prose = "";
      segments.push({ kind: token.type, source: token.raw });
    } else {
      prose += token.raw;
    }
  }
  if (prose !== "") segments.push({ kind: "prose", source: prose });
  return segments;
}

/** The fenced code a segment holds, or undefined when it is anything else (a transformer can turn a
 * code segment into other markdown). */
function codeToken(source: string): BlockToken | undefined {
  const tokens = Lexer.lex(source).filter((token) => token.type !== "space");
  return tokens.length === 1 && tokens[0]?.type === "code" ? tokens[0] : undefined;
}

/** Pi's trimPartialClosingFences (pi-tui markdown.js), for the code block a reply is still streaming:
 * a half-typed closing fence (`` `` ``) would show as a code row and then vanish. */
function trimPartialClosingFence(token: BlockToken): string {
  const text = token.text ?? "";
  const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
  const lastLine = token.raw.split("\n").pop();
  if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]!.repeat(lastLine.length)) return text;
  return text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const ANSI = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function isBlank(line: string): boolean {
  return line.replace(ANSI, "").trim() === "";
}

/** `rows` without blank rows at either end. */
function trimBlankRows(rows: string[]): string[] {
  let start = 0;
  let end = rows.length;
  while (start < end && isBlank(rows[start]!)) start += 1;
  while (end > start && isBlank(rows[end - 1]!)) end -= 1;
  return rows.slice(start, end);
}

/** Pi's markdown theme with fences and bullets toned down: a fence row Pi still draws (a code block
 * nested in a list) is blank or just its language, and `-` bullets read `•` (R5). The returned fence
 * text is short on purpose -- Pi wraps that row like any other, so a long one would spill onto the
 * next (pi-internals row `markdown-codeblock-border`). */
function proseTheme(): MarkdownTheme {
  const base = getMarkdownTheme();
  return {
    ...base,
    codeBlockBorder: (fence: string) => {
      const lang = fence.replace(/^(`{3,}|~{3,})/, "").trim().split(/\s/)[0] ?? "";
      return UNLABELLED.has(lang) ? "" : base.codeBlockBorder(lang);
    },
    listBullet: (marker: string) => base.listBullet(marker.replace(/^[-*+] /, "• ")),
  };
}

/**
 * One text part of an assistant reply. `transform` is the reply's markdown transformers (Pi's
 * createMarkdownTransform); it runs per segment, so a transformer sees a fragment of the reply -- a
 * code block on its own, at the code's width -- rather than the whole text. `measure` is the most
 * columns of body text per row (Infinity: no limit).
 */
export class MeasuredMarkdown implements Component {
  private readonly segments: Segment[];
  private readonly markdownTheme = proseTheme();
  private readonly prose = new Map<number, InstanceType<typeof piTui.Markdown>>();
  private cache: { width: number; rows: string[] } | undefined;

  constructor(
    private readonly theme: Theme,
    text: string,
    private readonly transform: Transform,
    private readonly measure = DEFAULT_MEASURE,
  ) {
    this.segments = splitMarkdownSegments(text.replace(/\t/g, "   "));
  }

  invalidate(): void {
    this.cache = undefined;
    for (const markdown of this.prose.values()) markdown.invalidate();
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.rows;
    const rows: string[] = [];
    this.segments.forEach((segment, index) => {
      const segmentRows = trimBlankRows(this.renderSegment(segment, index, width));
      if (segmentRows.length === 0) return;
      // One blank row between segments, as between any two blocks (R4).
      if (rows.length > 0) rows.push("");
      rows.push(...segmentRows);
    });
    this.cache = { width, rows };
    return rows;
  }

  private renderSegment(segment: Segment, index: number, width: number): string[] {
    if (segment.kind === "prose") return this.markdown(index, segment.source).render(Math.min(width, this.measure + 2 * CONTENT_COLUMN));
    if (segment.kind === "table") return this.markdown(index, segment.source).render(width);
    const codeWidth = Math.max(1, width - CONTENT_COLUMN);
    const transformed = this.transform(segment.source, codeWidth);
    const token = codeToken(transformed);
    // A transformer turned the code into something else (a diagram, say): draw that as markdown.
    if (token === undefined) return this.markdown(index, transformed, false).render(width);
    const isLast = index === this.segments.length - 1;
    return this.codeRows(token, isLast ? trimPartialClosingFence(token) : (token.text ?? ""), codeWidth);
  }

  /** The segment's Pi `Markdown`, kept across renders so its own per-width cache is reused. */
  private markdown(index: number, source: string, transform = true): InstanceType<typeof piTui.Markdown> {
    let markdown = this.prose.get(index);
    if (markdown === undefined) {
      markdown = new piTui.Markdown(source, CONTENT_COLUMN, 0, this.markdownTheme, undefined, transform ? { transform: this.transform } : {});
      this.prose.set(index, markdown);
    }
    return markdown;
  }

  /** A code block without its fence rows: an optional dim language label, then the code, every row
   * behind a `│` rail in the marker column and wrapped (not cut) at the full width. */
  private codeRows(token: BlockToken, code: string, codeWidth: number): string[] {
    const lang = (token.lang ?? "").trim().split(/\s/)[0] ?? "";
    const rail = `${" ".repeat(CODE_RAIL_COLUMN)}${this.theme.fg("borderMuted", "│")}${" ".repeat(CONTENT_COLUMN - CODE_RAIL_COLUMN - 1)}`;
    const highlighted = this.markdownTheme.highlightCode?.(code, lang || undefined) ?? code.split("\n").map((line) => this.markdownTheme.codeBlock(line));
    const rows = UNLABELLED.has(lang) ? [] : [rail + piTui.truncateToWidth(this.theme.fg("mdCodeBlockBorder", lang), codeWidth)];
    for (const line of highlighted) {
      for (const piece of piTui.wrapTextWithAnsi(line, codeWidth)) rows.push(rail + piece);
    }
    return rows;
  }
}
