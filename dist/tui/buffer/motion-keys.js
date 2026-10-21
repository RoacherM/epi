// The motion keys every scrolling view and list shares (docs/tui-buffer-overlay-design.md §7.5):
// counts (`10j`, `120G`), `gg`/`G`, lines, half pages, pages. Only motion: each page keeps its own
// `/`, `:`, `n`/`N`, because they mean different things there (a list filter, a note prompt, a
// detail-pane search). A page applies the motion to its cursor or its scroll position.
import { piTui } from "../pi-tui.js";
const { matchesKey } = piTui;
export class MotionKeys {
    count = "";
    pendingG = false;
    counts;
    space;
    constructor(options = {}) {
        this.counts = options.counts ?? true;
        this.space = options.space ?? true;
    }
    /** What is typed but not finished (`12`, `g`), for a footer. */
    get pending() {
        return `${this.count}${this.pendingG ? "g" : ""}`;
    }
    reset() {
        this.count = "";
        this.pendingG = false;
    }
    handle(data) {
        if (this.counts && /^[0-9]$/.test(data) && (data !== "0" || this.count !== "")) {
            this.count += data;
            this.pendingG = false;
            return { kind: "pending" };
        }
        const count = this.count === "" ? undefined : Number(this.count);
        const hadPending = this.pending !== "";
        const wasG = this.pendingG;
        this.reset();
        if (data === "g" && !wasG) {
            // Keep the count for `Ngg`.
            this.pendingG = true;
            this.count = count === undefined ? "" : String(count);
            return { kind: "pending" };
        }
        if (data === "g")
            return { kind: "motion", motion: count === undefined ? { kind: "top" } : { kind: "line", line: count } };
        // Esc first cancels what is typed; only a second Esc reaches the page.
        if (matchesKey(data, "escape") && hadPending)
            return { kind: "pending" };
        // A `g` followed by anything else is dropped; that key counts on its own.
        const motion = this.motion(data, count);
        return motion === undefined ? { kind: "key", count } : { kind: "motion", motion };
    }
    motion(data, count) {
        const times = count ?? 1;
        if (data === "j" || matchesKey(data, "down"))
            return { kind: "step", rows: times };
        if (data === "k" || matchesKey(data, "up"))
            return { kind: "step", rows: -times };
        if (matchesKey(data, "ctrl+d"))
            return { kind: "page", pages: 0.5 * times };
        if (matchesKey(data, "ctrl+u"))
            return { kind: "page", pages: -0.5 * times };
        if ((this.space && data === " ") || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f"))
            return { kind: "page", pages: times };
        if (data === "b" || matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b"))
            return { kind: "page", pages: -times };
        if (matchesKey(data, "home"))
            return { kind: "top" };
        if (matchesKey(data, "end"))
            return { kind: "bottom" };
        if (data === "G")
            return count === undefined ? { kind: "bottom" } : { kind: "line", line: count };
        return undefined;
    }
}
/**
 * Where `motion` takes position `at` (a cursor or a scroll offset), clamped to `0..last`. `page` is
 * the page's step for a full page (a half page is half of it, rounded down, as before); `lineAt`
 * maps a 1-based line number to a position, for pages whose rows are not lines.
 */
export function applyMotion(motion, at, page, last, lineAt = (line) => line - 1) {
    const clamp = (value) => Math.max(0, Math.min(Math.max(0, last), value));
    switch (motion.kind) {
        case "step":
            return clamp(at + motion.rows);
        case "page": {
            const whole = Math.trunc(motion.pages);
            const half = motion.pages - whole;
            return clamp(at + whole * page + Math.trunc(half * 2) * Math.floor(page / 2));
        }
        case "top":
            return 0;
        case "bottom":
            return clamp(Number.MAX_SAFE_INTEGER);
        case "line":
            return clamp(lineAt(motion.line));
    }
}
//# sourceMappingURL=motion-keys.js.map