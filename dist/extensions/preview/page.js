import { piTui } from "../../tui/pi-tui.js";
import { ChangesList } from "./changes.js";
import { pad } from "./draw.js";
import { entryFor } from "./files.js";
import { StillCache } from "./media.js";
import { FileBrowser, PAGE_CHROME_ROWS, Viewer } from "./view.js";
const { matchesKey } = piTui;
/** The full-file viewer as a view on the changes side ("d" in a diff). */
class FileView {
    viewer;
    constructor(viewer) {
        this.viewer = viewer;
    }
    get busy() {
        return this.viewer.busy;
    }
    render(width, height) {
        return this.viewer.render(width, height);
    }
    handleInput(data) {
        const action = this.viewer.handleInput(data);
        if (action === "back")
            return { kind: "back" };
        if (action === "insert")
            return { kind: "insert", paths: [this.viewer.entry.path] };
        return undefined;
    }
    dispose() {
        this.viewer.dispose();
    }
}
export class PreviewPage {
    tui;
    theme;
    ledger;
    cwd;
    done;
    focused = false;
    side;
    /** The changes side: the list, then whatever was opened from it. */
    stack;
    files;
    stills;
    unsubscribe;
    constructor(tui, theme, ledger, cwd, done, start) {
        this.tui = tui;
        this.theme = theme;
        this.ledger = ledger;
        this.cwd = cwd;
        this.done = done;
        this.stills = new StillCache(() => tui.requestRender());
        this.stack = [new ChangesList(ledger, theme, cwd)];
        this.side = start.side;
        if (start.side === "files")
            this.files = this.newBrowser(start.dir, start.file);
        // The agent goes on working while the page is open: show its state and its new changes.
        this.unsubscribe = ledger.subscribe(() => tui.requestRender());
    }
    /** The browser closes the whole page (Esc at its root, or i). */
    newBrowser(dir, file) {
        return new FileBrowser(this.tui, this.theme, dir, (result) => this.finish(result), file);
    }
    dispose() {
        this.unsubscribe();
        for (const view of this.stack)
            view.dispose?.();
        this.files?.dispose();
    }
    finish(result) {
        this.dispose();
        this.done(result);
    }
    top() {
        return this.stack[this.stack.length - 1];
    }
    handleInput(data) {
        if (this.side === "files") {
            const files = this.files;
            if (matchesKey(data, "tab") && files.atRoot)
                this.side = "changes";
            else
                files.handleInput(data);
            this.tui.requestRender();
            return;
        }
        const top = this.top();
        if (matchesKey(data, "tab") && this.stack.length === 1 && !top.busy) {
            this.side = "files";
            this.files ??= this.newBrowser(this.cwd);
            this.tui.requestRender();
            return;
        }
        this.apply(top.handleInput(data));
        this.tui.requestRender();
    }
    apply(action) {
        if (action === undefined)
            return;
        if (action.kind === "insert")
            return this.finish({ paths: action.paths });
        if (action.kind === "open") {
            this.stack.push(action.view);
            return;
        }
        if (action.kind === "file") {
            const entry = entryFor(action.path);
            if (entry)
                this.stack.push(new FileView(new Viewer(this.tui, this.theme, entry, this.stills)));
            return;
        }
        // back
        if (this.stack.length === 1)
            return this.finish(undefined);
        this.stack.pop()?.dispose?.();
    }
    handleMouse(event) {
        if (this.side === "files")
            return this.files.handleMouse(event);
        if (event.type === "wheel") {
            const key = (event.wheelDelta ?? 0) > 0 ? "j" : "k";
            for (let step = 0; step < Math.abs(event.wheelDelta ?? 0); step += 1)
                this.apply(this.top().handleInput(key));
            this.tui.requestRender();
        }
        return { handled: true };
    }
    /** The last line: whether the agent is working, and how many files it changed. */
    agentLine(width) {
        const th = this.theme;
        const count = this.ledger.changes("session").length;
        const state = this.ledger.running ? th.fg("accent", "● agent running") : th.fg("dim", "○ agent idle");
        const changed = th.fg("dim", ` · ${count} file${count === 1 ? "" : "s"} changed this session`);
        return pad(` ${state}${changed}`, width);
    }
    render(width) {
        const lines = this.side === "files" ? this.files.render(width) : this.renderChanges(width);
        return [...lines, this.agentLine(width)];
    }
    renderChanges(width) {
        const th = this.theme;
        const inner = Math.max(20, width - 2);
        const height = Math.max(3, this.tui.terminal.rows - PAGE_CHROME_ROWS);
        const border = (text) => th.fg("border", text);
        const sep = border("│");
        const badge = th.style(" preview ", { bg: "selectedBg", fg: "accent", bold: true });
        const frame = this.top().render(inner, height);
        return [
            border(`╭${"─".repeat(inner)}╮`),
            sep + pad(` ${badge} ${frame.title}`, inner) + sep,
            ...frame.body.map((row) => sep + pad(row, inner) + sep),
            sep + pad(frame.status, inner) + sep,
            border(`╰${"─".repeat(inner)}╯`),
        ];
    }
    invalidate() { }
}
//# sourceMappingURL=page.js.map