// Paste chips and image attachments (docs/tui-design.md 4.3's "粘贴标签和预览浮窗" table).
//
// Pi's own `Editor` (pi-tui components/editor.ts) already folds a big paste into an atomic
// `[paste #N +N lines]` marker (see `handlePaste`, `segmentWithMarkers`, `handleBackspace`,
// `expandPasteMarkers`), but every one of those methods -- and the `pastes`/`pasteCounter` fields
// backing them -- is declared `private` in pi-tui's shipped .d.ts, and `Editor` has no constructor
// hook to change the threshold or label. A subclass can't override a private member (tsc rejects
// it), so this wraps an `Editor` instance instead of extending it, reimplementing just the paste
// interception, chip bookkeeping and atomic backspace/expand on top of `Editor`'s public API
// (`getText`, `getLines`, `getCursor`, `insertTextAtCursor`, `handleInput`, `render`, `handleMouse`).
//
// Because the wrapper's chip marker text (`[Pasted: N lines]`, `[Image #N]`) is inserted verbatim
// into the inner editor's buffer, `render()` needs no translation step: what's stored is exactly
// what's displayed, and Pi's own word-wrap/cursor-highlight code runs unmodified over it.
//
// Pi's own per-grapheme atomicity lives in the private `segment()` override, unreachable from
// here, so arrow keys, word/Home/End jumps and a single click all move the caret with no idea a
// chip is meant to be one unit. `snapOutOfChipSpan` corrects that after every such move: if the
// caret landed strictly inside a span, it's stepped the rest of the way to whichever boundary the
// move was heading toward. This matters beyond looks -- a caret resting mid-span and then typing
// there would break the marker's regex match, which shifts every later chip's index in
// `textChips`/`imageChips` and misattributes their content on submit. History recall (Editor's own
// Up/Down, entirely inside its private navigateHistory) is likewise unreachable from here; it's
// harmless because history entries are always plain, already-expanded text (chips are resolved
// before addToHistory() is ever called) -- except for the edge case of pasting a new chip while an
// unsubmitted draft chip sits mid-buffer and then arrowing through history and back, which can
// misindex `textChips`. `resolveForSubmit`'s literal-label fallback keeps that safe, not silent.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piTui } from "./pi-tui.js";
// Pi's magic-number sniffer (utils/mime.js) isn't part of the public API; loaded the same way
// key-handlers.ts loads Pi's clipboard readers. Used synchronously inside handlePaste, so it's
// resolved once at module load rather than per paste.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { detectSupportedImageMimeType } = (await import(pathToFileURL(join(piDist, "utils", "mime.js")).href));
export const MIN_PASTE_LINES = 4;
export const MAX_PASTE_BYTES = 10 * 1024;
const TEXT_CHIP_SOURCE = String.raw `\[Pasted: (?:\d+ lines|\d+(?:\.\d+)? KB)\]`;
const IMAGE_CHIP_SOURCE = String.raw `\[Image #(\d+)\]`;
const CHIP_REGEX_G = new RegExp(`${TEXT_CHIP_SOURCE}|${IMAGE_CHIP_SOURCE}`, "g");
const TEXT_CHIP_REGEX_G = new RegExp(TEXT_CHIP_SOURCE, "g");
const IMAGE_CHIP_REGEX_G = new RegExp(IMAGE_CHIP_SOURCE, "g");
const IMAGE_CHIP_SINGLE = new RegExp(`^${IMAGE_CHIP_SOURCE}$`);
const LEFT_ARROW = "\x1b[D";
const RIGHT_ARROW = "\x1b[C";
const BACKSPACE = "\x7f";
/** A single trailing newline is the terminator of the pasted text's last line, not an extra empty
 * line after it -- grok's own line count agrees (a paste ending in "\n" with 40 real lines shows
 * "40 lines", not 41). Used both for the chip label's count and the preview popup's line list, so
 * the two never disagree. Only ONE trailing newline is dropped; a genuine blank line before it
 * (two or more trailing newlines) still counts. */
export function dropTrailingNewline(text) {
    return text.endsWith("\n") ? text.slice(0, -1) : text;
}
/** A paste triggers a chip at >=4 lines OR >10KB (docs/tui-design.md 4.3); lines wins the label
 * when both are true, matching grok's own priority (docs/notes/research-grok-build-tui.md:323). */
