// grok-build chrome (docs/tui-design.md 4.1, grok notes 2.1-2.2): header bar, user message block,
// turn status row, framed prompt, shortcuts bar. Pure render functions of the state they are given.
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import { imageLabelNumbers } from "./paste-chips.js";
import { piTui } from "./pi-tui.js";
const { truncateToWidth, visibleWidth } = piTui;
/** Shared with assistant-block.ts (the assistant-message timestamp reuses this row layout). */
export function fit(text, width) {
    return truncateToWidth(text, Math.max(0, width), "…");
}
/** Left and right segments on one row; the left side is truncated first. */
/** Columns kept free for a message's time on every row ("12:00 PM"), so text wraps at the same place
 * whatever the time reads; a longer locale string widens it. */
export function clockColumns(clock) {
    return Math.max(8, visibleWidth(clock));
}
export function spread(left, right, width) {
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
/** Shared with transcript.ts (turn footer) and assistant-block.ts (thinking duration). */
export function formatDuration(ms) {
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
// The notes Pi appends to a prompt's text after the user's own words when it resizes or converts an
// image (utils/image-resize.js's formatDimensionNote, utils/image-process.js's conversionHint;
// docs/pi-internals.md `image-hint-wording`). The model still gets them; the transcript hides them
// (D9). `[Image omitted: ...]` failure notes are not listed here on purpose: failures stay visible.
const IMAGE_HINT_LINE = /^\[(?:Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.|Image converted from [^\s\]]+ to [^\s\]]+\.)\]$/;
const IMAGE_OMITTED_LINE = /^\[Image omitted: [^\]]*\]$/;
/** Drops Pi's resize/convert notes from the block of note lines at the end of `text` (Pi appends
 * them per image, in order, after a blank line); `[Image omitted: ...]` lines in that block stay. */
export function withoutImageHints(text) {
    const lines = text.trimEnd().split("\n");
    let start = lines.length;
    while (start > 0 && (IMAGE_HINT_LINE.test(lines[start - 1] ?? "") || IMAGE_OMITTED_LINE.test(lines[start - 1] ?? "")))
        start -= 1;
    const tail = lines.slice(start);
    if (!tail.some((line) => IMAGE_HINT_LINE.test(line)))
        return text;
    return [...lines.slice(0, start), ...tail.filter((line) => !IMAGE_HINT_LINE.test(line))].join("\n").trimEnd();
}
const FILE_BLOCK_RE = /<file name="([^"]*)">[\s\S]*?<\/file>\n?/g;
/** The text parts of a user message's content, joined. */
export function messageText(content) {
    return typeof content === "string"
        ? content
        : Array.isArray(content)
            ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
            : "";
}
/** A user message's own display text: `<file name="...">...</file>` blocks (file-arguments.ts's
 * `@file` inlining) collapse to `[File: name]` and Pi's image notes are hidden (D9); this only
 * affects what's drawn in the transcript (item 5, docs/tui-design.md 4.3's 发送 row). An image
 * sent from the editor already has its `[Image #N]` label in the text, which the model sees too
 * (D11). Image parts beyond the text's labels (an extension's `sendUserMessage`, the `@pic.png`
 * startup message, sessions from before D11) show as `[Image]`, unnumbered; a label written twice
 * counts once, as in paste-chips.ts's labelStoredImages (D36). */
function displayText(content) {
    const text = messageText(content);
    const imageCount = Array.isArray(content) ? content.filter((part) => part?.type === "image").length : 0;
    const withFileChips = (imageCount > 0 ? withoutImageHints(text) : text).replace(FILE_BLOCK_RE, (_match, name) => `[File: ${basename(name)}]\n`).trim();
    const unlabelled = Math.max(0, imageCount - new Set(imageLabelNumbers(withFileChips)).size);
    const images = Array.from({ length: unlabelled }, () => "[Image]").join(" ");
    return [withFileChips, images].filter((part) => part !== "").join("\n");
}
const COLLAPSED_LINES = 3;
/** A line holding nothing but `[Image #N]` / `[Image]` / `[File: name]` chips (image labels and
 * what displayText() emits for unlabelled images and `@file` blocks). */
