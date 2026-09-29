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
    addToHistory(text: string): void;
    setAutocompleteProvider(provider: AutocompleteProvider): void;
    isShowingAutocomplete(): boolean;
    setText(text: string): void;
    insertTextAtCursor(text: string): void;
    /** Text chips expanded to their full content, image chips stripped out entirely (they're sent
     * as attachments, not inlined -- docs/tui-design.md 4.3's 发送 row). Non-destructive: safe to
     * call more than once before the caller decides what to do with the result (e.g. keys.ts reads
     * this and `getImageAttachments()` separately for Alt+Enter). */
    getExpandedText(): string;
    getImageAttachments(): ImageContent[];
    /** Ctrl+V with an image on the clipboard, or an `@image`-equivalent drop: adds an `[Image #N]`
     * chip at the cursor. `bytes` are kept as-is; AgentSession resizes for the model at send time
     * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
    insertImageChip(bytes: Uint8Array, mimeType: string): void;
    /** The chip the caret currently sits on or inside (start/end inclusive -- see the module
     * comment on why this is containment-based rather than boundary-exact), for the preview popup,
     * the `Enter:expand` shortcut, and double-click. */
    chipAtCursor(): ChipInfo | undefined;
    handleInput(data: string): void;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
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