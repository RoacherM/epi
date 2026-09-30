import type { ImageContent } from "@earendil-works/pi-ai";
import type { AutocompleteProvider, EditorOptions, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
export declare const MIN_PASTE_LINES = 4;
export declare const MAX_PASTE_BYTES: number;
export interface ImageChipMeta {
    id: number;
    mimeType: string;
    base64: string;
    byteLength: number;
    width: number | undefined;
    height: number | undefined;
}
export type ChipInfo = {
    kind: "text";
    label: string;
    start: number;
    end: number;
    justPasted: boolean;
    content: string;
} | {
    kind: "image";
    label: string;
    start: number;
    end: number;
    justPasted: boolean;
    image: ImageChipMeta;
};
/** A single trailing newline is the terminator of the pasted text's last line, not an extra empty
 * line after it -- grok's own line count agrees (a paste ending in "\n" with 40 real lines shows
 * "40 lines", not 41). Used both for the chip label's count and the preview popup's line list, so
 * the two never disagree. Only ONE trailing newline is dropped; a genuine blank line before it
 * (two or more trailing newlines) still counts. */
export declare function dropTrailingNewline(text: string): string;
/** A paste triggers a chip at >=4 lines OR >10KB (docs/tui-design.md 4.3); lines wins the label
 * when both are true, matching grok's own priority (docs/notes/research-grok-build-tui.md:323). */
export declare function decidePasteChip(text: string): {
    label: string;
    lines: number;
    bytes: number;
} | undefined;
/** Resolves a single-line pasted string to an existing image file's absolute path, or undefined
 * (not a path, or the file doesn't exist) -- mirrors file-arguments.ts's own `~`/relative handling. */
export declare function resolveImagePath(candidate: string, cwd: string): string | undefined;
/** Sniffs a file's first bytes for a supported image format; undefined if it isn't one. */
export declare function sniffImageFile(path: string): {
    bytes: Buffer;
    mimeType: string;
} | undefined;
/** The `[Image #N]` number the chip had that an attachment from `getImageAttachments()` (or a
 * submit) came from; undefined for any other image. */
export declare function imageChipNumber(image: ImageContent): number | undefined;
interface ChipEditorOptions extends EditorOptions {
    /** Read live so an image path pasted after /resume resolves against the new session's cwd. */
    getCwd: () => string;
    /** The highest `[Image #N]` number in use in the session (shown in the transcript or reserved by
     * a queued message): a new chip is numbered above it, so the label in the editor is the one the
     * transcript shows once the message is sent. Read live; without it the editor keeps counting up
     * from its own last chip. */
    getHighestImageNumber?: () => number;
}
/**
 * Wraps pi-tui's `Editor`, adding atomic paste/image chips on top of its public API. See the
 * module comment for why this wraps instead of extending `Editor`, and how the chip registry works.
 */
export declare class ChipEditor {
    private readonly inner;
    private readonly getCwd;
    private readonly getHighestImageNumber;
    private lastImageId;
    /** Content of every text chip pasted into this draft, by content id; see the module comment. */
    private textContents;
    private textContentCounter;
    private imageChips;
    /** The text, caret offset and slots as of the last `sync()`. */
    private synced;
    /** Cursor position immediately after the most recent paste-created chip, for the "paste again to
     * expand" gesture; cleared once consumed or once another chip-aware edit happens. */
    private lastPastedChip;
    private isInPaste;
    private pasteBuffer;
    onChange?: (text: string) => void;
    /** Fired on Enter with the message expanded to full text and image chips extracted, in place of
     * Editor's own `onSubmit` (which only ever sees a single text string). */
    onSubmitImages?: (text: string, images: ImageContent[]) => void;
    constructor(tui: TUI, theme: EditorTheme, options: ChipEditorOptions);
    get focused(): boolean;
    set focused(value: boolean);
    get borderColor(): (text: string) => string;
    set borderColor(value: (text: string) => string);
    render(width: number): string[];
    invalidate(): void;
    getText(): string;
    getCursor(): {
        line: number;
        col: number;
    };
    addToHistory(text: string): void;
    setAutocompleteProvider(provider: AutocompleteProvider): void;
    isShowingAutocomplete(): boolean;
    /** Replaces the whole draft. Chips in the part of the text that didn't change keep their content
     * -- restoring a queued message ahead of the current draft on Esc/Ctrl+C/Alt+Up (keys.ts,
     * session-tree-commands.ts) or the /fork editor-slot restore prepends to the raw, unexpanded text
     * (`getText`, not `getExpandedText`), so every chip already in it survives. Pi's `setText` pushes
     * an undo snapshot, so Ctrl+- after /new or Ctrl+G brings back the old draft with its chips. */
    setText(text: string): void;
    insertTextAtCursor(text: string): void;
    /** Ctrl+V with text on the clipboard: goes through the same fold-or-not decision as a terminal
     * bracketed paste (docs/tui-design.md 4.3), unlike `insertTextAtCursor` (used for programmatic,
     * not-a-paste insertions, e.g. an extension's `pasteToEditor`), which never folds. */
    pasteText(text: string): void;
    /** Text chips expanded to their full content, image chips stripped out entirely (they're sent
     * as attachments, not inlined -- docs/tui-design.md 4.3's 发送 row). Non-destructive: safe to
     * call more than once before the caller decides what to do with the result (e.g. keys.ts reads
     * this and `getImageAttachments()` separately for Alt+Enter). */
    getExpandedText(): string;
    getImageAttachments(): ImageContent[];
    /** Registers an image's data without inserting anything -- for a caller building the marker into
     * arbitrary text itself (Esc/Alt+Up queue restore, app.ts's restoreQueuedMessagesToEditor) ahead
     * of one `setText()` call, rather than at the current cursor. Returns the `[Image #N]` label to
     * place in that text. `preferredId` (queue restore: the number the image had when it was sent)
     * is used unless the draft holds a different image under that id. */
    registerImage(bytes: Uint8Array, mimeType: string, preferredId?: number): string;
    /** Ctrl+V with an image on the clipboard, or an `@image`-equivalent drop: adds an `[Image #N]`
     * chip at the cursor. `bytes` are kept as-is; AgentSession resizes for the model at send time
     * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
    insertImageChip(bytes: Uint8Array, mimeType: string): void;
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
    chipAtCursor(): ChipInfo | undefined;
    /** `chipAtCursor()`, or -- if the caret is still exactly where the most recent paste left it --
     * the chip that paste just created. For the preview popup (still shown right after pasting, per
     * the spec table) and the "paste again to expand" gesture, both of which must keep working even
     * though `chipAtCursor()` alone no longer counts that position as "on the chip". */
    chipForPopup(): ChipInfo | undefined;
    handleInput(data: string): void;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    /** Editor's own cursor movement (arrows, word/Home/End jumps, a single click) has no idea our
     * chip markers are meant to be one atomic unit, so it can land the caret strictly inside one --
     * and typing there would break the label. After any such move, if the caret ended up inside a
     * span, step it the rest of the way to whichever boundary it was heading toward (nearer one) --
     * or, when `toStart` is set (every mouse-driven call site: a click has no direction), always to
     * the start. */
    private snapOutOfChipSpan;
    /** Buffers a bracketed-paste sequence ourselves (mirroring Editor's own, private, buffering) so
     * we can decide chip-or-not *before* the inner editor ever applies its own (different) fold. */
    private bufferPaste;
    private handlePaste;
    private interceptChipKey;
    /** Deletes what's left of a chip label that the edit from `before` to now only partly removed
     * (Backspace at its end, Delete at its start, Ctrl+W/Alt+D/Ctrl+U/Ctrl+K reaching into it), so a
     * partially covered chip is fully deleted. Only for a pure deletion with the caret at its start,
     * which is where every Pi delete leaves it. */
    private removeChipFragments;
    private expandTextChip;
    /** Steps the caret to `col` on the current line via synthetic arrow keys -- the only way to
     * reposition it without `setText()`'s side effect of jumping to the end of the whole buffer. */
    private moveCursorToColumn;
    /** Every call into the inner editor goes through these two, so `slots` is correct between any
     * two of Pi's undo snapshots, including between the synthetic keystrokes of one chip deletion. */
    private innerInput;
    private innerMouse;
    private editorState;
    /** Brings `slots` up to date with the editor's text; see the module comment. `change` says
     * whether a text change (other than Pi restoring an earlier state) was an edit of the draft or
     * a replacement of it by unrelated text. */
    private sync;
    /** Slots Pi put back with an earlier state (undo, leaving history). Checked chip by chip; only
     * a count mismatch, which Pi's exact restore can't produce, falls back to `carryOver`. */
    private restoredSlots;
    /** Slots for `text` after an ordinary edit from `this.synced.text`: a label wholly in the
     * unchanged prefix or suffix keeps its slot; any other label in `text` has no content. */
    private carryOver;
    /** Matches against `line`'s own text only; `contains` is fed `(start, end)` columns within that
     * line, matching `inner.getCursor().col`/`moveCursorToColumn`'s coordinate space. */
    private findChip;
    private chipInfo;
    /** The content pasted under `label`, or undefined for a contentless slot. Checking the label
     * again here is a last safety net: a slot never resolves to content pasted under another label. */
    private textContent;
    private resolveForSubmit;
    /** Called from inside Pi's submitValue, before `innerInput` gets to sync(): `this.synced.slots`
     * still describes the text being sent (Pi only trims it, which never removes a label). */
    private deliverSubmit;
    /** Submit starts a new draft, and Pi clears its undo stack, so nothing can bring these back. */
    private resetChips;
}
export declare function fitPopupLine(text: string, width: number): string;
export {};
//# sourceMappingURL=paste-chips.d.ts.map