export function decidePasteChip(text) {
    const lines = dropTrailingNewline(text).split("\n").length;
    const bytes = Buffer.byteLength(text, "utf8");
    if (lines < MIN_PASTE_LINES && bytes <= MAX_PASTE_BYTES)
        return undefined;
    const label = lines >= MIN_PASTE_LINES ? `[Pasted: ${lines} lines]` : `[Pasted: ${Math.round(bytes / 1024)} KB]`;
    return { label, lines, bytes };
}
/** Resolves a single-line pasted string to an existing image file's absolute path, or undefined
 * (not a path, or the file doesn't exist) -- mirrors file-arguments.ts's own `~`/relative handling. */
export function resolveImagePath(candidate, cwd) {
    if (candidate === "" || candidate.includes("\n"))
        return undefined;
    const expanded = candidate === "~" || candidate.startsWith("~/") ? join(homedir(), candidate.slice(1)) : candidate;
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    try {
        return existsSync(absolute) && statSync(absolute).isFile() ? absolute : undefined;
    }
    catch {
        return undefined;
    }
}
/** Sniffs a file's first bytes for a supported image format; undefined if it isn't one. */
export function sniffImageFile(path) {
    const bytes = readFileSync(path);
    const mimeType = detectSupportedImageMimeType(bytes.subarray(0, 4100));
    return mimeType ? { bytes, mimeType } : undefined;
}
function fit(text, width) {
    return piTui.truncateToWidth(text, Math.max(0, width), "…");
}
/**
 * Wraps pi-tui's `Editor`, adding atomic paste/image chips on top of its public API. See the
 * module comment for why this wraps instead of extending `Editor`.
 */
