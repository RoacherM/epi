// Keyboard navigation for a read-only view of rows (docs/tui-buffer-components.md): the shared
// motion keys (motion-keys.ts), `/` search with `n`/`N`, and `:N` / `NG` line jumps, applied to
// the view through a small target. The view keeps what is its own (wrapping, copying, closing,
// Markdown, a diff's `]c`): `handle()` hands those keys back with any count typed before them.
import { applyMotion, MotionKeys } from "./motion-keys.js";
import { Finder, LinePrompt, printable } from "./search.js";
export class TextNavigation {
    target;
    /** The open `/` or `:` prompt; every key goes to it until Enter or Esc. */
    prompt;
    /** Shown until the next key; the view may set its own (wrap on, copied, no change below). */
    status;
    finder = new Finder();
    motions = new MotionKeys();
    /** The row `n`/`N` last landed on, with its text. Near the end, revealing a match can leave it
     * below the top, and searching on from the top would find it again forever, so `n` continues from
     * it -- while that row is on screen and still reads the same (rewrapping, a raw/Markdown switch
     * or a reloaded file changes it). Every move (keys, `:N`, the view's own `scrollTo`) forgets it. */
    current;
    constructor(target) {
        this.target = target;
    }
    /** A count or `g` typed but not finished (`12`, `g`), for the footer. */
    get pending() {
        return this.motions.pending;
    }
    get query() {
        return this.finder.query;
    }
    /** The view moved itself (mouse wheel, scrollbar drag, a diff's `]c`): clamps `row` and puts it
     * on top. Views move only through this or `handle()`, so the clamping stays in one place. */
    scrollTo(row) {
        this.current = undefined;
        this.reveal(row);
    }
    /** A row with the current query's matches shown by `invert`. */
    highlight(row, invert) {
        return this.finder.highlight(row, invert);
    }
    handle(data) {
        if (this.prompt !== undefined) {
            this.status = undefined;
            const outcome = this.prompt.handleInput(data);
            if (outcome !== undefined) {
                const prompt = this.prompt;
                this.prompt = undefined;
                if (outcome === "submit")
                    this.submit(prompt);
            }
            return { kind: "taken" };
        }
        const keys = this.motions.handle(data);
        if (keys.kind === "pending")
            return { kind: "taken" };
        this.status = undefined;
        if (keys.kind === "motion") {
            this.current = undefined;
            if (keys.motion.kind === "line")
                this.goToLine(keys.motion.line);
            else
                this.reveal(applyMotion(keys.motion, this.top(), this.target.page(), this.target.maxTop()));
            return { kind: "taken" };
        }
        if (data === "/" || data === ":") {
            this.prompt = new LinePrompt(data);
            return { kind: "taken" };
        }
        if (data === "n" || data === "N") {
            for (let step = 0; step < (keys.count ?? 1); step += 1)
                this.findNext(data === "N", this.searchFrom());
            return { kind: "taken" };
        }
        return { kind: "key", count: keys.count };
    }
    /** The top as it shows: before a render it may still be past the end (a restored position). */
    top() {
        return Math.min(this.target.top(), this.target.maxTop());
    }
    reveal(row) {
        this.target.setTop(Math.max(0, Math.min(this.target.maxTop(), Math.round(row))));
    }
    /** Where `n`/`N` search from: the row they last landed on while it is on screen and unchanged,
     * else the top. On screen: from the top through the body height (rows − maxTop), or every row
     * when everything fits. */
    searchFrom() {
        const maxTop = this.target.maxTop();
        const top = this.top();
        const current = this.current;
        if (current === undefined)
            return top;
        const rows = this.target.rows();
        const bottom = maxTop === 0 ? rows.length : top + rows.length - maxTop;
        const onScreen = current.row >= top && current.row < bottom;
        return onScreen && rows[current.row] === current.text ? current.row : top;
    }
    goToLine(line) {
        this.current = undefined;
        const place = this.target.goToLine === undefined ? { row: line - 1 } : this.target.goToLine(line);
        if (place === undefined)
            return;
        if ("error" in place)
            this.status = { text: place.error, tone: "error" };
        else
            this.reveal(place.row);
    }
    submit(prompt) {
        if (prompt.kind === "/") {
            this.finder.query = prompt.text;
            this.current = undefined;
            // From the row above the top, so a match on the top row itself is found first.
            this.findNext(false, this.top() - 1);
            return;
        }
        const line = Number.parseInt(prompt.text, 10);
        if (!Number.isFinite(line) || line < 1)
            this.status = { text: `not a line number: ${printable(prompt.text)}`, tone: "error" };
        else
            this.goToLine(line);
    }
    /** The next match after row `from` (before it, backwards), wrapping around. */
    findNext(backwards, from) {
        if (this.finder.query === "")
            return;
        const rows = this.target.rows();
        const found = this.finder.next(rows, from, backwards);
        if (found === undefined) {
            this.status = { text: `not found: ${printable(this.finder.query)}`, tone: "error" };
            return;
        }
        this.reveal(found);
        this.current = { row: found, text: rows[found] ?? "" };
        const matches = this.finder.matches(rows);
        this.status = { text: `[${matches.indexOf(found) + 1}/${matches.length}] /${printable(this.finder.query)}`, tone: "info" };
    }
}
//# sourceMappingURL=navigation.js.map