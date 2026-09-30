// Paste chips and image attachments (docs/tui-design.md 4.3's "粘贴标签和预览浮窗" table).
//
// Pi's own `Editor` (pi-tui components/editor.ts) already folds a big paste into an atomic
// `[paste #N +N lines]` marker (see `handlePaste`, `segmentWithMarkers`, `handleBackspace`,
// `expandPasteMarkers`), but every one of those methods -- and the `pastes`/`pasteCounter` fields
// backing them -- is declared `private` in pi-tui's shipped .d.ts, and `Editor` has no constructor
// hook to change the threshold or label. A subclass can't override a private member (tsc rejects
// it), so this wraps an `Editor` instance instead of extending it, reimplementing just the paste
// interception, chip bookkeeping and atomic delete/expand on top of `Editor`'s public API
// (`getText`, `getCursor`, `insertTextAtCursor`, `setText`, `handleInput`, `render`, `handleMouse`)
// plus one private field, `state` (see "Chip registry" below).
//
// Because the wrapper's chip marker text (`[Pasted: N lines]`, `[Image #N]`) is inserted verbatim
// into the inner editor's buffer, `render()` needs no translation step: what's stored is exactly
// what's displayed, and Pi's own word-wrap/cursor-highlight code runs unmodified over it.
//
// Chip registry. A `[Pasted: N lines]` label carries no id, so its content is found by position:
// `slots[i]` belongs to the i-th text-chip label in the document, and is a content id (a key into
// `textContents`) or `null` for label-shaped text that has no content (typed by hand, yanked back
// from the kill ring, part of an expanded paste). Invariant, checked after every edit: `slots` has
// exactly one entry per text-chip label, in document order, and a non-null entry's content was
// pasted under that very label -- so no label ever resolves to another chip's content.
// `[Image #N]` labels carry their id; image data stays in `imageChips` until the draft is sent,
// and ids are never reused within a draft (a new id is above every id the draft has seen), so a
// label deleted and brought back by undo resolves to its own image.
//
// How `slots` follows edits:
// - Undo and history. pi-tui's `pushUndoSnapshot()` structuredClones `Editor.state` onto its undo
//   stack, `undo()` Object.assigns the popped clone back onto `state`, and `navigateHistory()`
//   clones `state` into `historyDraft` on the way into history and reinstalls it with
//   `this.state = draft` on the way out. `slots` is stored on that same object
//   (`state.mmpTextChips`), so every one of those paths restores the registry exactly as it was
//   for that text, with no bookkeeping of our own. `sync()` recognises a restore by the array's
//   identity (Pi's copy is a clone, never the array we last wrote).
// - Every other edit (typing, Pi's deletes and kills, yank, setText): `carryOver()` diffs the
//   previous text against the new one around the caret; a label wholly outside the changed range
//   keeps its slot, one inside it is gone, and a new one is contentless. A recalled history entry
//   replaces the draft, so every label in it is contentless.
// - A delete key that removes only part of a label (Backspace at a chip's end, Ctrl+W after
//   "[A] ", Alt+D before " [A]") would leave a fragment like "[Pasted: 4 lines";
//   `removeChipFragments()` deletes the rest, so a partially covered chip is fully deleted.
//
// Pi's own per-grapheme atomicity lives in the private `segment()` override, unreachable from
// here, so arrow keys, word/Home/End jumps and a single click all move the caret with no idea a
// chip is meant to be one unit. `snapOutOfChipSpan` corrects that after every such move: if the
// caret landed strictly inside a span, it's stepped the rest of the way to whichever boundary the
// move was heading toward, so typing never lands mid-label.
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
const IMAGE_CHIP_SINGLE = new RegExp(`^${IMAGE_CHIP_SOURCE}$`);
const LEFT_ARROW = "\x1b[D";
const RIGHT_ARROW = "\x1b[C";
const BACKSPACE = "\x7f";
const FORWARD_DELETE = "\x1b[3~";
/** Pi's keys that delete text; any of them can cut a chip label in two. */
const DELETE_ACTIONS = [
    "tui.editor.deleteCharBackward",
    "tui.editor.deleteCharForward",
    "tui.editor.deleteWordBackward",
    "tui.editor.deleteWordForward",
    "tui.editor.deleteToLineStart",
    "tui.editor.deleteToLineEnd",
];
/** Pi's keys that can swap the draft for a history entry (Editor.navigateHistory). */
const HISTORY_ACTIONS = ["tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.historyPrevious", "tui.editor.historyNext"];
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
function chipMatches(text, regex) {
    return [...text.matchAll(regex)].map((match) => {
        const start = match.index ?? 0;
        return { text: match[0], start, end: start + match[0].length };
    });
}
function cursorOffset(text, cursor) {
    const lines = text.split("\n");
    let offset = 0;
    for (let line = 0; line < cursor.line; line += 1)
        offset += (lines[line]?.length ?? 0) + 1;
    return offset + cursor.col;
}
/** Aligns `before` and `after` as one contiguous edit: `prefix` characters at the start and
 * `suffix` at the end are unchanged. When that split is ambiguous (deleting one of two identical
 * labels "[A][A]" -> "[A]"), the prefix is cut at the caret, where the edit happened. */
