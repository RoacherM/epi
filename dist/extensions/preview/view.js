// The preview overlay: a three-pane file browser (parent | current | preview) and a full viewer
// for one file. Loaded only when /preview is run in the interactive TUI.
import { homedir } from "node:os";
import { basename, dirname, extname, relative } from "node:path";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { piTui } from "../../tui/pi-tui.js";
import { centered, imageBody, pad, scrollbar, scrollFromBar } from "./draw.js";
import { existsSync, statSync } from "node:fs";
import { clock, HEX_BYTES, humanSize, icon, kindOf, loadDoc, localTime, MAX_TEXT_BYTES, permString, printable, readListing, restat } from "./files.js";
import { probe, StillCache, stillJob } from "./media.js";
import { PlayerPane } from "./player-pane.js";
import { Finder, LinePrompt } from "./search.js";
const { Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } = piTui;
/** Rows the page itself takes around a view's body: the top border, the title row, the key row,
 * the bottom border, and the agent status line under it (page.ts). */
export const PAGE_CHROME_ROWS = 5;
/** Where each file's view was scrolled to, kept for this MMP process (docs/preview-design.md §3.3). */
export const lastScroll = new Map();
export class Viewer {
    tui;
    theme;
    entry;
    stills;
    mode;
    scroll = 0;
    wrap = true;
    markdown = true;
    /** `gutters` (line numbers) and `contents` make up `rows`; search looks at the contents only. */
    rowsCache;
    finder = new Finder();
    prompt;
    message = "";
    info;
    /** The probe has answered (or failed): a video waits for it, to play at the source's frame rate. */
    probed = false;
    pane;
    /** Size of the last rendered body, for the mouse. */
    width = 0;
    height = 0;
    constructor(tui, theme, entry, stills) {
        this.tui = tui;
        this.theme = theme;
        this.entry = entry;
        this.stills = stills;
        // Anything but a regular file is shown as the one-line note loadDoc gives for it.
        const kind = entry.isFile ? kindOf(entry.name) : "text";
        const gif = entry.isFile && extname(entry.name).toLowerCase() === ".gif";
        this.mode = kind === "video" || gif ? "video" : kind === "text" ? "text" : "image";
        this.scroll = lastScroll.get(`view:${entry.path}`) ?? 0;
        if (this.mode !== "text" && kind !== "quicklook") {
            void probe(entry.path)
                .then((info) => {
                this.info = info;
            })
                .catch(() => { })
                .finally(() => {
                this.probed = true;
                this.tui.requestRender();
            });
        }
    }
    dispose() {
        lastScroll.set(`view:${this.entry.path}`, this.scroll);
        this.pane?.dispose();
        this.pane = undefined;
    }
    /** Typing a search or a line number: every key goes to the prompt, not to the view. */
    get busy() {
        return this.prompt !== undefined;
    }
    /** `/` and `:` in the text view (docs/preview-design.md §3.3). True when the key was taken. */
    handleSearchKeys(data) {
        if (this.prompt) {
            const done = this.prompt.handleInput(data);
            if (done === "submit")
                this.submitPrompt(this.prompt);
            if (done !== undefined)
                this.prompt = undefined;
            return true;
        }
        if (data === "/" || data === ":") {
            this.prompt = new LinePrompt(data);
            this.message = "";
            return true;
        }
        if (data === "n" || data === "N") {
            this.findNext(data === "N");
            return true;
        }
        return false;
    }
    submitPrompt(prompt) {
        if (prompt.kind === "/") {
            this.finder.query = prompt.text;
            this.findNext(false, this.scroll - 1);
            return;
        }
        const line = Number.parseInt(prompt.text, 10);
        const starts = this.rowsCache?.lineStarts;
        if (!Number.isFinite(line) || line < 1)
            this.message = `not a line number: ${printable(prompt.text)}`;
        else if (!starts)
            this.message = "line numbers are in the raw view: press r first";
        else
            this.scroll = starts[Math.min(line, starts.length) - 1] ?? 0;
    }
    findNext(backwards, from = this.scroll) {
        if (this.finder.query === "")
            return;
        const row = this.finder.next(this.rowsCache?.contents ?? [], from, backwards);
        if (row === undefined)
            this.message = `not found: ${printable(this.finder.query)}`;
        else
            this.scroll = row;
    }
    /** Returns "back" or "insert" when the browser should act. */
    handleInput(data) {
        if (this.mode === "text" && this.handleSearchKeys(data))
            return undefined;
        this.message = "";
        if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "backspace"))
            return "back";
        if (data === "i")
            return "insert";
        if (this.mode === "video") {
            this.pane?.handleInput(data);
            return undefined;
        }
        if (this.mode === "image") {
            if (data === "h" || matchesKey(data, "left"))
                return "back";
            return undefined;
        }
        const page = Math.max(1, this.height - 1);
        if (data === "j" || matchesKey(data, "down"))
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
        else if (data === "w")
            this.wrap = !this.wrap;
        else if (data === "r")
            this.markdown = !this.markdown;
        else if (data === "h" || matchesKey(data, "left"))
            return "back";
        return undefined;
    }
    /** `x`/`y` are relative to the body; `y === height` is the status row. */
    handleMouse(event, x, y) {
        if (this.mode === "video") {
            this.pane?.handleMouse(event, x, y);
            return;
        }
        if (this.mode !== "text")
            return;
        if (event.type === "wheel") {
            this.scroll += event.wheelDelta ?? 0;
        }
        else if ((event.type === "press" || event.type === "drag") && x >= this.width - 1 && y < this.height) {
            const total = this.rowsCache?.rows.length ?? 0;
            this.scroll = scrollFromBar(y, this.height, total, this.height);
        }
    }
    textRows(width) {
        const doc = loadDoc(this.entry);
        const rendered = doc.markdown !== undefined && this.markdown;
        const key = `${width}|${this.wrap}|${rendered}|${this.entry.mtime.getTime()}|${this.entry.size}`;
        if (this.rowsCache?.key === key)
            return this.rowsCache.rows;
        let lineStarts;
        let gutters;
        let rows;
        if (rendered) {
            try {
                rows = new Markdown(doc.markdown, 1, 0, getMarkdownTheme()).render(width);
            }
            catch {
                rows = undefined;
            }
        }
        if (!rows && doc.kind === "hex") {
            rows = doc.lines.map((line) => this.theme.fg("dim", line.slice(0, 8)) + this.theme.fg("toolOutput", truncateToWidth(line.slice(8), Math.max(1, width - 8))));
        }
        if (!rows) {
            rows = [];
            lineStarts = [];
            gutters = [];
            const gutter = String(doc.lines.length).length;
            const contentWidth = Math.max(1, width - gutter - 1);
            for (const [index, line] of doc.lines.entries()) {
                const colored = doc.highlighted?.[index] ?? this.theme.fg("toolOutput", line);
                const segments = line === "" ? [""] : this.wrap ? wrapTextWithAnsi(colored, contentWidth) : [truncateToWidth(colored, contentWidth, "…")];
                lineStarts.push(rows.length);
                for (const [part, segment] of segments.entries()) {
                    const number = part === 0 ? String(index + 1).padStart(gutter) : " ".repeat(gutter);
                    gutters.push(`${this.theme.fg("dim", number)} `);
                    rows.push(segment);
                }
            }
        }
        if (doc.truncated)
            rows.push(this.theme.fg("warning", ` … file is larger than ${humanSize(doc.kind === "hex" ? HEX_BYTES : MAX_TEXT_BYTES)}; the rest is not shown`));
        const contents = rows;
        const allGutters = rows.map((_, index) => gutters?.[index] ?? "");
        this.rowsCache = { key, rows: contents.map((content, index) => allGutters[index] + content), gutters: allGutters, contents, lineStarts };
        return this.rowsCache.rows;
    }
    /** The key row: the prompt while typing, else a message or the key hints, and the position. */
    statusLine(hints, position) {
        const th = this.theme;
        if (this.prompt)
            return ` ${th.fg("accent", `${this.prompt.kind}${printable(this.prompt.text)}▏`)}`;
        const left = this.message ? th.fg("warning", this.message) : th.fg("dim", hints);
        return ` ${left}  ${th.fg("accent", position)}`;
    }
    render(width, height) {
        this.width = width;
        this.height = height;
        const th = this.theme;
        const name = th.fg("accent", this.entry.label);
        if (!restat(this.entry)) {
            this.pane?.dispose();
            this.pane = undefined;
            return {
                title: name,
                body: centered(th.fg("error", `${this.entry.label} not found`), width, height).map((line) => pad(line, width)),
                status: ` ${th.fg("dim", "q back")}`,
            };
        }
        if (this.mode === "text") {
            const doc = loadDoc(this.entry);
            const rows = this.textRows(width - 1);
            const max = Math.max(0, rows.length - height);
            this.scroll = Math.max(0, Math.min(max, this.scroll));
            const bar = scrollbar(th, rows.length, height, this.scroll, height);
            const invert = (text) => th.inverse(text);
            const cache = this.rowsCache;
            const body = Array.from({ length: height }, (_, row) => {
                const at = this.scroll + row;
                if (at >= rows.length)
                    return " ".repeat(width - 1) + bar[row];
                return pad((cache.gutters[at] ?? "") + this.finder.highlight(cache.contents[at] ?? "", invert), width - 1) + bar[row];
            });
            const last = Math.min(rows.length, this.scroll + height);
            const percent = max === 0 ? 100 : Math.round((this.scroll / max) * 100);
            const md = doc.markdown !== undefined ? ` · r ${this.markdown ? "raw" : "render"}` : "";
            const label = doc.kind === "hex" ? "hex" : doc.markdown !== undefined && this.markdown ? "markdown" : `${doc.lines.length} lines`;
            return {
                title: `${name} ${th.fg("dim", `${label} · ${humanSize(this.entry.size)}`)}`,
                body,
                status: this.statusLine(`j/k scroll · / search · : line · g/G ends · w wrap ${this.wrap ? "off" : "on"}${md} · i insert · q back`, `${this.scroll + 1}-${last}/${rows.length} ${percent}%`),
            };
        }
        const info = this.info;
        const dims = info?.width && info.height ? `${info.width}×${info.height}` : "";
        const meta = [dims, info?.codec, info?.duration ? clock(info.duration) : "", humanSize(this.entry.size)].filter(Boolean).join(" · ");
        const title = `${name} ${th.fg("dim", meta)}`;
        if (this.mode === "image") {
            const key = `${this.entry.path}|${this.entry.mtime.getTime()}|image`;
            const still = this.stills.get(key, stillJob(this.entry));
            const body = still?.base64 && still.mimeType
                ? imageBody(still.base64, still.mimeType, th, width, height, this.entry.path, still.dimensions, undefined, true).lines
                : centered(still?.error ? th.fg("error", still.error) : th.fg("dim", "decoding…"), width, height);
            return { title, body, status: ` ${th.fg("dim", "i insert · q back")}` };
        }
        // video
        if (!this.probed) {
            return { title, body: centered(th.fg("dim", "loading…"), width, height).map((line) => pad(line, width)), status: ` ${th.fg("dim", "q back")}` };
        }
        this.pane ??= new PlayerPane({
            video: this.entry.path,
            loop: extname(this.entry.name).toLowerCase() === ".gif",
            label: this.entry.path,
            ...(info?.duration ? { duration: info.duration } : {}),
            ...(info?.fps === undefined ? {} : { fps: info.fps }),
        }, { tui: this.tui, theme: th, hint: "i insert · q back" });
        return { title, ...this.pane.render(width, height) };
    }
}
export class FileBrowser {
    tui;
    theme;
    done;
    focused = false;
    cwd;
    entries = [];
    cursor = 0;
    scroll = 0;
    previewScroll = 0;
    previewFor = "";
    previewTotal = 0;
    showHidden = false;
    filter = "";
    filtering = false;
    marked = new Set();
    /** Remembers the cursor per directory so going back lands where you were. */
    lastCursor = new Map();
    message = "";
    viewer;
    layout;
    parentEntries = [];
    listings = new Map();
    currentListing = { entries: [] };
    stills;
    constructor(tui, theme, start, done, 
    /** A file in `start` to show at once; closing its viewer leaves the browser on it. */
    file) {
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.cwd = start;
        this.stills = new StillCache(() => this.tui.requestRender());
        if (file?.startsWith("."))
            this.showHidden = true;
        this.load(file);
        // Only the file that was asked for: when it is not in the listing, nothing else opens instead.
        if (file !== undefined && this.current()?.name === file)
            this.open(this.current());
    }
    /** Stops whatever is playing. Called when the overlay closes and when the session shuts down. */
    dispose() {
        this.viewer?.dispose();
        this.viewer = undefined;
    }
    finish(result) {
        this.dispose();
        this.done(result);
    }
    /** A directory's entries, read again only when the directory changed: render asks for the
     * parent's and the previewed folder's on every frame, which was slow next to large directories. */
    listing(dir) {
        let mtime = -1;
        try {
            mtime = statSync(dir).mtimeMs;
        }
        catch {
            // gone or unreadable: readListing says which
        }
        const key = `${dir}|${this.showHidden}`;
        const hit = this.listings.get(key);
        if (hit && hit.mtime === mtime)
            return hit.listing;
        const listing = readListing(dir, this.showHidden);
        this.listings.set(key, { mtime, listing });
        if (this.listings.size > 32)
            this.listings.delete(this.listings.keys().next().value);
        return listing;
    }
    /** Follows the current directory when files appear or go away while the overlay is open. */
    refresh() {
        const fresh = this.listing(this.cwd);
        if (fresh === this.currentListing)
            return;
        const selected = this.current()?.name;
        this.currentListing = fresh;
        this.entries = fresh.entries;
        const index = selected === undefined ? -1 : this.visible().findIndex((entry) => entry.name === selected);
        this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.visible().length - 1));
    }
    load(select) {
        this.currentListing = this.listing(this.cwd);
        this.entries = this.currentListing.entries;
        const target = select ?? this.lastCursor.get(this.cwd);
        const index = target ? this.visible().findIndex((entry) => entry.name === target) : -1;
        this.cursor = Math.max(0, index);
        this.scroll = 0;
    }
    visible() {
        if (!this.filter)
            return this.entries;
        const needle = this.filter.toLowerCase();
        return this.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
    }
    current() {
        return this.visible()[this.cursor];
    }
    bodyHeight() {
        return Math.max(3, this.tui.terminal.rows - PAGE_CHROME_ROWS);
    }
    /** No viewer, filter or search is open: Tab may switch the page to the changes. */
    get atRoot() {
        return this.viewer === undefined && !this.filtering;
    }
    move(delta) {
        const count = this.visible().length;
        if (count === 0)
            return;
        this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
    }
    cd(path, select) {
        this.cwd = path;
        this.filter = "";
        this.load(select);
    }
    open(entry) {
        if (!entry)
            return;
        if (entry.isDir) {
            this.lastCursor.set(this.cwd, entry.name);
            this.cd(entry.path);
        }
        else {
            this.viewer = new Viewer(this.tui, this.theme, entry, this.stills);
        }
    }
    leave() {
        const parent = dirname(this.cwd);
        if (parent === this.cwd)
            return;
        this.lastCursor.set(this.cwd, this.current()?.name ?? "");
        this.cd(parent, basename(this.cwd));
    }
    insert() {
        // A marked file that was deleted since is left out.
        const paths = this.marked.size > 0 ? [...this.marked].filter((path) => existsSync(path)) : this.current() ? [this.current().path] : [];
        this.finish(paths.length > 0 ? { paths } : undefined);
    }
    handleInput(data) {
        this.message = "";
        if (this.viewer) {
            const action = this.viewer.handleInput(data);
            if (this.viewer.busy) {
                this.tui.requestRender();
                return;
            }
            if (action === "insert") {
                this.finish({ paths: [this.viewer.entry.path] });
                return;
            }
            if (action === "back") {
                this.viewer.dispose();
                this.viewer = undefined;
            }
            this.tui.requestRender();
            return;
        }
        if (this.filtering) {
            if (matchesKey(data, "escape")) {
                this.filtering = false;
                this.filter = "";
                this.cursor = 0;
            }
            else if (matchesKey(data, "return")) {
                this.filtering = false;
            }
            else if (matchesKey(data, "backspace")) {
                this.filter = this.filter.slice(0, -1);
                this.cursor = 0;
            }
            else if (data.length === 1 && data.charCodeAt(0) >= 32) {
                this.filter += data;
                this.cursor = 0;
            }
            this.tui.requestRender();
            return;
        }
        const half = Math.floor(this.bodyHeight() / 2);
        if (matchesKey(data, "escape") || data === "q") {
            if (this.filter) {
                this.filter = "";
                this.cursor = 0;
            }
            else {
                this.finish(undefined);
                return;
            }
        }
        else if (data === "j" || matchesKey(data, "down"))
            this.move(1);
        else if (data === "k" || matchesKey(data, "up"))
            this.move(-1);
        else if (data === "l" || matchesKey(data, "right") || matchesKey(data, "return"))
            this.open(this.current());
        else if (data === "h" || matchesKey(data, "left"))
            this.leave();
        else if (data === "g")
            this.cursor = 0;
        else if (data === "G")
            this.cursor = Math.max(0, this.visible().length - 1);
        else if (matchesKey(data, "ctrl+d"))
            this.move(half);
        else if (matchesKey(data, "ctrl+u"))
            this.move(-half);
        else if (data === "J")
            this.previewScroll += 5;
        else if (data === "K")
            this.previewScroll = Math.max(0, this.previewScroll - 5);
        else if (data === "~")
            this.cd(homedir());
        else if (data === ".") {
            this.showHidden = !this.showHidden;
            this.load(this.current()?.name);
            this.message = this.showHidden ? "showing hidden files" : "hiding hidden files";
        }
        else if (data === "/") {
            this.filtering = true;
            this.filter = "";
        }
        else if (data === " ") {
            const entry = this.current();
            if (entry) {
                if (this.marked.has(entry.path))
                    this.marked.delete(entry.path);
                else
                    this.marked.add(entry.path);
                this.move(1);
            }
        }
        else if (data === "i") {
            this.insert();
            return;
        }
        this.tui.requestRender();
    }
    handleMouse(event) {
        const layout = this.layout;
        if (!layout)
            return { handled: true };
        const row = event.y - layout.top;
        if (this.viewer) {
            if (row >= 0 && row <= layout.height)
                this.viewer.handleMouse(event, event.x - 1, row);
            return event.type === "press" ? { capture: true } : { handled: true };
        }
        if (row < 0 || row >= layout.height)
            return { handled: true };
        const inside = ([start, end]) => event.x >= start && event.x < end;
        if (event.type === "wheel") {
            const delta = event.wheelDelta ?? 0;
            if (inside(layout.current))
                this.move(delta);
            else if (inside(layout.preview))
                this.previewScroll = Math.max(0, this.previewScroll + delta);
            return { handled: true };
        }
        const onBar = (column) => event.x === column[1] - 1;
        if (event.type === "press" || event.type === "drag") {
            if (onBar(layout.current)) {
                const count = this.visible().length;
                this.cursor = scrollFromBar(row, layout.height, count, 1);
                return { capture: true };
            }
            if (onBar(layout.preview)) {
                this.previewScroll = scrollFromBar(row, layout.height, this.previewTotal, layout.height);
                return { capture: true };
            }
            return { handled: true };
        }
        if (event.type === "click") {
            if (inside(layout.current)) {
                const index = this.scroll + row;
                if (index < this.visible().length) {
                    this.cursor = index;
                    if ((event.clickCount ?? 1) >= 2)
                        this.open(this.current());
                }
            }
            else if (inside(layout.parent)) {
                const target = this.parentEntries[layout.parentStart + row];
                if (target?.isDir)
                    this.cd(target.path);
            }
            else if (inside(layout.preview) && (event.clickCount ?? 1) >= 2) {
                this.open(this.current());
            }
        }
        return { handled: true };
    }
    // ── rendering ────────────────────────────────────────────────────────────
    entryLine(entry, width, selected, active) {
        const th = this.theme;
        const mark = this.marked.has(entry.path) ? th.fg("warning", "▍") : " ";
        const name = `${icon(entry)} ${entry.label}${entry.isDir ? "/" : ""}${entry.isLink ? " →" : ""}`;
        const size = active && !entry.isDir ? humanSize(entry.size) : "";
        const nameWidth = Math.max(1, width - 1 - (size ? visibleWidth(size) + 1 : 0));
        let body = pad(name, nameWidth) + (size ? ` ${size}` : "");
        body = pad(body, width - 1);
        if (selected) {
            return mark + th.style(body, { bg: "selectedBg", fg: entry.isDir ? "accent" : "text", bold: true });
        }
        const kind = entry.isDir ? "text" : kindOf(entry.name);
        const color = entry.isDir ? "accent" : entry.isExec ? "success" : entry.isLink ? "mdLink"
            : kind === "image" || kind === "quicklook" ? "syntaxString" : kind === "video" ? "syntaxKeyword" : "text";
        return mark + th.fg(active ? color : "muted", body);
    }
    /** A file list; the active one keeps `this.scroll` in view and gets a scrollbar. Returns the first shown index too. */
    listColumn(entries, selectedName, width, height, active, 
    /** Shown instead of "(empty)" when the directory is gone or unreadable. */
    problem) {
        const lines = [];
        const listWidth = active ? width - 1 : width;
        let start = 0;
        if (problem !== undefined) {
            lines.push(this.theme.fg("error", pad(` ${problem}`, listWidth)));
        }
        else if (entries.length === 0) {
            lines.push(this.theme.fg("dim", pad(" (empty)", listWidth)));
        }
        else {
            const selectedIndex = entries.findIndex((entry) => entry.name === selectedName);
            if (active) {
                if (this.cursor < this.scroll)
                    this.scroll = this.cursor;
                if (this.cursor >= this.scroll + height)
                    this.scroll = this.cursor - height + 1;
                this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, entries.length - height)));
                start = this.scroll;
            }
            else if (selectedIndex >= height) {
                start = Math.min(selectedIndex - Math.floor(height / 2), entries.length - height);
            }
            for (const [offset, entry] of entries.slice(start, start + height).entries()) {
                lines.push(this.entryLine(entry, listWidth, start + offset === selectedIndex, active));
            }
        }
        while (lines.length < height)
            lines.push(" ".repeat(listWidth));
        if (!active)
            return { lines, start };
        const bar = scrollbar(this.theme, entries.length, height, start, height);
        return { lines: lines.map((line, row) => line + bar[row]), start };
    }
    previewColumn(width, height) {
        const th = this.theme;
        const entry = this.current();
        const exists = entry !== undefined && restat(entry);
        if (entry?.path !== this.previewFor) {
            this.previewFor = entry?.path ?? "";
            this.previewScroll = 0;
        }
        const inner = width - 1;
        let lines;
        let scrollable = false;
        if (!entry) {
            lines = [];
        }
        else if (!exists) {
            lines = [th.fg("error", ` ${entry.label} not found`)];
        }
        else if (entry.isDir) {
            const children = this.listing(entry.path);
            lines = children.problem !== undefined
                ? [th.fg("error", ` ${entry.label} ${children.problem}`)]
                : children.entries.length === 0
                    ? [th.fg("dim", " (empty)")]
                    : children.entries.map((child) => this.entryLine(child, inner, false, true));
            scrollable = true;
        }
        else if (entry.isFile && kindOf(entry.name) !== "text") {
            const kind = kindOf(entry.name);
            const key = `${entry.path}|${entry.mtime.getTime()}|preview`;
            const still = this.stills.get(key, stillJob(entry));
            const info = still?.info;
            const dims = info?.width && info.height ? `${info.width}×${info.height}` : still?.dimensions ? `${still.dimensions.widthPx}×${still.dimensions.heightPx}` : "";
            const meta = [kind === "video" ? "▶" : "", dims, info?.codec, info?.duration ? clock(info.duration) : "", "enter to view"].filter(Boolean).join(" · ");
            lines = still?.error
                ? [th.fg("error", ` ${still.error}`)]
                : still?.base64 && still.mimeType
                    ? [...imageBody(still.base64, still.mimeType, th, inner, Math.max(1, height - 1), entry.path, still.dimensions).lines, th.fg("dim", ` ${meta}`)]
                    : [th.fg("dim", " decoding…")];
        }
        else {
            const doc = loadDoc(entry);
            if (doc.kind === "hex") {
                lines = doc.lines.map((line) => th.fg("dim", line.slice(0, 8)) + th.fg("toolOutput", line.slice(8)));
            }
            else {
                const gutter = String(doc.lines.length).length;
                lines = doc.lines.map((line, index) => `${th.fg("dim", String(index + 1).padStart(gutter))} ${doc.highlighted?.[index] ?? th.fg("toolOutput", line)}`);
            }
            scrollable = true;
        }
        this.previewTotal = scrollable ? lines.length : 0;
        if (!scrollable)
            this.previewScroll = 0;
        this.previewScroll = Math.max(0, Math.min(this.previewScroll, Math.max(0, lines.length - height)));
        const bar = scrollbar(th, this.previewTotal, height, this.previewScroll, height);
        const shown = lines.slice(this.previewScroll, this.previewScroll + height);
        return Array.from({ length: height }, (_, row) => pad(shown[row] ?? "", inner) + bar[row]);
    }
    render(width) {
        const th = this.theme;
        const inner = Math.max(20, width - 2);
        const height = this.bodyHeight();
        const border = (text) => th.fg("border", text);
        const sep = border("│");
        const home = homedir();
        const tilde = (path) => printable(path.startsWith(home) ? `~${path.slice(home.length)}` : path);
        const badge = th.style(" preview ", { bg: "selectedBg", fg: "accent", bold: true });
        const lines = [border(`╭${"─".repeat(inner)}╮`)];
        if (this.viewer) {
            const frame = this.viewer.render(inner, height);
            this.layout = { parent: [0, 0], current: [0, 0], preview: [1, 1 + inner], top: 2, height, parentStart: 0 };
            lines.push(sep + pad(` ${badge} ${frame.title}`, inner) + sep);
            for (const row of frame.body)
                lines.push(sep + row + sep);
            lines.push(sep + pad(frame.status, inner) + sep);
            lines.push(border(`╰${"─".repeat(inner)}╯`));
            return lines;
        }
        const parentWidth = Math.max(8, Math.floor(inner * 0.18));
        const currentWidth = Math.max(12, Math.floor(inner * 0.34));
        const previewWidth = Math.max(8, inner - parentWidth - currentWidth - 2);
        const parentDir = dirname(this.cwd);
        const parentListing = parentDir === this.cwd ? { entries: [] } : this.listing(parentDir);
        this.parentEntries = parentListing.entries;
        this.refresh();
        const visible = this.visible();
        const parent = this.listColumn(this.parentEntries, basename(this.cwd), parentWidth, height, false, parentListing.problem === undefined ? undefined : `${printable(basename(parentDir))} ${parentListing.problem}`);
        const problem = this.currentListing.problem;
        const current = this.listColumn(visible, visible[this.cursor]?.name, currentWidth, height, true, problem === undefined ? undefined : `${printable(basename(this.cwd))} ${problem}`);
        const preview = this.previewColumn(previewWidth, height);
        const currentStart = 2 + parentWidth;
        this.layout = {
            parent: [1, 1 + parentWidth],
            current: [currentStart, currentStart + currentWidth],
            preview: [currentStart + currentWidth + 1, currentStart + currentWidth + 1 + previewWidth],
            top: 2,
            height,
            parentStart: parent.start,
        };
        const title = ` ${badge} ${th.fg("accent", tilde(this.cwd))}${this.filter ? th.fg("warning", `  /${this.filter}${this.filtering ? "▏" : ""}`) : ""} `;
        lines.push(sep + pad(title, inner) + sep);
        for (let row = 0; row < height; row++) {
            lines.push(sep + parent.lines[row] + sep + current.lines[row] + sep + preview[row] + sep);
        }
        const entry = this.current();
        const position = visible.length > 0 ? `${this.cursor + 1}/${visible.length}` : "0/0";
        const left = entry
            ? ` ${th.fg("muted", permString(entry.mode, entry.isDir))}  ${th.fg("text", entry.isDir ? "-" : humanSize(entry.size))}  ${th.fg("dim", localTime(entry.mtime))}`
            : "";
        const right = this.message
            ? th.fg("warning", this.message)
            : `${this.marked.size > 0 ? th.fg("warning", `${this.marked.size} marked  `) : ""}${th.fg("dim", "enter view · i insert · space mark · / filter · . hidden · q quit")}  ${th.fg("accent", position)} `;
        const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
        lines.push(sep + pad(left + " ".repeat(gap) + right, inner) + sep);
        lines.push(border(`╰${"─".repeat(inner)}╯`));
        return lines;
    }
    invalidate() { }
    /** Paths for the editor: relative to the session root when inside it, absolute otherwise. */
    static display(root, path) {
        const rel = relative(root, path);
        return rel && !rel.startsWith("..") ? rel : path;
    }
}
//# sourceMappingURL=view.js.map