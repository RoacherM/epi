// A scrolling, searchable view over lines of already-styled text (docs/tui-buffer-components.md):
// line-number gutter, optional wrapping, and TextNavigation's keys (motions, `/`, `n`/`N`, `:N`).
// It draws only the body rows and reports the position; the host draws the frame around them.
import { piTui } from "../pi-tui.js";
import { TextNavigation } from "./navigation.js";
const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = piTui;
export class BufferViewport {
    content;
    style;
    scrollTop = 0;
    wrap = false;
    navigation;
    height = 1;
    rowsCache;
    lastRows = [];
    renderedWidth;
    constructor(content, style) {
        this.content = content;
        this.style = style;
        const target = {
            rows: () => this.lastRows.map((row) => row.text),
            top: () => this.scrollTop,
            setTop: (row) => {
                this.scrollTop = row;
            },
            maxTop: () => this.maxScroll,
            page: () => this.height,
            goToLine: (line) => ({ row: this.rowOfLine(line - this.firstLineNumber) }),
        };
        this.navigation = new TextNavigation(target);
    }
    get mode() {
        const prompt = this.navigation.prompt;
        if (prompt === undefined)
            return "NORMAL";
        return prompt.kind === "/" ? "SEARCH" : "COMMAND";
    }
    get lineCount() {
        return this.content.lines.length;
    }
    get firstLineNumber() {
        return this.content.firstLineNumber ?? 1;
    }
    /** The logical-line range on screen, 1-based in the content's own numbering. */
    visibleLines() {
        const top = this.lastRows[this.scrollTop];
        const bottom = this.lastRows[Math.min(this.lastRows.length, this.scrollTop + this.height) - 1];
        return {
            first: (top?.line ?? 0) + this.firstLineNumber,
            last: (bottom?.line ?? 0) + this.firstLineNumber,
        };
    }
    get rowCount() {
        return this.lastRows.length;
    }
    /** Rows the content takes at `width` (wrapping counts), before any render. */
    measure(width) {
        return this.rows(width).length;
    }
    get maxScroll() {
        return Math.max(0, this.lastRows.length - this.height);
    }
    handleInput(data) {
        const result = this.navigation.handle(data);
        if (result.kind === "taken")
            return "handled";
        if (data === "w") {
            this.toggleWrap();
            return "handled";
        }
        if (data === "y")
            return "yank";
        if (data === "q" || piTui.matchesKey(data, "escape"))
            return "close";
        return "ignored";
    }
    /** The logical line (0-based) drawn on body row `row` of the last render, if any. */
    lineAtRow(row) {
        if (row < 0 || row >= this.height)
            return undefined;
        return this.lastRows[this.scrollTop + row]?.line;
    }
    /** Replaces the lines (a live view). Rows and the scroll position are brought up to date at once,
     * so a click before the next render still finds the line under it. */
    setLines(lines) {
        this.content = { ...this.content, lines };
        this.rowsCache = undefined;
        if (this.renderedWidth !== undefined)
            this.lastRows = this.rows(this.renderedWidth);
        this.scrollTo(this.scrollTop);
    }
    /** Mouse wheel: `delta` rows, positive down. */
    wheel(delta) {
        this.navigation.scrollTo(this.scrollTop + delta);
    }
    /**
     * `height` body rows at `width` columns. Records both for the next key, so paging and the
     * position readout match what was drawn.
     */
    render(width, height) {
        this.height = Math.max(1, height);
        this.renderedWidth = width;
        const rows = this.rows(width);
        this.lastRows = rows;
        this.scrollTo(this.scrollTop);
        const gutterWidth = this.gutterWidth();
        const textWidth = Math.max(1, width - (gutterWidth === 0 ? 0 : gutterWidth + 3));
        const shown = rows.slice(this.scrollTop, this.scrollTop + this.height).map((row) => {
            const text = truncateToWidth(this.navigation.highlight(row.text, this.style.match), textWidth, "…");
            if (gutterWidth === 0)
                return text;
            const number = row.continuation ? " ".repeat(gutterWidth) : String(row.line + this.firstLineNumber).padStart(gutterWidth);
            return `${this.style.gutter(number)} ${this.style.separator(row.continuation ? "┆" : "│")} ${text}`;
        });
        while (shown.length < this.height)
            shown.push("");
        return shown;
    }
    gutterWidth() {
        if (this.content.firstLineNumber === undefined)
            return 0;
        return Math.max(3, String(this.firstLineNumber + this.content.lines.length - 1).length);
    }
    rows(width) {
        const cached = this.rowsCache;
        if (cached?.width === width && cached.wrap === this.wrap)
            return cached.rows;
        const gutterWidth = this.gutterWidth();
        const textWidth = Math.max(1, width - (gutterWidth === 0 ? 0 : gutterWidth + 3));
        const rows = [];
        this.content.lines.forEach((text, line) => {
            if (!this.wrap || visibleWidth(text) <= textWidth) {
                rows.push({ text, line, continuation: false });
                return;
            }
            wrapTextWithAnsi(text, textWidth).forEach((part, index) => rows.push({ text: part, line, continuation: index > 0 }));
        });
        this.rowsCache = { width, wrap: this.wrap, rows };
        return rows;
    }
    /** Scrolls to `row`, clamped to the content as last laid out. */
    scrollTo(row) {
        this.scrollTop = Math.max(0, Math.min(this.maxScroll, Math.round(row)));
    }
    /** The first row of logical line `line` (0-based), clamped to the content. */
    rowOfLine(line) {
        const clamped = Math.max(0, Math.min(this.content.lines.length - 1, line));
        const row = this.lastRows.findIndex((candidate) => candidate.line === clamped);
        return row < 0 ? clamped : row;
    }
    toggleWrap() {
        const topLine = this.lastRows[this.scrollTop]?.line ?? 0;
        this.wrap = !this.wrap;
        this.navigation.status = { text: `wrap ${this.wrap ? "on" : "off"}`, tone: "info" };
        // Rebuild the rows now (not at the next render) so the same logical line stays at the top.
        if (this.renderedWidth !== undefined)
            this.lastRows = this.rows(this.renderedWidth);
        this.navigation.scrollTo(this.rowOfLine(topLine));
    }
}
//# sourceMappingURL=viewport.js.map