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
interface ChipEditorOptions extends EditorOptions {
    /** Read live so an image path pasted after /resume resolves against the new session's cwd. */
    getCwd: () => string;
}
/**
 * Wraps pi-tui's `Editor`, adding atomic paste/image chips on top of its public API. See the
 * module comment for why this wraps instead of extending `Editor`.
 */
export declare class ChipEditor {
    private readonly inner;
    private readonly getCwd;
    /** Full original text of each `[Pasted: ...]` chip, ordered left-to-right/top-to-bottom to match
     * the chip regex's match order (there's no id in the label to key by -- docs/tui-design.md 4.3
     * shows none, matching grok; only `[Image #N]` chips carry a visible, and thus lookup-able, id). */
    private textChips;
    private imageChips;
    private imageCounter;
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
    /** Callers that put back text they just read from this same editor -- restoring a queued
     * message ahead of the current draft on Esc/Ctrl+C/Alt+Up (keys.ts, session-tree-commands.ts),
     * or the /fork editor-slot restore -- read the raw, unexpanded text (`getEditorText`, not
     * `getExpandedText`) and prepend to it, so every chip already in it is still there, unchanged.
     * Keep the registries in that case instead of wiping them (which would otherwise turn a live
     * chip into dead bracket text that can no longer expand or attach an image). A real new draft
     * (submit's `setText("")`, /new, Ctrl+G's external-editor result, an extension's setEditorText)
     * has a different chip count and correctly resets. */
    setText(text: string): void;
    private sameChipsAs;
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
     * place in that text; `setText`'s own `sameChipsAs` check sees the id already in `imageChips` and
     * keeps it, same as any other chip surviving a restore. */
    registerImage(bytes: Uint8Array, mimeType: string): string;
    /** Ctrl+V with an image on the clipboard, or an `@image`-equivalent drop: adds an `[Image #N]`
     * chip at the cursor. `bytes` are kept as-is; AgentSession resizes for the model at send time
     * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
    insertImageChip(bytes: Uint8Array, mimeType: string): void;
    /** The chip the caret sits *on*. Image chips (no Enter-conflict -- they never expand) keep the
     * original inclusive-at-`end` span, matching the existing "popup shows right after inserting one"
     * behavior. Text chips are stricter (`start <= col < end`, excluding `end`): right after a fresh
     * paste the caret sits at `end`, and Enter there must send like grok, not expand (docs/tui-design.md
     * 4.3) -- only actually landing on the chip (arrowing back onto it, or a click, which Editor
     * positions inside/at the start of the clicked grapheme) does. Drives Enter-to-expand, the
     * footer's `Enter:expand` shortcut, and double-click. */
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
     * and typing there would break the marker's regex match, shifting every later chip's index in
     * `textChips`/`imageChips` and misattributing their content on submit (not merely a cosmetic
     * gap). After any such move, if the caret ended up inside a span, step it the rest of the way to
     * whichever boundary it was heading toward (nearer one) -- or, when `toStart` is set (every
     * mouse-driven call site: a click has no direction), always to the start. */
    private snapOutOfChipSpan;
    /** Buffers a bracketed-paste sequence ourselves (mirroring Editor's own, private, buffering) so
     * we can decide chip-or-not *before* the inner editor ever applies its own (different) fold. */
    private bufferPaste;
    private handlePaste;
    private interceptChipKey;
    private deleteChipSpan;
    private expandTextChip;
    /** Steps the caret to `col` on the current line via synthetic arrow keys -- the only way to
     * reposition it without `setText()`'s side effect of jumping to the end of the whole buffer. */
    private moveCursorToColumn;
    private deleteBackward;
    /** Matches against `line`'s own text only. `contains` is fed `(start, end)` columns *within that
     * line*, matching `inner.getCursor().col`/`moveCursorToColumn`'s coordinate space -- unlike
     * `lineText(line)` (all previous lines joined + this one), whose match indices are offsets into
     * the whole concatenation and were being compared against a same-line column (the bug this
     * replaces: a chip on any line but the first always missed, or matched the wrong span, once a
     * doc had more than one line). `textChipCountBefore` below still needs `lineText`'s document-wide
     * prefix -- that one's correct as is. */
    private findChip;
    private chipInfo;
    /** How many `[Pasted: ...]` chips appear before (line, col) -- the index into `textChips`,
     * since chip labels carry no id and are only distinguishable by document order. */
    private textChipCountBefore;
    private lineText;
    private resolveForSubmit;
    private deliverSubmit;
    private resetChips;
}
export declare function fitPopupLine(text: string, width: number): string;
export {};
//# sourceMappingURL=paste-chips.d.ts.map