const CHIP_ONLY_LINE = /^\s*(?:\[(?:Image(?: #\d+)?|File: [^\]\n]*)\]\s*)+$/;
/** Cuts the text after its `COLLAPSED_LINES`-th logical line and appends `…`. Chip-only lines don't
 * count toward the limit: three `@file` arguments plus a one-line question must still show the
 * question. */
function collapseUserText(text) {
    const lines = text.split("\n");
    let counted = 0;
    for (let index = 0; index < lines.length; index += 1) {
        if (CHIP_ONLY_LINE.test(lines[index] ?? ""))
            continue;
        counted += 1;
        if (counted > COLLAPSED_LINES)
            return [...lines.slice(0, index), "…"].join("\n");
    }
    return text;
}
// OSC 133 semantic-prompt zones, marked the way Pi's user-message.js (L39-46) and
// assistant-message.js (L60-68) mark theirs: TuiAltScreen.scrollToPrompt (Ctrl+Up/Down) stops on
// rows that start with the A marker, and the layout strips these prefixes before painting a row.
const PROMPT_ZONE_START = "\x1b]133;A\x07";
const PROMPT_ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
const PROMPT_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
/** Wraps a rendered block in a prompt zone (a no-op for an empty one, as in Pi). */
export function markPromptZone(lines) {
    if (lines.length === 0)
        return lines;
    const marked = [...lines];
    marked[0] = PROMPT_ZONE_START + marked[0];
    marked[marked.length - 1] = PROMPT_ZONE_END + marked[marked.length - 1];
    return marked;
}
/** A row's leading zone markers, and the rest of it. */
export function splitPromptZone(line) {
    const marker = PROMPT_ZONE_PREFIX.exec(line)?.[0] ?? "";
    return { marker, rest: line.slice(marker.length) };
}
/** Full-width `userMessageBg` block with one row of padding, `❯ text` and the time on the right.
 * Collapses past `COLLAPSED_LINES` *logical* lines (not wrapped rows) to `…` -- observed in grok
 * 1.0.44 (docs/tui-design.md 4.2/4.3): a sent 12-line paste renders as its first 3 lines then `…`.
 * Counting logical lines, not wrapped rows, means a single long line never collapses just because a
 * narrow terminal wraps it into more than 3 screen rows. Expanded back with Ctrl+O -- the same
 * toggle that expands tool output (item 5). */
export class UserMessageBlock {
    theme;
    time;
    text;
    expanded = false;
    constructor(theme, content, time) {
        this.theme = theme;
        this.time = time;
        this.text = displayText(content);
    }
    setExpanded(expanded) {
        this.expanded = expanded;
    }
    render(width) {
        const paint = (content) => this.theme.bg("userMessageBg", content + " ".repeat(Math.max(0, width - visibleWidth(content))));
        const clock = this.theme.fg("muted", this.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
        const bodyWidth = Math.max(1, width - 4 - clockColumns(clock) - 3);
        const source = this.expanded ? this.text : collapseUserText(this.text);
        const lines = piTui.wrapTextWithAnsi(source, bodyWidth);
        const rows = lines.map((text, index) => {
            const prefix = index === 0 ? `${this.theme.fg("muted", "❯")} ` : "  ";
            const left = `  ${prefix}${this.theme.fg("userMessageText", text)}`;
            return index === 0 ? spread(left, `${clock}  `, width) : fit(left, width);
        });
        return markPromptZone([paint(""), ...rows.map(paint), paint("")]);
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
/** Item 4 (docs/tui-design.md 4.1/4.2): at ≤12 rows, crop the editor's content down to the row
 * holding the cursor (its reverse-video marker, same as the Editor itself emits it) instead of an
 * arbitrary window -- the point of the cap is to keep editing visible, not just short. Falls back to
 * the last row (unfocused editors don't mark a cursor at all) so this never returns nothing. Returns
 * the window's bounds, not just the cropped slice, so `handleMouse()` can shift a click's `y` by the
 * same `start` offset `render()` cropped by -- otherwise a click lands on the row it would be at
 * without the crop, not the one actually drawn on screen. */
function cropWindow(lines, maxRows) {
    if (lines.length <= maxRows)
        return { start: 0, end: lines.length };
    const cursorIndex = lines.findIndex((line) => line.includes("\x1b[7m"));
    const end = Math.min(lines.length, Math.max(maxRows, (cursorIndex === -1 ? lines.length - 1 : cursorIndex) + 1));
    return { start: end - maxRows, end };
}
function cropToCursor(lines, maxRows) {
    const { start, end } = cropWindow(lines, maxRows);
    return lines.slice(start, end);
}
export class PromptFrame {
    theme;
    editor;
    label;
    borderColor;
    maxContentRows;
    constructor(theme, editor, label, borderColor, maxContentRows = () => undefined) {
        this.theme = theme;
        this.editor = editor;
        this.label = label;
        this.borderColor = borderColor;
        this.maxContentRows = maxContentRows;
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
        const maxRows = this.maxContentRows();
        const content = maxRows === undefined ? lines.slice(top + 1, bottom) : cropToCursor(lines.slice(top + 1, bottom), maxRows);
        content.forEach((line, index) => {
            const prompt = index === 0 ? this.theme.fg("muted", "❯ ") : "  ";
            const padded = line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
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
     * border or the autocomplete dropdown below it are left unhandled, matching prior behavior. At the
     * ≤12-row cap (`maxContentRows`), a click's `y` is shifted by the same crop-window offset
     * `render()` used, so a double-click on a chip on a row *within the drawn window* still lands on
     * the right line of the editor's own (uncropped) content -- a click on a screen position outside
     * the drawn window can't occur in practice (nothing else is drawn there) but is also harmless: it
     * maps past the editor's real content and simply falls through unhandled below. */
    handleMouse(event) {
        const inner = Math.max(1, event.width - 6);
        const { lines, top, bottom } = this.contentBounds(inner);
        if (top === -1 || bottom === -1)
            return undefined;
        const contentHeight = bottom - top - 1;
        if (event.y < 1 || event.y > contentHeight)
            return undefined;
        const x = event.x - PROMPT_COLUMNS;
        if (x < 0 || x >= inner)
            return undefined;
        const maxRows = this.maxContentRows();
        const offset = maxRows === undefined ? 0 : cropWindow(lines.slice(top + 1, bottom), maxRows).start;
        return this.editor.handleMouse?.({ ...event, x, y: event.y + offset, width: inner, height: contentHeight });
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