function alignEdit(before, beforeCursor, after, afterCursor) {
    const shorter = Math.min(before.length, after.length);
    let maxPrefix = 0;
    while (maxPrefix < shorter && before[maxPrefix] === after[maxPrefix])
        maxPrefix += 1;
    let maxSuffix = 0;
    while (maxSuffix < shorter && before[before.length - 1 - maxSuffix] === after[after.length - 1 - maxSuffix])
        maxSuffix += 1;
    if (maxPrefix + maxSuffix <= shorter)
        return { prefix: maxPrefix, suffix: maxSuffix };
    const prefix = Math.max(shorter - maxSuffix, Math.min(maxPrefix, beforeCursor, afterCursor));
    return { prefix, suffix: shorter - prefix };
}
/**
 * Wraps pi-tui's `Editor`, adding atomic paste/image chips on top of its public API. See the
 * module comment for why this wraps instead of extending `Editor`, and how the chip registry works.
 */
export class ChipEditor {
    inner;
    getCwd;
    getSentImageCount;
    lastImageId = 0;
    /** Content of every text chip pasted into this draft, by content id; see the module comment. */
    textContents = new Map();
    textContentCounter = 0;
    imageChips = new Map();
    /** The text, caret offset and slots as of the last `sync()`. */
    synced = { text: "", cursor: 0, slots: [] };
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
        this.getSentImageCount = options.getSentImageCount ?? (() => this.lastImageId);
        this.inner = new piTui.Editor(tui, theme, options);
        this.inner.onChange = (text) => this.onChange?.(text);
        this.inner.onSubmit = (text) => this.deliverSubmit(text);
        this.sync();
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
    /** Replaces the whole draft. Chips in the part of the text that didn't change keep their content
     * -- restoring a queued message ahead of the current draft on Esc/Ctrl+C/Alt+Up (keys.ts,
     * session-tree-commands.ts) or the /fork editor-slot restore prepends to the raw, unexpanded text
     * (`getText`, not `getExpandedText`), so every chip already in it survives. Pi's `setText` pushes
     * an undo snapshot, so Ctrl+- after /new or Ctrl+G brings back the old draft with its chips. */
    setText(text) {
        this.inner.setText(text);
        this.sync();
        // A restored queued message prepended ahead of a fresh chip shifts its line/column, so the old
        // `{line, col}` no longer points at the chip's end and must not be trusted by chipForPopup.
        this.lastPastedChip = undefined;
    }
    insertTextAtCursor(text) {
        this.inner.insertTextAtCursor(text);
        this.sync();
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
        return this.resolveForSubmit(this.inner.getText(), this.synced.slots).text;
    }
    getImageAttachments() {
        return this.resolveForSubmit(this.inner.getText(), this.synced.slots).images;
    }
    /** Registers an image's data without inserting anything -- for a caller building the marker into
     * arbitrary text itself (Esc/Alt+Up queue restore, app.ts's restoreQueuedMessagesToEditor) ahead
     * of one `setText()` call, rather than at the current cursor. Returns the `[Image #N]` label to
     * place in that text. `preferredId` (queue restore: the number the image had when it was sent)
     * is used when the draft hasn't seen that id. */
    registerImage(bytes, mimeType, preferredId) {
        const id = preferredId !== undefined && !this.imageChips.has(preferredId)
            ? preferredId
            : Math.max(this.getSentImageCount(), ...this.imageChips.keys()) + 1;
        this.lastImageId = id;
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
        this.insertTextAtCursor(label);
    }
    /** The chip the caret sits *on*. Two passes, so two adjacent chips (`A.end === B.start`, no
     * character between them) resolve consistently to the second one at their shared boundary instead
     * of getting stuck on the first: (1) a chip that strictly contains the caret (`start <= col <
     * end`) always wins, checked in document order, so at a shared boundary this finds B (the first
     * chip for which the boundary column is strictly `< end`) rather than A (for which it's `===
     * end`, no longer "in" it -- see below); (2) only if nothing does, an image chip's own `end` still
     * counts (no Enter-conflict, they never expand, so there's nothing to protect there) -- but never
     * a text chip's, whose `end` right after a fresh paste is deliberately not "on the chip" (item 2,
     * docs/tui-design.md 4.3): Enter there must send like grok, not expand. Drives Enter-to-expand,
     * the footer's `Enter:expand` shortcut, and double-click. */
    chipAtCursor() {
        const cursor = this.inner.getCursor();
        const inside = this.findChip(cursor.line, (start, end) => cursor.col >= start && cursor.col < end);
        if (inside !== undefined)
            return this.chipInfo(cursor.line, inside);
        const atEnd = this.findChip(cursor.line, (start, end) => cursor.col === end);
        if (atEnd !== undefined && IMAGE_CHIP_SINGLE.test(atEnd.text))
            return this.chipInfo(cursor.line, atEnd);
        return undefined;
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
        const kb = piTui.getKeybindings();
        const before = { ...this.synced, lineCol: this.inner.getCursor() };
        // A recalled history entry is unrelated text: a label in it has no content, even where it
        // happens to line up with a chip in the draft.
        const recallsHistory = HISTORY_ACTIONS.some((action) => kb.matches(data, action));
        this.innerInput(data, recallsHistory ? "replace" : "edit");
        if (DELETE_ACTIONS.some((action) => kb.matches(data, action)))
            this.removeChipFragments(before);
        this.snapOutOfChipSpan(before.lineCol);
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
            const autocomplete = this.innerMouse(event);
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
            this.innerMouse({ ...event, type: "click", clickCount: 1 });
            const onChip = this.chipAtCursor() !== undefined;
            if (!onChip) {
                // Not claiming this press: put the caret back where it was (same line only -- there's no
                // cheap way to move it back across lines without simulating arrow keys, word-wrap and all,
                // so a vertical probe is an accepted, narrower version of the same gap already documented
                // for snapOutOfChipSpan). Before this, an ordinary press on plain text silently moved the
                // caret and could exit Editor's own history-browsing (both are its private click-handling
                // side effects, not something this probe can undo) even though the gesture goes on to be
                // unclaimed and handled as drag-select/plain-click by the alt-screen instead.
                if (this.inner.getCursor().line === before.line)
                    this.moveCursorToColumn(before.line, before.col);
                return undefined; // let the alt-screen's native drag-select run instead
            }
            this.snapOutOfChipSpan(before, true);
            // Claim the whole gesture (Editor's own "just focus" pattern) so a second click here is
            // delivered to us as a real clickCount, instead of the screen's own
            // double-click-selects-the-word-under-the-cursor behavior claiming it first -- but only when
            // the press actually lands on a chip, so ordinary prompt text keeps its drag-select.
            return { handled: true, focus: true, capture: true };
        }
        const before = this.inner.getCursor();
        const result = this.innerMouse(event);
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
     * and typing there would break the label. After any such move, if the caret ended up inside a
     * span, step it the rest of the way to whichever boundary it was heading toward (nearer one) --
     * or, when `toStart` is set (every mouse-driven call site: a click has no direction), always to
     * the start. */
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
            this.insertTextAtCursor(filtered);
            return;
        }
        this.textContentCounter += 1;
        const id = this.textContentCounter;
        this.textContents.set(id, { label: decision.label, content: filtered });
        const start = cursorOffset(this.inner.getText(), cursor);
        this.insertTextAtCursor(decision.label);
        // insertTextAtCursor's sync() saw a new, contentless label at `start`; give it its content.
        const index = chipMatches(this.inner.getText(), TEXT_CHIP_REGEX_G).findIndex((match) => match.start === start);
        if (index === -1)
            throw new Error(`ChipEditor: pasted label ${decision.label} not found at offset ${start}`);
        this.synced.slots[index] = id;
        const after = this.inner.getCursor();
        this.lastPastedChip = { line: after.line, col: after.col };
    }
    // ── chip-aware keys ─────────────────────────────────────────────────────
    interceptChipKey(data) {
        if (!piTui.getKeybindings().matches(data, "tui.input.submit"))
            return false;
        const chip = this.chipAtCursor();
        if (chip?.kind !== "text")
            return false; // idle cursor, or on an image chip: Enter submits as usual
        this.expandTextChip(chip);
        return true;
    }
    /** Deletes what's left of a chip label that the edit from `before` to now only partly removed
     * (Backspace at its end, Delete at its start, Ctrl+W/Alt+D/Ctrl+U/Ctrl+K reaching into it), so a
     * partially covered chip is fully deleted. Only for a pure deletion with the caret at its start,
     * which is where every Pi delete leaves it. */
    removeChipFragments(before) {
        const { text, cursor } = this.synced;
        if (text.length >= before.text.length)
            return;
        const { prefix, suffix } = alignEdit(before.text, before.cursor, text, cursor);
        if (prefix + suffix !== text.length || cursor !== prefix)
            return;
        const deletedEnd = before.text.length - suffix;
        const chips = chipMatches(before.text, CHIP_REGEX_G);
        const cutAtStart = chips.find((chip) => chip.start < prefix && prefix < chip.end);
        const cutAtEnd = chips.find((chip) => chip.start < deletedEnd && deletedEnd < chip.end);
        if (cutAtStart)
            for (let i = cutAtStart.start; i < prefix; i += 1)
                this.innerInput(BACKSPACE);
        if (cutAtEnd)
            for (let i = deletedEnd; i < cutAtEnd.end; i += 1)
                this.innerInput(FORWARD_DELETE);
    }
    expandTextChip(chip) {
        const cursor = this.inner.getCursor();
        this.moveCursorToColumn(cursor.line, chip.end);
        for (let i = chip.start; i < chip.end; i += 1)
            this.innerInput(BACKSPACE);
        this.insertTextAtCursor(chip.content);
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
            this.innerInput(key);
    }
    // ── chip registry ───────────────────────────────────────────────────────
    /** Every call into the inner editor goes through these two, so `slots` is correct between any
     * two of Pi's undo snapshots, including between the synthetic keystrokes of one chip deletion. */
    innerInput(data, change = "edit") {
        this.inner.handleInput(data);
        this.sync(change);
    }
    innerMouse(event) {
        const result = this.inner.handleMouse(event);
        this.sync();
        return result;
    }
    editorState() {
        const state = this.inner.state;
        if (!state || !Array.isArray(state.lines) || typeof state.cursorLine !== "number" || typeof state.cursorCol !== "number") {
            throw new Error("ChipEditor: pi-tui's Editor no longer has a private `state` {lines, cursorLine, cursorCol}; the chip registry depends on it (see src/tui/paste-chips.ts)");
        }
        return state;
    }
    /** Brings `slots` up to date with the editor's text; see the module comment. `change` says
     * whether a text change (other than Pi restoring an earlier state) was an edit of the draft or
     * a replacement of it by unrelated text. */
    sync(change = "edit") {
        const state = this.editorState();
        const text = this.inner.getText();
        const cursor = cursorOffset(text, this.inner.getCursor());
        const stored = state.mmpTextChips;
        let slots;
        if (stored !== undefined && stored !== this.synced.slots) {
            slots = this.restoredSlots(text, stored) ?? this.carryOver(text, cursor);
        }
        else if (text === this.synced.text) {
            slots = this.synced.slots;
        }
        else if (change === "replace") {
            slots = chipMatches(text, TEXT_CHIP_REGEX_G).map(() => null);
        }
        else {
            slots = this.carryOver(text, cursor);
        }
        state.mmpTextChips = slots;
        this.synced = { text, cursor, slots };
    }
    /** Slots Pi put back with an earlier state (undo, leaving history). Checked chip by chip; only
     * a count mismatch, which Pi's exact restore can't produce, falls back to `carryOver`. */
    restoredSlots(text, stored) {
        const labels = chipMatches(text, TEXT_CHIP_REGEX_G);
        if (labels.length !== stored.length)
            return undefined;
        return stored.map((id, index) => (id !== null && this.textContents.get(id)?.label === labels[index]?.text ? id : null));
    }
    /** Slots for `text` after an ordinary edit from `this.synced.text`: a label wholly in the
     * unchanged prefix or suffix keeps its slot; any other label in `text` has no content. */
    carryOver(text, cursor) {
        const before = this.synced;
        const { prefix, suffix } = alignEdit(before.text, before.cursor, text, cursor);
        const shift = text.length - before.text.length;
        const kept = new Map();
        chipMatches(before.text, TEXT_CHIP_REGEX_G).forEach((match, index) => {
            const slot = before.slots[index] ?? null;
            if (match.end <= prefix)
                kept.set(match.start, { label: match.text, slot });
            else if (match.start >= before.text.length - suffix)
                kept.set(match.start + shift, { label: match.text, slot });
        });
        return chipMatches(text, TEXT_CHIP_REGEX_G).map((match) => {
            const survivor = kept.get(match.start);
            return survivor?.label === match.text ? survivor.slot : null;
        });
    }
    // ── chip lookup ─────────────────────────────────────────────────────────
    /** Matches against `line`'s own text only; `contains` is fed `(start, end)` columns within that
     * line, matching `inner.getCursor().col`/`moveCursorToColumn`'s coordinate space. */
    findChip(line, contains) {
        const text = this.inner.getText().split("\n")[line] ?? "";
        return chipMatches(text, CHIP_REGEX_G).find((match) => contains(match.start, match.end));
    }
    chipInfo(line, match) {
        const imageId = IMAGE_CHIP_SINGLE.exec(match.text)?.[1];
        if (imageId !== undefined) {
            const image = this.imageChips.get(Number(imageId));
            if (!image)
                return undefined;
            return { kind: "image", label: match.text, start: match.start, end: match.end, justPasted: false, image };
        }
        const offset = cursorOffset(this.inner.getText(), { line, col: match.start });
        const index = chipMatches(this.inner.getText().slice(0, offset), TEXT_CHIP_REGEX_G).length;
        const content = this.textContent(this.synced.slots[index], match.text) ?? match.text;
        const justPasted = this.lastPastedChip?.line === line && this.lastPastedChip.col === match.end;
        return { kind: "text", label: match.text, start: match.start, end: match.end, justPasted, content };
    }
    /** The content pasted under `label`, or undefined for a contentless slot. Checking the label
     * again here is a last safety net: a slot never resolves to content pasted under another label. */
    textContent(slot, label) {
        const entry = slot === null || slot === undefined ? undefined : this.textContents.get(slot);
        return entry?.label === label ? entry.content : undefined;
    }
    resolveForSubmit(rawText, slots) {
        const images = [];
        let textIndex = 0;
        const text = rawText.replace(CHIP_REGEX_G, (match, imageId) => {
            if (imageId !== undefined) {
                const meta = this.imageChips.get(Number(imageId));
                if (!meta)
                    return match;
                images.push({ type: "image", data: meta.base64, mimeType: meta.mimeType });
                return "";
            }
            const content = this.textContent(slots[textIndex], match);
            textIndex += 1;
            return content ?? match;
        });
        return { text, images };
    }
    /** Called from inside Pi's submitValue, before `innerInput` gets to sync(): `this.synced.slots`
     * still describes the text being sent (Pi only trims it, which never removes a label). */
    deliverSubmit(rawText) {
        const { text, images } = this.resolveForSubmit(rawText, this.synced.slots);
        this.resetChips();
        this.onSubmitImages?.(text, images);
    }
    /** Submit starts a new draft, and Pi clears its undo stack, so nothing can bring these back. */
    resetChips() {
        this.textContents.clear();
        this.imageChips.clear();
        this.synced = { text: "", cursor: 0, slots: [] };
        this.lastPastedChip = undefined;
    }
}
export function fitPopupLine(text, width) {
    return fit(text, width);
}
//# sourceMappingURL=paste-chips.js.map