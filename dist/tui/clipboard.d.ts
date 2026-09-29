/** `/copy` and the `app.message.copy` key: write text to the clipboard (or the test file). */
export declare function writeClipboardText(text: string): Promise<void>;
export type ClipboardPaste = {
    kind: "image";
    bytes: Uint8Array;
    mimeType: string;
} | {
    kind: "text";
    text: string;
} | {
    kind: "none";
};
/**
 * Ctrl+V: an image wins over text, as in the real clipboard. The OS-specific readers are passed
 * in (key-handlers.ts loads them from Pi's own package) so this module stays free of that.
 */
export declare function readClipboardForPaste(readImage: () => Promise<{
    bytes: Uint8Array;
    mimeType: string;
} | null | undefined>, readText: () => Promise<string | null | undefined>): Promise<ClipboardPaste>;
//# sourceMappingURL=clipboard.d.ts.map