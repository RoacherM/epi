// Test seam: MMP_TEST_CLIPBOARD_FILE swaps the system clipboard for a plain file, so tests never
// read or write the developer's real clipboard. Used only by /copy (session-commands.ts) and
// Ctrl+V (key-handlers.ts); set only by test/tui-commands-session.test.mjs and
// test/tui-keys-actions.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
function testFile() {
    return process.env.MMP_TEST_CLIPBOARD_FILE;
}
/** `/copy` and the `app.message.copy` key: write text to the clipboard (or the test file). */
export async function writeClipboardText(text) {
    const file = testFile();
    if (file !== undefined) {
        writeFileSync(file, text, "utf8");
        return;
    }
    await copyToClipboard(text);
}
/**
 * Ctrl+V: an image wins over text, as in the real clipboard. The OS-specific readers are passed
 * in (key-handlers.ts loads them from Pi's own package) so this module stays free of that.
 */
export async function readClipboardForPaste(readImage, readText) {
    const file = testFile();
    if (file !== undefined) {
        const text = readFileSync(file, "utf8");
        return text ? { kind: "text", text } : { kind: "none" };
    }
    const image = await readImage();
    if (image)
        return { kind: "image", ...image };
    const text = await readText();
    return text ? { kind: "text", text } : { kind: "none" };
}
//# sourceMappingURL=clipboard.js.map