// The changes side of the page (docs/preview-design.md §3.1-§3.2): the list of files the agent
// changed and the diff of one of them against what it was before.
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { piTui } from "../../tui/pi-tui.js";
import { centered, pad, scrollbar } from "./draw.js";
import { diffTexts, displayLines } from "./diff.js";
import { MAX_TEXT_BYTES, printable } from "./files.js";
import { Finder, LinePrompt } from "./search.js";
import { lastScroll } from "./view.js";
const { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } = piTui;
const HIGHLIGHT_LIMIT = 256 * 1024;
function readCurrent(path) {
    try {
        if (statSync(path).size > MAX_TEXT_BYTES)
            return { kind: "too-large" };
        return { kind: "text", text: readFileSync(path, "utf8") };
    }
    catch {
        return { kind: "gone" };
    }
}
/** A version stamp of the file on disk, so a diff is computed again only after it changed. */
function stamp(path) {
    try {
        const stats = statSync(path);
        return `${stats.mtimeMs}|${stats.size}`;
    }
    catch {
        return "gone";
    }
}
/** The diff of one change, or why there is none to show. */
function compare(path, before) {
    if (before.kind === "not-kept")
        return { kind: "note", text: `No copy from before the change: the file was ${before.reason}.` };
    const now = readCurrent(path);
    if (now.kind === "too-large")
        return { kind: "note", text: "The file is larger than 4 MB now." };
    const beforeText = before.kind === "text" ? before.text : "";
    const afterText = now.kind === "text" ? now.text : "";
    const diff = diffTexts(beforeText, afterText);
    if (diff === undefined)
        return { kind: "note", text: "Too many changes to show as a diff." };
    const status = before.kind === "absent" ? "new" : now.kind === "gone" ? "deleted" : "modified";
    return { kind: "diff", diff, status, after: afterText };
}
/** Diffs by path, scope and file version: rendering asks for every listed file on every frame. */
const comparisons = new Map();
function comparisonFor(path, before, scope) {
    const key = `${scope}|${stamp(path)}|${before.kind === "text" ? before.text.length : before.kind}`;
    const hit = comparisons.get(`${scope}|${path}`);
    if (hit && hit.key === key && hit.comparison)
        return hit.comparison;
    const comparison = compare(path, before);
    comparisons.set(`${scope}|${path}`, { key, comparison });
    if (comparisons.size > 128)
        comparisons.delete(comparisons.keys().next().value);
    return comparison;
}
function displayPath(cwd, path) {
    const rel = relative(cwd, path);
    return printable(rel && !rel.startsWith("..") ? rel : path);
}
const SCOPE_LABEL = { session: "this session", turn: "last turn" };
export class ChangesList {
    ledger;
    theme;
    cwd;
    scope = "session";
    cursor = 0;
    scroll = 0;
    constructor(ledger, theme, cwd) {
        this.ledger = ledger;
        this.theme = theme;
        this.cwd = cwd;
    }
    selected() {
        return this.ledger.changes(this.scope)[this.cursor]?.path;
    }
    handleInput(data) {
        const count = this.ledger.changes(this.scope).length;
        if (matchesKey(data, "escape") || data === "q")
            return { kind: "back" };
        if (data === "j" || matchesKey(data, "down"))
            this.cursor = Math.min(count - 1, this.cursor + 1);
        else if (data === "k" || matchesKey(data, "up"))
            this.cursor = Math.max(0, this.cursor - 1);
        else if (data === "g")
            this.cursor = 0;
        else if (data === "G")
            this.cursor = Math.max(0, count - 1);
        else if (data === "t") {
            this.scope = this.scope === "session" ? "turn" : "session";
            this.cursor = 0;
        }
        else if (data === "i") {
            const path = this.selected();
            if (path)
                return { kind: "insert", paths: [path] };
        }
        else if (matchesKey(data, "return") || data === "l" || matchesKey(data, "right")) {
            const path = this.selected();
            if (path)
                return { kind: "open", view: new DiffView(this.ledger, this.theme, path, this.scope, this.cwd) };
        }
        return undefined;
    }
    render(width, height) {
        const th = this.theme;
        const changes = this.ledger.changes(this.scope);
        this.cursor = Math.max(0, Math.min(this.cursor, changes.length - 1));
        const title = `${th.fg("accent", "changes")} ${th.fg("dim", `· ${SCOPE_LABEL[this.scope]} · ${changes.length} file${changes.length === 1 ? "" : "s"}`)}`;
        const hints = "j/k move · enter diff · t session/turn · i insert · tab files · q close";
        if (changes.length === 0) {
            const text = `The agent has not changed a file in ${SCOPE_LABEL[this.scope]}.`;
            return { title, body: centered(th.fg("dim", text), width, height), status: ` ${th.fg("dim", hints)}` };
        }
        if (this.cursor < this.scroll)
            this.scroll = this.cursor;
        if (this.cursor >= this.scroll + height)
            this.scroll = this.cursor - height + 1;
        const rows = changes.slice(this.scroll, this.scroll + height).map((change, offset) => {
            const comparison = comparisonFor(change.path, change.before, this.scope);
            const mark = comparison.kind === "note" ? "?" : comparison.status === "new" ? "A" : comparison.status === "deleted" ? "D" : "M";
            const stats = comparison.kind === "note" ? "" : `+${comparison.diff.added} -${comparison.diff.removed}`;
            const name = displayPath(this.cwd, change.path);
            // The numbers end one column before the edge on every row, selected or not.
            const left = pad(` ${mark}  ${name}`, Math.max(1, width - visibleWidth(stats) - 1));
            if (this.scroll + offset === this.cursor)
                return th.style(`${left}${stats} `, { bg: "selectedBg", bold: true });
            const color = mark === "A" ? "toolDiffAdded" : mark === "D" ? "toolDiffRemoved" : "text";
            return `${th.fg(color, left)}${th.fg("dim", stats)} `;
        });
        while (rows.length < height)
            rows.push(" ".repeat(width));
        return { title, body: rows, status: ` ${th.fg("dim", hints)}  ${th.fg("accent", `${this.cursor + 1}/${changes.length}`)}` };
    }
}
export class DiffView {
    ledger;
    theme;
    path;
    scope;
    cwd;
    scroll;
    wrap = true;
    finder = new Finder();
    prompt;
    /** "]" or "[" typed, waiting for the "c" of ]c / [c. */
    pending;
    message = "";
    cache;
    height = 0;
    constructor(ledger, theme, path, scope, cwd) {
        this.ledger = ledger;
        this.theme = theme;
        this.path = path;
        this.scope = scope;
        this.cwd = cwd;
        this.scroll = lastScroll.get(`diff:${path}`) ?? 0;
    }
    get busy() {
        return this.prompt !== undefined;
    }
    dispose() {
        lastScroll.set(`diff:${this.path}`, this.scroll);
    }
    /** What the file was before, in this view's scope; the session's when the turn no longer has it. */
    before() {
        return (this.ledger.changes(this.scope).find((change) => change.path === this.path)
            ?? this.ledger.changes("session").find((change) => change.path === this.path))?.before;
    }
    handleInput(data) {
        if (this.prompt) {
            const done = this.prompt.handleInput(data);
            if (done === "submit")
                this.submit(this.prompt);
            if (done !== undefined)
                this.prompt = undefined;
            return undefined;
        }
        this.message = "";
        if (this.pending) {
            const direction = this.pending;
            this.pending = undefined;
            if (data === "c")
                this.jumpToChange(direction === "[");
            return undefined;
        }
        const page = Math.max(1, this.height - 1);
        if (matchesKey(data, "escape") || data === "q" || data === "h" || matchesKey(data, "left"))
            return { kind: "back" };
        if (data === "]" || data === "[")
            this.pending = data;
        else if (data === "/" || data === ":")
            this.prompt = new LinePrompt(data);
        else if (data === "n" || data === "N")
            this.findNext(data === "N", this.scroll);
        else if (data === "d")
            return { kind: "file", path: this.path };
        else if (data === "i")
            return { kind: "insert", paths: [this.path] };
        else if (data === "w")
            this.wrap = !this.wrap;
        else if (data === "j" || matchesKey(data, "down"))
            this.scroll += 1;
        else if (data === "k" || matchesKey(data, "up"))
            this.scroll -= 1;
        else if (data === " " || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f"))
            this.scroll += page;
        else if (data === "b" || matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b"))
            this.scroll -= page;
        else if (matchesKey(data, "ctrl+d"))
            this.scroll += Math.floor(page / 2);
        else if (matchesKey(data, "ctrl+u"))
            this.scroll -= Math.floor(page / 2);
        else if (data === "g")
            this.scroll = 0;
        else if (data === "G")
            this.scroll = Number.MAX_SAFE_INTEGER;
        return undefined;
    }
    submit(prompt) {
        if (prompt.kind === "/") {
            this.finder.query = prompt.text;
            this.findNext(false, this.scroll - 1);
            return;
        }
        const line = Number.parseInt(prompt.text, 10);
        const cache = this.cache;
        if (!Number.isFinite(line) || line < 1) {
            this.message = `not a line number: ${printable(prompt.text)}`;
            return;
        }
        if (!cache || cache.comparison.kind !== "diff")
            return;
        // The first shown row at or after that line of the file as it is now.
        const rows = cache.comparison.diff.rows;
        const index = rows.findIndex((row) => row.newNo !== undefined && row.newNo >= line);
        if (index < 0)
            this.message = `line ${line} is not in a shown part of the diff`;
        else
            this.scroll = cache.firstRow[index];
    }
    findNext(backwards, from) {
        if (this.finder.query === "")
            return;
        const row = this.finder.next(this.cache?.contents ?? [], from, backwards);
        if (row === undefined)
            this.message = `not found: ${printable(this.finder.query)}`;
        else
            this.scroll = row;
    }
    jumpToChange(backwards) {
        const cache = this.cache;
        if (!cache || cache.comparison.kind !== "diff")
            return;
        const starts = cache.comparison.diff.changeStarts.map((index) => cache.firstRow[index]);
        const target = backwards
            ? [...starts].reverse().find((row) => row < this.scroll)
            : starts.find((row) => row > this.scroll);
        if (target === undefined)
            this.message = backwards ? "no change above" : "no change below";
        else
            this.scroll = target;
    }
    styleRow(row, highlighted) {
        const th = this.theme;
        if (row.kind === "context")
            return highlighted?.[row.newNo - 1] ?? th.fg("toolDiffContext", row.text);
        const color = row.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
        if (!row.emphasis || row.emphasis.length === 0)
            return th.fg(color, row.text);
        let out = "";
        let at = 0;
        for (const [start, end] of row.emphasis) {
            out += th.fg(color, row.text.slice(at, start)) + th.inverse(th.fg(color, row.text.slice(start, end)));
            at = end;
        }
        return out + th.fg(color, row.text.slice(at));
    }
    layout(width) {
        const before = this.before();
        const comparison = before === undefined
            ? { kind: "note", text: "This file is no longer in the list of changes." }
            : comparisonFor(this.path, before, this.scope);
        const key = `${width}|${this.wrap}`;
        if (this.cache && this.cache.key === key && this.cache.comparison === comparison)
            return this.cache;
        const th = this.theme;
        const out = { key, gutters: [], contents: [], rowOf: [], firstRow: [], comparison };
        if (comparison.kind === "note") {
            this.cache = out;
            return out;
        }
        const { diff, after } = comparison;
        const lang = after.length <= HIGHLIGHT_LIMIT ? getLanguageFromPath(this.path) : undefined;
        let highlighted;
        if (lang) {
            try {
                const lines = displayLines(after);
                const colored = highlightCode(lines.join("\n"), lang);
                if (colored.length === lines.length)
                    highlighted = colored;
            }
            catch {
                // an unknown grammar: plain context lines
            }
        }
        const numberWidth = String(Math.max(1, ...diff.rows.map((row) => Math.max(row.oldNo ?? 0, row.newNo ?? 0)))).length;
        const contentWidth = Math.max(1, width - 2 * numberWidth - 4);
        diff.rows.forEach((row, index) => {
            out.firstRow.push(out.contents.length);
            if (row.kind === "gap") {
                out.gutters.push(" ".repeat(2 * numberWidth + 3));
                out.contents.push(th.fg("dim", `⋯ ${row.text} unchanged line${row.text === "1" ? "" : "s"}`));
                out.rowOf.push(index);
                return;
            }
            const sign = row.kind === "add" ? th.fg("toolDiffAdded", "+") : row.kind === "remove" ? th.fg("toolDiffRemoved", "-") : " ";
            const numbers = th.fg("dim", `${String(row.oldNo ?? "").padStart(numberWidth)} ${String(row.newNo ?? "").padStart(numberWidth)}`);
            const styled = this.styleRow(row, highlighted);
            const segments = row.text === "" ? [""] : this.wrap ? wrapTextWithAnsi(styled, contentWidth) : [truncateToWidth(styled, contentWidth, "…")];
            segments.forEach((segment, part) => {
                out.gutters.push(part === 0 ? `${numbers} ${sign} ` : " ".repeat(2 * numberWidth + 3));
                out.contents.push(segment);
                out.rowOf.push(index);
            });
        });
        this.cache = out;
        return out;
    }
    render(width, height) {
        this.height = height;
        const th = this.theme;
        const cache = this.layout(width - 1);
        const name = th.fg("accent", displayPath(this.cwd, this.path));
        const hints = "j/k scroll · ]c [c changes · / search · : line · d file · w wrap · i insert · q back";
        if (cache.comparison.kind === "note") {
            return {
                title: name,
                body: centered(th.fg("warning", cache.comparison.text), width, height),
                status: this.statusLine("d file · q back", ""),
            };
        }
        const { diff, status } = cache.comparison;
        const total = cache.contents.length;
        this.scroll = Math.max(0, Math.min(Math.max(0, total - height), this.scroll));
        const bar = scrollbar(th, total, height, this.scroll, height);
        const invert = (text) => th.inverse(text);
        const body = Array.from({ length: height }, (_, at) => {
            const row = this.scroll + at;
            if (row >= total)
                return " ".repeat(width);
            return pad((cache.gutters[row] ?? "") + this.finder.highlight(cache.contents[row] ?? "", invert), width - 1) + bar[at];
        });
        const label = status === "new" ? "new file" : status === "deleted" ? "deleted" : SCOPE_LABEL[this.scope];
        return {
            title: `${name} ${th.fg("dim", `${label} · `)}${th.fg("toolDiffAdded", `+${diff.added}`)} ${th.fg("toolDiffRemoved", `-${diff.removed}`)}`,
            body,
            status: this.statusLine(hints, `${Math.min(total, this.scroll + 1)}-${Math.min(total, this.scroll + height)}/${total}`),
        };
    }
    statusLine(hints, position) {
        const th = this.theme;
        if (this.prompt)
            return ` ${th.fg("accent", `${this.prompt.kind}${printable(this.prompt.text)}▏`)}`;
        if (this.pending)
            return ` ${th.fg("accent", `${this.pending}`)}${th.fg("dim", "  c: next or previous change")}`;
        const left = this.message ? th.fg("warning", this.message) : th.fg("dim", hints);
        return ` ${left}  ${th.fg("accent", position)}`;
    }
}
//# sourceMappingURL=changes.js.map