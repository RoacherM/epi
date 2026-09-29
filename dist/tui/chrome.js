// grok-build chrome (docs/tui-design.md 4.1, grok notes 2.1-2.2): header bar, user message block,
// turn status row, framed prompt, shortcuts bar. Pure render functions of the state they are given.
import { homedir } from "node:os";
import { sep } from "node:path";
import { piTui } from "./pi-tui.js";
const { truncateToWidth, visibleWidth } = piTui;
function fit(text, width) {
    return truncateToWidth(text, Math.max(0, width), "…");
}
/** Left and right segments on one row; the left side is truncated first. */
function spread(left, right, width) {
    const rightWidth = visibleWidth(right);
    if (rightWidth >= width)
        return fit(right, width);
    const leftFitted = fit(left, width - rightWidth - 1);
    return `${leftFitted}${" ".repeat(Math.max(1, width - visibleWidth(leftFitted) - rightWidth))}${right}`;
}
/** grok: `~` for home, middle components shortened to their first letter, last two kept full. */
export function shortenPath(path, home = homedir()) {
    const withHome = path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
    const parts = withHome.split(sep);
    return parts
        .map((part, index) => (index === 0 || index >= parts.length - 2 || part === "" ? part : [...part][0]))
        .join(sep);
}
export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    const thousands = count / 1000;
    return thousands >= 100 ? `${Math.round(thousands)}K` : `${thousands.toFixed(1).replace(/\.0$/, "")}K`;
}
function formatDuration(ms) {
    const seconds = ms / 1000;
    if (seconds < 60)
        return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
}
function line(render) {
    return { render: (width) => [render(width)], invalidate() { } };
}
export function headerBar(theme, state) {
    return line((width) => {
        const { branch, cwd, contextTokens, contextWindow } = state();
        const left = `${branch === undefined ? "" : `${theme.fg("dim", branch)} `}${theme.fg("text", shortenPath(cwd))}`;
        const right = contextWindow === undefined
            ? ""
            : theme.fg("text", `${formatTokens(contextTokens ?? 0)} / ${formatTokens(contextWindow)}`);
        return spread(left, right, width);
    });
}
// ── user message block ────────────────────────────────────────────────────────
/** Full-width `userMessageBg` block with one row of padding, `❯ text` and the time on the right. */
export class UserMessageBlock {
    theme;
    text;
    time;
    constructor(theme, text, time) {
        this.theme = theme;
        this.text = text;
        this.time = time;
    }
    render(width) {
        const paint = (content) => this.theme.bg("userMessageBg", content + " ".repeat(Math.max(0, width - visibleWidth(content))));
        const clock = this.theme.fg("muted", this.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
        const bodyWidth = Math.max(1, width - 4 - visibleWidth(clock) - 3);
        const lines = piTui.wrapTextWithAnsi(this.text, bodyWidth);
        const rows = lines.map((text, index) => {
            const prefix = index === 0 ? `${this.theme.fg("muted", "❯")} ` : "  ";
            const left = `  ${prefix}${this.theme.fg("userMessageText", text)}`;
            return index === 0 ? spread(left, `${clock}  `, width) : fit(left, width);
        });
        return [paint(""), ...rows.map(paint), paint("")];
    }
    invalidate() { }
}
// ── turn status row ───────────────────────────────────────────────────────────
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const SPINNER_MS = 133;
/** `⠧ Waiting for response… 2.4s ····· 2.4s ⇣2.3k [stop]`; zero rows when idle. */
export class TurnStatus {
    theme;
    state;
    requestRender;
    timer;
    constructor(theme, state, requestRender) {
        this.theme = theme;
        this.state = state;
        this.requestRender = requestRender;
    }
    render(width) {
        const turn = this.state();
        if (turn === undefined) {
            this.stop();
            return [];
        }
        this.timer ??= setInterval(this.requestRender, SPINNER_MS).unref();
        const now = Date.now();
        const frame = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length] ?? SPINNER[0];
        const phase = width >= 60 ? ` ${this.theme.fg("muted", formatDuration(now - turn.phaseStartedAt))}` : "";
        const left = `${this.theme.fg("accent", frame ?? "")} ${this.theme.fg("text", turn.activity)}${phase}`;
        const tokens = turn.outputTokens > 0 ? ` ${turn.estimated ? "~" : ""}⇣${formatTokens(turn.outputTokens).toLowerCase()}` : "";
        const right = `${this.theme.fg("muted", `${formatDuration(now - turn.startedAt)}${tokens}`)} ${this.theme.fg("muted", "[stop]")}`;
        return [spread(left, right, width)];
    }
    stop() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
    }
    invalidate() { }
}
// ── framed prompt ─────────────────────────────────────────────────────────────
/**
 * Wraps pi-tui's Editor in a rounded frame with `model (level)` on the bottom border. The editor
 * draws its own top and bottom rules (possibly with a `↑ N more` label); those rows are replaced,
 * content rows get side rails, and anything below the bottom rule (autocomplete) stays outside.
 */
/** Columns before the editor's own content starts inside the frame: `│` + space + the 2-column
 * `❯ `/`  ` prompt. Shared by render() and handleMouse() so a click lands on the same character
 * it's drawn on; exported so tests can compute click coordinates without duplicating it. */
