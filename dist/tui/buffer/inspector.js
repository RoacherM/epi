import { piTui } from "../pi-tui.js";
import { scrollbar } from "./scrollbar.js";
import { printable } from "./search.js";
import { BufferViewport } from "./viewport.js";
const { matchesKey, truncateToWidth, visibleWidth } = piTui;
// Share of the terminal's height the overlay may take (design: max height 82%).
const MAX_HEIGHT_SHARE = 0.82;
const CLOSE_LABEL = " [× Esc] ";
const WHEEL_ROWS = 3;
export class BlockInspectorOverlay {
    theme;
    actions;
    views = [];
    constructor(theme, target, actions) {
        this.theme = theme;
        this.actions = actions;
        this.push(target);
    }
    /** The page on top. */
    get viewport() {
        return this.view.viewport;
    }
    get view() {
        return this.views[this.views.length - 1];
    }
    get target() {
        return this.view.target;
    }
    push(target) {
        const content = target.firstLineNumber === undefined
            ? { lines: target.lines }
            : { lines: target.lines, firstLineNumber: target.firstLineNumber };
        const viewport = new BufferViewport(content, {
            gutter: (text) => this.theme.fg("dim", text),
            separator: (text) => this.theme.fg("borderMuted", text),
            match: (text) => this.theme.inverse(text),
        });
        viewport.wrap = target.wrap === true;
        const view = { target, viewport };
        this.views.push(view);
        if (target.live !== undefined) {
            if (target.live.follow === true)
                viewport.scrollTop = Number.MAX_SAFE_INTEGER;
            view.stopLive = target.live.subscribe((next) => this.update(view, next));
        }
    }
    /** Leaves the page on top for the one under it; false when it is the only one. */
    back() {
        if (this.views.length <= 1)
            return false;
        this.views.pop()?.stopLive?.();
        this.actions.requestRender();
        return true;
    }
    close() {
        if (!this.back())
            this.actions.close();
    }
    /** Ends live updates; the host calls it when it hides the overlay. */
    dispose() {
        for (const view of this.views)
            view.stopLive?.();
    }
    /** New content for a live page: the position is kept, and a following page scrolled to the end
     * stays at the end. */
    update(view, target) {
        const following = view.target.live?.follow === true && view.viewport.scrollTop >= view.viewport.maxScroll;
        view.target = target;
        view.viewport.setLines(target.lines);
        if (following)
            view.viewport.scrollToEnd();
        this.actions.requestRender();
    }
    /** `openLine`'s page for logical line `line`, opened on top. */
    open(line) {
        const next = this.target.openLine?.(line);
        if (next !== undefined)
            this.push(next);
        this.actions.requestRender();
    }
    handleInput(data) {
        if (piTui.isKeyRelease(data))
            return;
        // Esc in a prompt only leaves the prompt; Esc in NORMAL (nothing pending) goes back or closes.
        const result = this.viewport.handleInput(data);
        if (result === "close") {
            this.close();
            return;
        }
        if (result === "yank")
            this.yank();
        if (result === "ignored" && data === "e" && this.target.edit !== undefined) {
            const edit = this.target.edit;
            this.actions.close();
            edit();
            return;
        }
        if (result === "ignored" && matchesKey(data, "enter") && this.target.openLine !== undefined) {
            this.open(this.viewport.visibleLines().first - 1);
            return;
        }
        if (result === "ignored" && matchesKey(data, "ctrl+c")) {
            this.actions.close();
            return;
        }
        this.actions.requestRender();
    }
    handleMouse(event) {
        if (event.type === "wheel") {
            this.viewport.wheel((event.wheelDelta ?? 1) * WHEEL_ROWS);
            return { handled: true, render: true };
        }
        if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= event.width - visibleWidth(CLOSE_LABEL) - 2) {
            this.close();
            return { handled: true, render: true };
        }
        // Body rows start under the top border.
        const line = event.type === "click" && event.button === "left" ? this.viewport.lineAtRow(event.y - 1) : undefined;
        if (line !== undefined && this.target.openLine !== undefined) {
            this.open(line);
            return { handled: true, render: true };
        }
        // Clicks inside never fall through to the transcript underneath.
        return { handled: true };
    }
    render(width) {
        const th = this.theme;
        const inner = Math.max(1, width - 4);
        const maxBody = Math.max(1, Math.floor(this.actions.terminalRows() * MAX_HEIGHT_SHARE) - 2);
        const bodyHeight = Math.max(1, Math.min(maxBody, this.viewport.measure(inner)));
        const body = this.viewport.render(inner, bodyHeight);
        // The right frame edge doubles as the scrollbar; a plain edge when everything fits.
        const bar = scrollbar(th, this.viewport.rowCount, bodyHeight, this.viewport.scrollTop, bodyHeight, { thumb: "accent", track: "borderMuted", fits: "borderAccent" });
        const rows = body.map((row, index) => `${th.fg("borderAccent", "│")} ${truncateToWidth(row, inner, "…", true)} ${bar[index]}`);
        return [this.topBorder(width), ...rows, this.bottomBorder(width)];
    }
    invalidate() { }
    topBorder(width) {
        const th = this.theme;
        const close = th.fg("warning", CLOSE_LABEL);
        const room = Math.max(0, width - 3 - visibleWidth(CLOSE_LABEL) - 2);
        const subtitle = this.target.subtitle === undefined ? "" : ` ${th.fg("muted", `(${this.target.subtitle})`)}`;
        const title = truncateToWidth(` ${th.bold(th.fg("accent", this.target.title))}${subtitle} `, room, "…");
        const fill = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(CLOSE_LABEL) - 2);
        return `${th.fg("borderAccent", "╭─")}${title}${th.fg("borderAccent", "─".repeat(fill))}${close}${th.fg("borderAccent", "─╮")}`;
    }
    /** The position readout on the bottom border's left, or the prompt/status in its place. */
    positionLabel() {
        const th = this.theme;
        const viewport = this.viewport;
        const { prompt, status, pending: typed } = viewport.navigation;
        if (prompt !== undefined)
            return th.fg("text", ` ${prompt.kind}${printable(prompt.text)}█ `);
        if (status !== undefined)
            return th.fg(status.tone === "error" ? "error" : "success", ` ${status.text} `);
        const { first, last } = viewport.visibleLines();
        const percent = viewport.maxScroll === 0 ? 100 : Math.round((viewport.scrollTop / viewport.maxScroll) * 100);
        const pending = typed === "" ? "" : ` · ${typed}`;
        return ` ${th.fg("accent", viewport.mode)}${th.fg("muted", ` · L${first}–${last}/${viewport.lineCount} (${percent}%)${pending}`)} `;
    }
    /** The keys the bottom border lists: the page's own action first, `q back` on a page opened from
     * a list. */
    keyHint() {
        const prompt = this.viewport.navigation.prompt;
        if (prompt !== undefined)
            return prompt.kind === "/" ? "Enter search · Esc back" : "Enter go to line · Esc back";
        const action = this.target.edit !== undefined ? "e edit · " : this.target.openLine !== undefined ? "click/Enter open · " : "";
        const close = this.views.length > 1 ? "q back" : "q close";
        return `${action}j/k · gg/G · / search · :line · w wrap:${this.viewport.wrap ? "on" : "off"} · y copy · ${close}`;
    }
    bottomBorder(width) {
        const th = this.theme;
        const room = Math.max(0, width - 4);
        const leftFitted = truncateToWidth(this.positionLabel(), room, "…");
        const hintRoom = room - visibleWidth(leftFitted) - 2;
        const right = hintRoom >= 12 ? ` ${th.fg("muted", truncateToWidth(this.keyHint(), hintRoom - 1, "…"))} ` : "";
        const fill = Math.max(0, room - visibleWidth(leftFitted) - visibleWidth(right));
        return `${th.fg("borderAccent", "╰─")}${leftFitted}${th.fg("borderAccent", "─".repeat(fill))}${right}${th.fg("borderAccent", "─╯")}`;
    }
    yank() {
        const count = this.target.lines.length;
        void this.actions.copy(this.target.text).then(() => {
            this.viewport.navigation.status = { text: `Copied ${count} ${count === 1 ? "line" : "lines"}`, tone: "info" };
            this.actions.requestRender();
        }, (error) => {
            this.viewport.navigation.status = { text: `Copy failed: ${error instanceof Error ? error.message : String(error)}`, tone: "error" };
            this.actions.requestRender();
        });
    }
}
//# sourceMappingURL=inspector.js.map