export class ChipEditor {
    inner;
    getCwd;
    /** Full original text of each `[Pasted: ...]` chip, ordered left-to-right/top-to-bottom to match
     * the chip regex's match order (there's no id in the label to key by -- docs/tui-design.md 4.3
     * shows none, matching grok; only `[Image #N]` chips carry a visible, and thus lookup-able, id). */
    textChips = [];
    imageChips = new Map();
    imageCounter = 0;
    /** Cursor position immediately after the most recent paste-created chip, for the "paste again to
     * expand" gesture; cleared once consumed or once another chip-aware edit happens. */
    lastPastedChip;
    isInPaste = false;
    pasteBuffer = "";
    onChange;
    /** Fired on Enter with the message expanded to full text and image chips extracted, in place of
     * Editor's own `onSubmit` (which only ever sees a single text string). */
    onSubmitImages;
    constructor(tui, theme, options) {
        this.getCwd = options.getCwd;
        this.inner = new piTui.Editor(tui, theme, options);
        this.inner.onChange = (text) => this.onChange?.(text);
        this.inner.onSubmit = (text) => this.deliverSubmit(text);
    }
    get focused() {
        return this.inner.focused;
    }
    set focused(value) {
        this.inner.focused = value;
    }
    get borderColor() {
        return this.inner.borderColor;
    }
    set borderColor(value) {
        this.inner.borderColor = value;
    }
    render(width) {
        return this.inner.render(width);
    }
    invalidate() {
        this.inner.invalidate();
    }
    getText() {
        return this.inner.getText();
    }
    getCursor() {
        return this.inner.getCursor();
    }
    addToHistory(text) {
        this.inner.addToHistory(text);
    }
    setAutocompleteProvider(provider) {
        this.inner.setAutocompleteProvider(provider);
    }
    isShowingAutocomplete() {
        return this.inner.isShowingAutocomplete();
    }
    /** Callers that put back text they just read from this same editor -- restoring a queued
     * message ahead of the current draft on Esc/Ctrl+C/Alt+Up (keys.ts, session-tree-commands.ts),
     * or the /fork editor-slot restore -- read the raw, unexpanded text (`getEditorText`, not
     * `getExpandedText`) and prepend to it, so every chip already in it is still there, unchanged.
     * Keep the registries in that case instead of wiping them (which would otherwise turn a live
     * chip into dead bracket text that can no longer expand or attach an image). A real new draft
     * (submit's `setText("")`, /new, Ctrl+G's external-editor result, an extension's setEditorText)
     * has a different chip count and correctly resets. */
    setText(text) {
        this.inner.setText(text);
        // Always ends the "just pasted" window, even when the chip registries survive below: a
        // restored queued message prepended ahead of a fresh chip shifts its line/column, so the old
        // `{line, col}` no longer points at the chip's end and must not be trusted by chipForPopup.
        this.lastPastedChip = undefined;
        if (!this.sameChipsAs(text))
            this.resetChips();
    }
    sameChipsAs(text) {
        if ([...text.matchAll(TEXT_CHIP_REGEX_G)].length !== this.textChips.length)
            return false;
        const imageIds = [...text.matchAll(IMAGE_CHIP_REGEX_G)].map((match) => Number(match[1]));
        return imageIds.length === this.imageChips.size && imageIds.every((id) => this.imageChips.has(id));
    }
    insertTextAtCursor(text) {
        this.inner.insertTextAtCursor(text);
    }
    /** Ctrl+V with text on the clipboard: goes through the same fold-or-not decision as a terminal
     * bracketed paste (docs/tui-design.md 4.3), unlike `insertTextAtCursor` (used for programmatic,
     * not-a-paste insertions, e.g. an extension's `pasteToEditor`), which never folds. */
    pasteText(text) {
        this.handlePaste(text);
    }
    /** Text chips expanded to their full content, image chips stripped out entirely (they're sent
     * as attachments, not inlined -- docs/tui-design.md 4.3's 发送 row). Non-destructive: safe to
     * call more than once before the caller decides what to do with the result (e.g. keys.ts reads
     * this and `getImageAttachments()` separately for Alt+Enter). */
    getExpandedText() {
        return this.resolveForSubmit(this.inner.getText()).text;
    }
    getImageAttachments() {
        return this.resolveForSubmit(this.inner.getText()).images;
    }
    /** Registers an image's data without inserting anything -- for a caller building the marker into
     * arbitrary text itself (Esc/Alt+Up queue restore, app.ts's restoreQueuedMessagesToEditor) ahead
     * of one `setText()` call, rather than at the current cursor. Returns the `[Image #N]` label to
     * place in that text; `setText`'s own `sameChipsAs` check sees the id already in `imageChips` and
     * keeps it, same as any other chip surviving a restore. */
    registerImage(bytes, mimeType) {
        this.imageCounter += 1;
        const id = this.imageCounter;
        const base64 = Buffer.from(bytes).toString("base64");
        const dimensions = piTui.getImageDimensions(base64, mimeType);
        this.imageChips.set(id, {
            id,
            mimeType,
            base64,
            byteLength: bytes.byteLength,
            width: dimensions?.widthPx,
            height: dimensions?.heightPx,
        });
        return `[Image #${id}]`;
    }
    /** Ctrl+V with an image on the clipboard, or an `@image`-equivalent drop: adds an `[Image #N]`
     * chip at the cursor. `bytes` are kept as-is; AgentSession resizes for the model at send time
     * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
    insertImageChip(bytes, mimeType) {
        const label = this.registerImage(bytes, mimeType);
        this.lastPastedChip = undefined;
        this.inner.insertTextAtCursor(label);
    }
    /** The chip the caret sits *on*. Image chips (no Enter-conflict -- they never expand) keep the
     * original inclusive-at-`end` span, matching the existing "popup shows right after inserting one"
     * behavior. Text chips are stricter (`start <= col < end`, excluding `end`): right after a fresh
     * paste the caret sits at `end`, and Enter there must send like grok, not expand (docs/tui-design.md
     * 4.3) -- only actually landing on the chip (arrowing back onto it, or a click, which Editor
     * positions inside/at the start of the clicked grapheme) does. Drives Enter-to-expand, the
     * footer's `Enter:expand` shortcut, and double-click. */
    chipAtCursor() {
        const cursor = this.inner.getCursor();
        const match = this.findChip(cursor.line, (start, end) => cursor.col >= start && cursor.col <= end);
        if (match === undefined)
            return undefined;
        if (cursor.col === match.end && !IMAGE_CHIP_SINGLE.test(match.text))
            return undefined;
        return this.chipInfo(cursor.line, match);
    }
    /** `chipAtCursor()`, or -- if the caret is still exactly where the most recent paste left it --
     * the chip that paste just created. For the preview popup (still shown right after pasting, per
     * the spec table) and the "paste again to expand" gesture, both of which must keep working even
     * though `chipAtCursor()` alone no longer counts that position as "on the chip". */
    chipForPopup() {
        const strict = this.chipAtCursor();
        if (strict !== undefined)
            return strict;
        const cursor = this.inner.getCursor();
        if (this.lastPastedChip?.line !== cursor.line || this.lastPastedChip.col !== cursor.col)
            return undefined;
        const match = this.findChip(cursor.line, (start, end) => cursor.col === end);
        return match && this.chipInfo(cursor.line, match);
    }
    handleInput(data) {
        if (this.isInPaste || data.includes("\x1b[200~")) {
            this.bufferPaste(data);
            return;
        }
        // Any key other than a fresh paste ends the "just pasted" window: pasting again right after
        // expands that chip (docs/tui-design.md 4.3), but arrowing away and back to the same column
        // is "cursor landed on it later", not "still fresh from the paste" -- a different popup hint.
        this.lastPastedChip = undefined;
        if (this.interceptChipKey(data))
            return;
        const before = this.inner.getCursor();
        this.inner.handleInput(data);
        this.snapOutOfChipSpan(before);
    }
    handleMouse(event) {
        // Same rule as handleInput: a deliberate interaction other than a fresh paste ends the "just
        // pasted" window (the "paste again to expand" gesture and its popup hint), so a plain click
        // that lands on a chip reads as "the caret landed on it" (spec table), not "still fresh from
        // the paste". Only "press" counts as that: wheel/move events reach this handler too (the
        // pointer merely being over the prompt while scrolling the transcript, say), and clearing on
        // those would make a paste-again gesture insert a second chip instead of expanding, right after
        // nothing more than an incidental mouse movement.
        if (event.type === "press") {
            this.lastPastedChip = undefined;
            // The autocomplete dropdown (Editor.handleMouse's own top check, which runs for every event
            // type, not just clicks) gets first refusal; if it claims the press, that result stands.
            const autocomplete = this.inner.handleMouse(event);
            if (autocomplete !== undefined)
                return autocomplete;
            if (event.button !== "left")
                return undefined;
            // Editor.handleMouse otherwise declines every press outright (it only positions the caret on
            // a "click", i.e. press+release with no movement in between) so there is no way to ask it
            // "would this land on a chip" without actually positioning the caret. Probe by feeding it a
            // synthetic click at the same coordinates -- a pure, idempotent function of (line, col), so
            // the real click that follows (whether delivered here via a capture, or via the alt-screen's
            // own unclaimed-press-then-synthesized-click path) recomputes the identical position.
            const before = this.inner.getCursor();
            this.inner.handleMouse({ ...event, type: "click", clickCount: 1 });
            const onChip = this.chipAtCursor() !== undefined;
            this.snapOutOfChipSpan(before, true);
            if (!onChip)
                return undefined; // let the alt-screen's native drag-select run instead
            // Claim the whole gesture (Editor's own "just focus" pattern) so a second click here is
            // delivered to us as a real clickCount, instead of the screen's own
            // double-click-selects-the-word-under-the-cursor behavior claiming it first -- but only when
            // the press actually lands on a chip, so ordinary prompt text keeps its drag-select.
            return { handled: true, focus: true, capture: true };
        }
        const before = this.inner.getCursor();
        const result = this.inner.handleMouse(event);
        if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
            const chip = this.chipAtCursor();
            if (chip?.kind === "text") {
                this.expandTextChip(chip);
                return { ...result, handled: true, render: true };
            }
        }
        // A genuine click always snaps to the chip's start, not "whichever boundary it was heading
        // toward" -- a click has no direction of its own (only `handleInput`'s arrow/word-jump moves
        // do), and `before` here can itself be a leftover from the press branch's own probe-and-snap
        // rather than where the caret truly was before this gesture, which would otherwise sometimes
        // read as "moving forward" and land at `end` -- exactly the position chipAtCursor() (item 2)
        // no longer treats as "on" a text chip, silently hiding the popup and Enter:expand after a
        // perfectly ordinary single click.
        this.snapOutOfChipSpan(before, event.type === "click");
        return result;
    }
    /** Editor's own cursor movement (arrows, word/Home/End jumps, a single click) has no idea our
     * chip markers are meant to be one atomic unit, so it can land the caret strictly inside one --
     * and typing there would break the marker's regex match, shifting every later chip's index in
     * `textChips`/`imageChips` and misattributing their content on submit (not merely a cosmetic
     * gap). After any such move, if the caret ended up inside a span, step it the rest of the way to
     * whichever boundary it was heading toward (nearer one) -- or, when `toStart` is set (every
     * mouse-driven call site: a click has no direction), always to the start. */
    snapOutOfChipSpan(before, toStart = false) {
        const after = this.inner.getCursor();
        if (after.line !== before.line)
            return; // a vertical move onto a chip on another line: rare, accepted gap
        const match = this.findChip(after.line, (start, end) => after.col > start && after.col < end);
        if (!match)
            return;
        const target = toStart ? match.start : after.col >= before.col ? match.end : match.start;
        this.moveCursorToColumn(after.line, target);
    }
    // ── paste interception ──────────────────────────────────────────────────
    /** Buffers a bracketed-paste sequence ourselves (mirroring Editor's own, private, buffering) so
     * we can decide chip-or-not *before* the inner editor ever applies its own (different) fold. */
    bufferPaste(data) {
        if (data.includes("\x1b[200~")) {
            this.isInPaste = true;
            this.pasteBuffer = "";
            data = data.slice(data.indexOf("\x1b[200~") + 6);
        }
        this.pasteBuffer += data;
        const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
        if (endIndex === -1)
            return;
        const content = this.pasteBuffer.slice(0, endIndex);
        const rest = this.pasteBuffer.slice(endIndex + 6);
        this.isInPaste = false;
        this.pasteBuffer = "";
        if (content.length > 0)
            this.handlePaste(content);
        if (rest.length > 0)
            this.handleInput(rest);
    }
    handlePaste(pastedText) {
        // Some terminals re-encode control bytes inside bracketed paste as CSI-u sequences; decode
        // them back (same fix as Editor's own handlePaste) so this doesn't leak "[106;5u" as text.
        const decoded = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
            const cp = Number(code);
            if (cp >= 97 && cp <= 122)
                return String.fromCharCode(cp - 96);
            if (cp >= 65 && cp <= 90)
                return String.fromCharCode(cp - 64);
            return match;
        });
        const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
        const filtered = [...normalized].filter((ch) => ch === "\n" || ch.charCodeAt(0) >= 32).join("");
        // "paste again while the just-pasted popup is shown" expands that chip instead of pasting a
        // second one (docs/tui-design.md 4.3); consumed either way so a third paste behaves normally.
        const cursor = this.inner.getCursor();
        const justPasted = this.lastPastedChip;
        this.lastPastedChip = undefined;
        if (justPasted && justPasted.line === cursor.line && justPasted.col === cursor.col) {
            // The caret sits right at the chip's end here (that's what "just pasted" means), which
            // chipAtCursor() alone no longer treats as "on the chip" for text (docs/tui-design.md 4.3's
            // Enter row) -- match inclusively instead. Can't reuse chipForPopup(): it reads
            // this.lastPastedChip, which was just cleared above (`justPasted` is the local copy).
            const match = this.findChip(cursor.line, (start, end) => cursor.col === end);
            const chip = match && this.chipInfo(cursor.line, match);
            if (chip?.kind === "text") {
                this.expandTextChip(chip);
                return;
            }
        }
        if (!filtered.includes("\n")) {
            const path = resolveImagePath(filtered.trim(), this.getCwd());
            const sniffed = path && sniffImageFile(path);
            if (sniffed) {
                this.insertImageChip(sniffed.bytes, sniffed.mimeType);
                return;
            }
        }
        const decision = decidePasteChip(filtered);
        if (decision === undefined) {
            this.inner.insertTextAtCursor(filtered);
            return;
        }
        const index = this.textChipCountBefore(cursor.line, cursor.col);
        this.textChips.splice(index, 0, filtered);
        this.inner.insertTextAtCursor(decision.label);
        const after = this.inner.getCursor();
        this.lastPastedChip = { line: after.line, col: after.col };
    }
    // ── chip-aware keys ─────────────────────────────────────────────────────
    interceptChipKey(data) {
        const kb = piTui.getKeybindings();
        if (kb.matches(data, "tui.input.submit")) {
            const chip = this.chipAtCursor();
            if (chip?.kind === "text") {
                this.expandTextChip(chip);
                return true;
            }
            return false; // idle cursor, or on an image chip: Enter submits as usual
        }
        if (kb.matches(data, "tui.editor.deleteCharBackward")) {
            const cursor = this.inner.getCursor();
            // Backspace deletes the whole chip when it would otherwise land inside/at its end.
            const match = this.findChip(cursor.line, (start, end) => cursor.col > start && cursor.col <= end);
            if (match) {
                this.deleteChipSpan(cursor.line, match);
                return true;
            }
        }
        return false;
    }
    deleteChipSpan(line, match) {
        this.moveCursorToColumn(line, match.end);
        this.deleteBackward(match.end - match.start);
        const imageId = IMAGE_CHIP_SINGLE.exec(match.text)?.[1];
        if (imageId !== undefined) {
            this.imageChips.delete(Number(imageId));
        }
        else {
            this.textChips.splice(this.textChipCountBefore(line, match.start), 1);
        }
        this.lastPastedChip = undefined;
    }
    expandTextChip(chip) {
        const cursor = this.inner.getCursor();
        this.moveCursorToColumn(cursor.line, chip.end);
        this.deleteBackward(chip.end - chip.start);
        this.textChips.splice(this.textChipCountBefore(cursor.line, chip.start), 1);
        this.inner.insertTextAtCursor(chip.content);
        this.lastPastedChip = undefined;
    }
    /** Steps the caret to `col` on the current line via synthetic arrow keys -- the only way to
     * reposition it without `setText()`'s side effect of jumping to the end of the whole buffer. */
    moveCursorToColumn(line, col) {
        const current = this.inner.getCursor();
        if (current.line !== line)
            return;
        const key = col > current.col ? RIGHT_ARROW : LEFT_ARROW;
        for (let i = 0; i < Math.abs(col - current.col); i += 1)
            this.inner.handleInput(key);
    }
    deleteBackward(count) {
        for (let i = 0; i < count; i += 1)
            this.inner.handleInput(BACKSPACE);
    }
    // ── chip lookup ─────────────────────────────────────────────────────────
    /** Matches against `line`'s own text only. `contains` is fed `(start, end)` columns *within that
     * line*, matching `inner.getCursor().col`/`moveCursorToColumn`'s coordinate space -- unlike
     * `lineText(line)` (all previous lines joined + this one), whose match indices are offsets into
     * the whole concatenation and were being compared against a same-line column (the bug this
     * replaces: a chip on any line but the first always missed, or matched the wrong span, once a
     * doc had more than one line). `textChipCountBefore` below still needs `lineText`'s document-wide
     * prefix -- that one's correct as is. */
    findChip(line, contains) {
        const text = this.inner.getText().split("\n")[line] ?? "";
        for (const match of text.matchAll(CHIP_REGEX_G)) {
            const start = match.index ?? 0;
            const end = start + match[0].length;
            if (contains(start, end))
                return { text: match[0], start, end };
        }
        return undefined;
    }
    chipInfo(line, match) {
        const imageId = IMAGE_CHIP_SINGLE.exec(match.text)?.[1];
        if (imageId !== undefined) {
            const image = this.imageChips.get(Number(imageId));
            if (!image)
                return undefined;
            return { kind: "image", label: match.text, start: match.start, end: match.end, justPasted: false, image };
        }
        const index = this.textChipCountBefore(line, match.start);
        // A desynced registry (see the module comment) falls back to the literal label rather than
        // throwing: the popup shows the label as its own content instead of the original text.
        const content = this.textChips[index] ?? match.text;
        const justPasted = this.lastPastedChip?.line === line && this.lastPastedChip.col === match.end;
        return { kind: "text", label: match.text, start: match.start, end: match.end, justPasted, content };
    }
    /** How many `[Pasted: ...]` chips appear before (line, col) -- the index into `textChips`,
     * since chip labels carry no id and are only distinguishable by document order. */
    textChipCountBefore(line, col) {
        const prefix = this.lineText(line, col);
        return [...prefix.matchAll(TEXT_CHIP_REGEX_G)].length;
    }
    lineText(line, upToCol) {
        const lines = this.inner.getText().split("\n");
        const before = lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "");
        const current = lines[line] ?? "";
        return before + (upToCol === undefined ? current : current.slice(0, upToCol));
    }
    resolveForSubmit(rawText) {
        const images = [];
        let textIndex = 0;
        const text = rawText.replace(CHIP_REGEX_G, (match) => {
            const imageId = IMAGE_CHIP_SINGLE.exec(match)?.[1];
            if (imageId !== undefined) {
                const meta = this.imageChips.get(Number(imageId));
                if (meta)
                    images.push({ type: "image", data: meta.base64, mimeType: meta.mimeType });
                return "";
            }
            const content = this.textChips[textIndex];
            textIndex += 1;
            return content ?? match;
        });
        return { text, images };
    }
    deliverSubmit(rawText) {
        const { text, images } = this.resolveForSubmit(rawText);
        this.resetChips();
        this.onSubmitImages?.(text, images);
    }
    resetChips() {
        this.textChips = [];
        this.imageChips.clear();
        this.lastPastedChip = undefined;
    }
}
export function fitPopupLine(text, width) {
    return fit(text, width);
}
//# sourceMappingURL=paste-chips.js.map