export const PROMPT_COLUMNS = 4;
function plainText(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}
function isBorderRule(text) {
    const plain = plainText(text);
    return plain.includes("─") && /^[─↑↓\d\s a-z]+$/.test(plain);
}
export class PromptFrame {
    theme;
    editor;
    label;
    borderColor;
    constructor(theme, editor, label, borderColor) {
        this.theme = theme;
        this.editor = editor;
        this.label = label;
        this.borderColor = borderColor;
    }
    get focused() {
        return this.editor.focused ?? false;
    }
    set focused(value) {
        this.editor.focused = value;
    }
    /** Finds the editor's own top/bottom border rows within its rendered output at `inner` width,
     * so render() and handleMouse() agree on which rows are content. */
    contentBounds(inner) {
        const lines = this.editor.render(inner);
        const top = lines.findIndex(isBorderRule);
        let bottom = -1;
        for (let index = lines.length - 1; index > top; index -= 1) {
            if (isBorderRule(lines[index] ?? "")) {
                bottom = index;
                break;
            }
        }
        return { lines, top, bottom };
    }
    render(width) {
        const color = this.borderColor();
        // Frame (2 columns each side) plus the `❯ ` prompt column.
        const inner = Math.max(1, width - 6);
        const { lines, top, bottom } = this.contentBounds(inner);
        if (top === -1 || bottom === -1)
            return lines.map((text) => fit(text, width));
        // Keep the editor's scroll hints (`↑ 3 more`, `↓ 2 more`) inside the new borders.
        const hint = (rule) => plainText(rule).replace(/─/g, "").trim();
        const border = (left, right, text) => {
            const label = text === "" ? "" : ` ${text} `;
            const fill = Math.max(0, width - 3 - visibleWidth(label));
            return visibleWidth(label) + 4 <= width
                ? `${color(`${left}─`)}${this.theme.fg("muted", label)}${color(`${"─".repeat(fill - 0)}${right}`)}`
                : color(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
        };
        const bottomLabel = [hint(lines[bottom] ?? ""), this.label()].filter((part) => part !== "").join(" · ");
        const out = [border("╭", "╮", hint(lines[top] ?? ""))];
        lines.slice(top + 1, bottom).forEach((content, index) => {
            const prompt = index === 0 ? this.theme.fg("muted", "❯ ") : "  ";
            const padded = content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
            out.push(`${color("│")} ${prompt}${padded} ${color("│")}`);
        });
        // grok puts the model label on the right of the bottom border.
        const label = ` ${bottomLabel} `;
        const fill = Math.max(0, width - 3 - visibleWidth(label));
        out.push(visibleWidth(label) + 4 <= width
            ? `${color(`╰${"─".repeat(fill)}`)}${this.theme.fg("muted", label)}${color("─╯")}`
            : color(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
        for (const extra of lines.slice(bottom + 1))
            out.push(fit(extra, width));
        return out;
    }
    handleInput(data) {
        this.editor.handleInput(data);
    }
    /** Forwards a click/double-click inside the content rows to the editor, translated into its own
     * coordinate space (docs/tui-design.md 4.3: double-click on a chip expands it). Clicks on the
     * border or the autocomplete dropdown below it are left unhandled, matching prior behavior. */
    handleMouse(event) {
        const inner = Math.max(1, event.width - 6);
        const { top, bottom } = this.contentBounds(inner);
        if (top === -1 || bottom === -1)
            return undefined;
        const contentHeight = bottom - top - 1;
        if (event.y < 1 || event.y > contentHeight)
            return undefined;
        const x = event.x - PROMPT_COLUMNS;
        if (x < 0 || x >= inner)
            return undefined;
        return this.editor.handleMouse?.({ ...event, x, width: inner, height: contentHeight });
    }
    invalidate() {
        this.editor.invalidate();
    }
}
/** `Key:label  │  Key:label` on the left; extension statuses and notices on the right. */
export function shortcutsBar(theme, state) {
    return line((width) => {
        const { shortcuts, right } = state();
        const left = shortcuts
            .map(({ key, label }) => `${theme.bold(theme.fg("text", key))}${theme.fg("muted", `:${label}`)}`)
            .join(theme.fg("dim", "  │  "));
        return right === "" ? fit(left, width) : spread(left, right, width);
    });
}
/**
 * Messages queued while a turn runs (4.1 排队区), between the turn status row and the prompt.
 * At most 3 lines: Pi's `Steering:` / `Follow-up:` lines, plus an Alt+Up hint if there is room.
 */
export function queuedMessagesBar(theme, state) {
    return {
        render(width) {
            const { steering, followUp } = state();
            const lines = [
                ...steering.map((message) => `Steering: ${message}`),
                ...followUp.map((message) => `Follow-up: ${message}`),
            ].slice(0, 3);
            if (lines.length === 0)
                return [];
            if (lines.length < 3)
                lines.push("↳ Alt+Up to edit all queued messages");
            return lines.map((text) => fit(theme.fg("dim", text), width));
        },
        invalidate() { },
    };
}
//# sourceMappingURL=chrome.js.map