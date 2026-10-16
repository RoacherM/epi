import { piTui } from "../../tui/pi-tui.js";
import { pad, scrollbar } from "./draw.js";
import { diffTexts, displayLines } from "./diff.js";
import { Finder, LinePrompt } from "./search.js";
const { matchesKey, truncateToWidth, visibleWidth } = piTui;
const SOURCE_LABEL = {
    changes: "the agent's ledger changes",
    unstaged: "Index → Working Tree",
    staged: "HEAD → Index",
};
const STATUS_MARK = {
    new: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    binary: "B",
    unreadable: "?",
    conflict: "U",
};
export class ReviewPage {
    options;
    focused = false;
    source;
    files;
    cursor = 0;
    scroll = 0;
    collapsed = new Set();
    expanded = new Set();
    readFiles = new Set();
    diffs = new Map();
    finder = new Finder();
    prompt;
    pending;
    message = "";
    height = 0;
    bodyTop = 0;
    /** Files whose diff has been computed this session, in order; grows as the cursor moves. */
    loadedThrough = 0;
    constructor(options) {
        this.options = options;
        this.source = options.source;
        this.files = this.loadFiles(options.source);
        this.loadedThrough = Math.min(this.files.length - 1, 2);
    }
    /** A failed git read is shown as a message, never as "no changes". */
    loadFiles(source) {
        try {
            return this.options.load(source);
        }
        catch (error) {
            this.message = `could not read ${SOURCE_LABEL[source]}: ${error instanceof Error ? error.message : String(error)}`;
            return [];
        }
    }
    dispose() { }
    key(file) {
        return `${file.source}:${file.path}`;
    }
    mark(file) {
        return `${file.source}:${file.path}:${file.oldHash}:${file.newHash}`;
    }
    diffFor(file) {
        const key = this.mark(file);
        const hit = this.diffs.get(key);
        if (hit !== undefined)
            return hit;
        if (file.status === "binary" || file.status === "unreadable" || file.status === "conflict") {
            const cache = { diff: undefined, oldLines: [], newLines: [], note: file.note ?? file.status };
            this.diffs.set(key, cache);
            return cache;
        }
        const oldText = file.oldText ?? "";
        const newText = file.newText ?? "";
        const diff = diffTexts(oldText, newText);
        const oldLines = displayLines(oldText);
        const newLines = displayLines(newText);
        let note;
        if (diff === undefined)
            note = "too many changes to show as a diff; the whole file is unchanged in the viewer";
        else if (diff.rows.length === 0 && oldText !== newText)
            note = "only line endings, tabs or the final newline changed";
        else if (diff.rows.length === 0)
            note = "no textual difference in the compared versions";
        const cache = { diff, oldLines, newLines, ...(note === undefined ? {} : { note }) };
        this.diffs.set(key, cache);
        return cache;
    }
    notesByLine(file) {
        const map = new Map();
        for (const note of this.options.notes.forPath(file.source, file.path)) {
            for (let line = note.startLine; line <= note.endLine; line += 1) {
                const key = `${note.side}:${line}`;
                const list = map.get(key);
                if (list === undefined)
                    map.set(key, [note]);
                else
                    list.push(note);
            }
        }
        return map;
    }
    /** The flat display rows. A file not loaded yet shows only its header, which is what keeps a large
     * comparison from reading every blob on open. */
    rows() {
        const out = [];
        this.files.forEach((file, fileIndex) => {
            const collapsed = this.collapsed.has(this.key(file));
            out.push({ fileIndex, file, kind: "header", text: "" });
            if (collapsed)
                return;
            if (fileIndex > this.loadedThrough) {
                out.push({ fileIndex, file, kind: "note", text: "not loaded yet — move onto this file to read it" });
                return;
            }
            const cache = this.diffFor(file);
            if (cache.diff === undefined || cache.diff.rows.length === 0) {
                out.push({ fileIndex, file, kind: "note", text: cache.note ?? "no differences to show" });
                return;
            }
            const notes = this.notesByLine(file);
            cache.diff.rows.forEach((row, diffIndex) => {
                if (row.kind === "gap") {
                    const gapKey = `${this.mark(file)}:${diffIndex}`;
                    if (!this.expanded.has(gapKey)) {
                        out.push({ fileIndex, file, kind: "gap", text: "", diffIndex, gapIndex: diffIndex, gapCount: Number(row.text) });
                        return;
                    }
                    const start = row.oldStart ?? 1;
                    const startNew = row.newStart ?? start;
                    for (let offset = 0; offset < Number(row.text); offset += 1) {
                        const oldNo = start + offset;
                        const newNo = startNew + offset;
                        const text = cache.oldLines[oldNo - 1] ?? "";
                        out.push({ fileIndex, file, kind: "diff", text, diffIndex, side: "old", oldNo, newNo });
                        this.pushAnnotations(out, fileIndex, file, notes, [{ side: "old", line: oldNo }, { side: "new", line: newNo }]);
                    }
                    return;
                }
                const side = row.kind === "add" ? "new" : "old";
                const line = side === "new" ? row.newNo : row.oldNo;
                out.push({ fileIndex, file, kind: "diff", text: row.text, diffIndex, side, ...(row.oldNo === undefined ? {} : { oldNo: row.oldNo }), ...(row.newNo === undefined ? {} : { newNo: row.newNo }) });
                if (row.kind === "context" && row.oldNo !== undefined && row.newNo !== undefined) {
                    this.pushAnnotations(out, fileIndex, file, notes, [{ side: "old", line: row.oldNo }, { side: "new", line: row.newNo }]);
                }
                else if (line !== undefined && row.kind !== "context") {
                    this.pushAnnotations(out, fileIndex, file, notes, [{ side, line }]);
                }
            });
        });
        return out;
    }
    pushAnnotations(out, fileIndex, file, notes, anchors) {
        const seen = new Set();
        for (const { side, line } of anchors) {
            if (line === undefined)
                continue;
            for (const note of notes.get(`${side}:${line}`) ?? []) {
                if (seen.has(note.id))
                    continue;
                seen.add(note.id);
                out.push({ fileIndex, file, kind: "annotation", text: note.text, noteId: note.id });
            }
        }
    }
    ensureLoaded(fileIndex) {
        if (fileIndex > this.loadedThrough)
            this.loadedThrough = Math.min(this.files.length - 1, fileIndex + 2);
    }
    cursorFileIndex(rows = this.rows()) {
        const row = rows[this.cursor];
        return row?.fileIndex ?? 0;
    }
    handleInput(data) {
        this.message = "";
        if (this.prompt) {
            const done = this.prompt.handleInput(data);
            if (done === "cancel")
                this.pendingNoteTarget = undefined;
            if (done === "submit")
                this.submit(this.prompt);
            if (done !== undefined)
                this.prompt = undefined;
            this.options.tui.requestRender();
            return;
        }
        if (this.pending) {
            const direction = this.pending;
            this.pending = undefined;
            if (data === "c")
                this.jumpChange(direction === "[");
            this.options.tui.requestRender();
            return;
        }
        const rows = this.rows();
        if (matchesKey(data, "escape")) {
            if (this.finder.query !== "")
                this.finder.query = "";
            else
                this.close();
            this.options.tui.requestRender();
            return;
        }
        if (data === "q") {
            this.close();
            return;
        }
        if (data === "/") {
            this.prompt = new LinePrompt("/");
        }
        else if (data === "n" || data === "N") {
            this.findNext(data === "N", rows);
        }
        else if (data === "]" || data === "[")
            this.pending = data;
        else if (data === "." && this.files.length > 0)
            this.jumpFile(1);
        else if (data === "," && this.files.length > 0)
            this.jumpFile(-1);
        else if (matchesKey(data, "return"))
            this.activate(rows);
        else if (data === "j" || matchesKey(data, "down"))
            this.move(1, rows);
        else if (data === "k" || matchesKey(data, "up"))
            this.move(-1, rows);
        else if (data === " " || matchesKey(data, "pageDown"))
            this.move(this.page(), rows);
        else if (data === "b" || matchesKey(data, "pageUp"))
            this.move(-this.page(), rows);
        else if (matchesKey(data, "ctrl+d"))
            this.move(Math.floor(this.page() / 2), rows);
        else if (matchesKey(data, "ctrl+u"))
            this.move(-Math.floor(this.page() / 2), rows);
        else if (data === "g")
            this.cursor = 0;
        else if (data === "G") {
            this.loadedThrough = Math.max(0, this.files.length - 1);
            this.cursor = Math.max(0, this.rows().length - 1);
        }
        else if (data === "c")
            this.annotate(rows);
        else if (data === "m")
            this.toggleRead(rows);
        else if (data === "s")
            this.cycleSource();
        else if (data === "R")
            this.refresh();
        else if (data === "B")
            this.bringToDraft();
        // Rows may have changed (G, s, R, expand): clamp against a freshly built list, not the snapshot
        // taken at the top of this key.
        this.clamp(this.rows());
        this.options.tui.requestRender();
    }
    page() {
        return Math.max(1, this.height - 1);
    }
    move(delta, rows) {
        const next = Math.max(0, Math.min(rows.length - 1, this.cursor + delta));
        this.cursor = next;
        this.ensureLoaded(this.cursorFileIndex(rows));
    }
    clamp(rows) {
        this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, rows.length - 1)));
        this.ensureLoaded(this.cursorFileIndex(rows));
        const maxScroll = Math.max(0, rows.length - this.height);
        this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    }
    activate(rows) {
        const row = rows[this.cursor];
        if (row === undefined)
            return;
        if (row.kind === "header") {
            const key = this.key(row.file);
            if (this.collapsed.has(key))
                this.collapsed.delete(key);
            else
                this.collapsed.add(key);
            return;
        }
        if (row.kind === "gap" && row.diffIndex !== undefined) {
            const gapKey = `${this.mark(row.file)}:${row.diffIndex}`;
            if (this.expanded.has(gapKey))
                this.expanded.delete(gapKey);
            else {
                this.expanded.add(gapKey);
                this.cursor += 1; // land on the first revealed context line
            }
        }
    }
    jumpFile(delta) {
        const rows = this.rows();
        const current = this.cursorFileIndex(rows);
        const target = Math.max(0, Math.min(this.files.length - 1, current + delta));
        this.ensureLoaded(target);
        const next = this.rows();
        const index = next.findIndex((row) => row.kind === "header" && row.fileIndex === target);
        if (index >= 0)
            this.cursor = index;
        this.clamp(next);
    }
    jumpChange(backwards) {
        for (;;) {
            const rows = this.rows();
            for (let index = this.cursor + (backwards ? -1 : 1); index >= 0 && index < rows.length; index += backwards ? -1 : 1) {
                const row = rows[index];
                if (row?.kind === "diff" && row.diffIndex !== undefined) {
                    const diffRow = this.diffFor(row.file).diff?.rows[row.diffIndex];
                    if (diffRow !== undefined && diffRow.kind !== "context" && diffRow.kind !== "gap") {
                        this.cursor = index;
                        return;
                    }
                }
            }
            // Nothing in the loaded files: bring in the next few and continue. Expanding appends rows
            // after the cursor, so its index stays valid.
            if (this.loadedThrough >= this.files.length - 1)
                break;
            this.loadedThrough = Math.min(this.files.length - 1, this.loadedThrough + 3);
        }
        this.message = backwards ? "no change above" : "no change below";
    }
    annotate(rows) {
        const row = rows[this.cursor];
        if (row === undefined || row.kind !== "diff" || row.side === undefined) {
            this.message = "put the cursor on a changed line to annotate it";
            return;
        }
        const line = row.side === "new" ? row.newNo : row.oldNo;
        if (line === undefined)
            return;
        this.prompt = new LinePrompt("/"); // reuse the one-line input; text becomes the note
        this.prompt.text = "";
        this.pendingNoteTarget = { row, line };
    }
    pendingNoteTarget;
    submit(prompt) {
        const target = this.pendingNoteTarget;
        this.pendingNoteTarget = undefined;
        if (prompt.kind === "/" && target === undefined) {
            this.finder.query = prompt.text;
            this.findNext(false, this.rows());
            return;
        }
        if (target === undefined)
            return;
        if (prompt.text.trim() === "") {
            this.message = "empty note; not saved";
            return;
        }
        const note = this.options.notes.add({
            sessionId: this.options.sessionId,
            branchAnchor: this.options.branchAnchor,
            source: this.source,
            path: target.row.file.path,
            ...(target.row.file.oldPath === undefined ? {} : { oldPath: target.row.file.oldPath }),
            side: target.row.side,
            startLine: target.line,
            endLine: target.line,
            quote: target.row.text,
            text: prompt.text,
            file: target.row.file,
        });
        this.options.persist(note);
        this.message = `note added on ${target.row.file.path}:${target.line}`;
    }
    toggleRead(rows) {
        const file = rows[this.cursor]?.file;
        if (file === undefined)
            return;
        const key = this.mark(file);
        if (this.readFiles.has(key))
            this.readFiles.delete(key);
        else
            this.readFiles.add(key);
    }
    cycleSource() {
        const order = ["changes", "unstaged", "staged"];
        const next = order[(order.indexOf(this.source) + 1) % order.length];
        this.source = next;
        this.files = this.loadFiles(next);
        this.diffs.clear();
        this.cursor = 0;
        this.scroll = 0;
        this.loadedThrough = Math.min(this.files.length - 1, 2);
        this.options.notes.recheck(this.files);
        this.message = this.files.length === 0 ? `no changes in ${SOURCE_LABEL[next]}` : `source: ${SOURCE_LABEL[next]}`;
    }
    refresh() {
        const before = this.rows();
        const currentPath = before[this.cursor]?.file.path;
        this.files = this.loadFiles(this.source);
        this.diffs.clear();
        this.loadedThrough = Math.min(this.files.length - 1, 2);
        const outcome = this.options.notes.recheck(this.files);
        // Load the target file first, then find its header on the final row list: an absolute index
        // taken before the diffs load would shift when the earlier files expand.
        const target = currentPath === undefined ? -1 : this.files.findIndex((file) => file.path === currentPath);
        if (target >= 0)
            this.ensureLoaded(target);
        const after = this.rows();
        const index = target < 0 ? -1 : after.findIndex((row) => row.kind === "header" && row.fileIndex === target);
        this.cursor = index >= 0 ? index : 0;
        this.scroll = 0;
        this.message = outcome.stale > 0
            ? `refreshed; ${outcome.stale} note${outcome.stale === 1 ? "" : "s"} could not be relinked and are stale`
            : "refreshed";
    }
    bringToDraft() {
        const draft = this.options.notes.toDraft(this.source);
        if (draft === "") {
            this.message = "no notes to bring back yet; press c on a line";
            return;
        }
        this.options.notes.markDelivered();
        this.dispose();
        this.options.done({ draft });
    }
    findNext(backwards, rows) {
        if (this.finder.query === "")
            return;
        const texts = this.rowTexts(rows);
        const row = this.finder.next(texts, this.scroll, backwards);
        if (row === undefined)
            this.message = `not found: ${this.finder.query}`;
        else
            this.scroll = row;
    }
    close() {
        this.dispose();
        this.options.done(undefined);
    }
    // ── rendering ────────────────────────────────────────────────────────────
    rowTexts(rows) {
        return rows.map((row) => this.plainRow(row));
    }
    plainRow(row) {
        if (row.kind === "header")
            return `${row.file.path}`;
        if (row.kind === "note" || row.kind === "annotation")
            return row.text;
        if (row.kind === "gap")
            return `${row.gapCount} unchanged lines`;
        return row.text;
    }
    numberWidth;
    fileStats(file) {
        const cache = this.diffs.get(this.mark(file));
        return { added: cache?.diff?.added ?? 0, removed: cache?.diff?.removed ?? 0 };
    }
    headerRow(file, width, selected) {
        const th = this.options.theme;
        const key = this.key(file);
        const collapsed = this.collapsed.has(key);
        const stats = this.fileStats(file);
        const read = this.readFiles.has(this.mark(file));
        const notes = this.options.notes.forPath(file.source, file.path).length;
        const mark = STATUS_MARK[file.status];
        const arrow = collapsed ? "▸" : "▾";
        const name = `${arrow} ${mark}  ${file.path}${file.oldPath !== undefined ? `  (from ${file.oldPath})` : ""}`;
        const right = `${th.fg("toolDiffAdded", `+${stats.added}`)} ${th.fg("toolDiffRemoved", `-${stats.removed}`)}${read ? th.fg("success", "  ✓ read") : ""}${notes > 0 ? th.fg("warning", `  ${notes} note${notes === 1 ? "" : "s"}`) : ""} `;
        const gap = Math.max(1, width - visibleWidth(name) - visibleWidth(right));
        const body = `${name}${" ".repeat(gap)}${right}`;
        return selected ? th.style(pad(body, width), { bg: "selectedBg", bold: true }) : th.fg("accent", pad(body, width));
    }
    diffRow(row, width, selected) {
        const th = this.options.theme;
        const numWidth = this.numberWidth ?? 4;
        const oldNo = row.oldNo === undefined ? "" : String(row.oldNo);
        const newNo = row.newNo === undefined ? "" : String(row.newNo);
        const sign = row.side === "new" ? "+" : "-";
        // A context-in-gap row has both numbers; add/remove have one.
        const numbers = th.fg("dim", `${row.oldNo === undefined ? " ".repeat(numWidth) : oldNo.padStart(numWidth)} ${row.newNo === undefined ? " ".repeat(numWidth) : newNo.padStart(numWidth)}`);
        const color = row.side === "new" ? "toolDiffAdded" : "toolDiffRemoved";
        const content = `${numbers} ${th.fg(color, sign)} ${th.fg("toolDiffContext", row.text)}`;
        const body = pad(content, width);
        return selected ? th.style(pad(plainGutter(row, numWidth) + row.text, width), { bg: "selectedBg" }) : body;
    }
    gapRow(row, width, selected) {
        const th = this.options.theme;
        const expanded = row.diffIndex !== undefined && this.expanded.has(`${this.mark(row.file)}:${row.diffIndex}`);
        const text = `      ⋯ ${row.gapCount ?? 0} unchanged line${row.gapCount === 1 ? "" : "s"} · Enter ${expanded ? "collapse" : "expand"}`;
        return selected ? th.style(pad(text, width), { bg: "selectedBg" }) : th.fg("dim", pad(text, width));
    }
    noteRow(row, width) {
        const th = this.options.theme;
        return th.fg("warning", pad(`      ◇ ${row.text}`, width));
    }
    annotationRow(row, width) {
        const th = this.options.theme;
        const note = this.options.notes.all().find((candidate) => candidate.id === row.noteId);
        const stale = note?.state === "stale";
        const text = `      ${stale ? "◇ stale" : "◇ N"} ${row.text}`;
        return th.fg(stale ? "error" : "warning", pad(text, width));
    }
    render(width) {
        const th = this.options.theme;
        const height = this.options.tui.terminal.rows;
        this.height = Math.max(3, height - 2);
        const rows = this.rows();
        this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, rows.length - 1)));
        const cursorFile = this.cursorFileIndex(rows);
        this.ensureLoaded(cursorFile);
        // Keep the selected row visible.
        if (this.cursor < this.scroll)
            this.scroll = this.cursor;
        if (this.cursor >= this.scroll + this.height)
            this.scroll = this.cursor - this.height + 1;
        this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - this.height)));
        const totalAdded = this.files.reduce((sum, file) => sum + (this.diffs.get(this.mark(file))?.diff?.added ?? 0), 0);
        const totalRemoved = this.files.reduce((sum, file) => sum + (this.diffs.get(this.mark(file))?.diff?.removed ?? 0), 0);
        const notes = this.options.notes.count(this.source);
        const stale = this.options.notes.staleCount(this.source);
        const title = ` Review · ${SOURCE_LABEL[this.source]} · ${this.files.length} file${this.files.length === 1 ? "" : "s"} · +${totalAdded} −${totalRemoved}${notes > 0 ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}${stale > 0 ? th.fg("error", ` (${stale} stale)`) : ""}`;
        const out = [th.style(pad(title, width), { bg: "selectedBg", fg: "accent", bold: true })];
        this.bodyTop = 1;
        const bar = scrollbar(th, rows.length, this.height, this.scroll, this.height);
        const visible = rows.slice(this.scroll, this.scroll + this.height);
        const invert = (text) => th.inverse(text);
        for (let index = 0; index < this.height; index += 1) {
            const row = visible[index];
            if (row === undefined) {
                out.push(" ".repeat(Math.max(0, width - 1)) + bar[index]);
                continue;
            }
            const selected = this.scroll + index === this.cursor;
            let line;
            if (row.kind === "header")
                line = this.headerRow(row.file, width - 1, selected);
            else if (row.kind === "gap")
                line = this.gapRow(row, width - 1, selected);
            else if (row.kind === "note")
                line = this.noteRow(row, width - 1);
            else if (row.kind === "annotation")
                line = this.annotationRow(row, width - 1);
            else
                line = this.diffRow(row, width - 1, selected);
            out.push(pad(this.finder.highlight(line, invert), width - 1) + bar[index]);
        }
        out.push(this.statusLine(width));
        return out.slice(0, height);
    }
    statusLine(width) {
        const th = this.options.theme;
        if (this.prompt)
            return pad(` ${th.fg("accent", `note▏${this.prompt.text}`)}`, width);
        if (this.pending)
            return ` ${th.fg("accent", this.pending)}${th.fg("dim", "  c: next or previous change")}`;
        const position = this.files.length === 0 ? "0/0" : `${(this.cursorFileIndex() ?? 0) + 1}/${this.files.length}`;
        const left = this.message !== "" ? th.fg("warning", this.message) : th.fg("dim", "j/k move · ]c/[c change · . , file · enter expand/collapse · c note · m read · s source · R refresh · B to draft · Esc close");
        // Keep the position on screen even when the hints are wider than the terminal.
        const positionWidth = visibleWidth(position);
        const clipped = truncateToWidth(left, Math.max(1, width - positionWidth - 3), "…");
        const gap = Math.max(1, width - visibleWidth(clipped) - positionWidth - 2);
        return ` ${clipped}${" ".repeat(gap)}${th.fg("accent", position)} `;
    }
    handleMouse(event) {
        if (event.type === "wheel") {
            const rows = this.rows();
            this.move(event.wheelDelta ?? 0, rows);
            this.options.tui.requestRender();
            return { handled: true };
        }
        if (event.type === "click") {
            const row = this.scroll + (event.y - this.bodyTop);
            if (row >= 0 && row < this.rows().length) {
                this.cursor = row;
                this.options.tui.requestRender();
            }
            return { capture: true };
        }
        return { handled: true };
    }
    invalidate() { }
}
/** The gutter without ANSI, used to keep the selected row's alignment when its colors are replaced. */
function plainGutter(row, numWidth) {
    const oldNo = row.oldNo === undefined ? " ".repeat(numWidth) : String(row.oldNo).padStart(numWidth);
    const newNo = row.newNo === undefined ? " ".repeat(numWidth) : String(row.newNo).padStart(numWidth);
    const sign = row.side === "new" ? "+" : "-";
    return `${oldNo} ${newNo} ${sign} `;
}
//# sourceMappingURL=review-page.js.map