// Test seam: EPI_TEST_CLIPBOARD_FILE swaps the system clipboard for a plain file, so tests never
// read or write the developer's real clipboard. Used only by /copy (session-commands.ts) and
// Ctrl+V (key-handlers.ts); set only by test/tui-commands-session.test.mjs,
// test/tui-keys-actions.test.mjs and test/tui-paste-chips.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { copyToClipboard } from "@earendil-works/pi-coding-agent";

// Same private sniffer key-handlers.ts and paste-chips.ts already load from Pi's package.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { detectSupportedImageMimeType } = (await import(pathToFileURL(join(piDist, "utils", "mime.js")).href)) as {
  detectSupportedImageMimeType(buffer: Buffer): string | null;
};

function testFile(): string | undefined {
  return process.env.EPI_TEST_CLIPBOARD_FILE;
}

/** `/copy` and the `app.message.copy` key: write text to the clipboard (or the test file). */
export async function writeClipboardText(text: string): Promise<void> {
  const file = testFile();
  if (file !== undefined) {
    writeFileSync(file, text, "utf8");
    return;
  }
  await copyToClipboard(text);
}

export type ClipboardPaste =
  | { kind: "image"; bytes: Uint8Array; mimeType: string }
  | { kind: "text"; text: string }
  | { kind: "none" };

/**
 * Ctrl+V: an image wins over text, as in the real clipboard. The OS-specific readers are passed
 * in (key-handlers.ts loads them from Pi's own package) so this module stays free of that.
 */
export async function readClipboardForPaste(
  readImage: () => Promise<{ bytes: Uint8Array; mimeType: string } | null | undefined>,
  readText: () => Promise<string | null | undefined>,
): Promise<ClipboardPaste> {
  const file = testFile();
  if (file !== undefined) {
    // An image path means "image on clipboard" for tests (docs/tui-design.md 4.3's Ctrl+V row);
    // anything else is read as plain clipboard text, as before.
    const bytes = readFileSync(file);
    const mimeType = detectSupportedImageMimeType(bytes.subarray(0, 4100));
    if (mimeType !== null) return { kind: "image", bytes, mimeType };
    const text = bytes.toString("utf8");
    return text ? { kind: "text", text } : { kind: "none" };
  }
  const image = await readImage();
  if (image) return { kind: "image", ...image };
  const text = await readText();
  return text ? { kind: "text", text } : { kind: "none" };
}
