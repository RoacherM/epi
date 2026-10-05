// Larger app-level key handlers (docs/tui-design.md 4.7): external editor, clipboard image paste,
// suspend to shell. Kept out of keys.ts so its action table stays readable.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readClipboardForPaste } from "./clipboard.js";
import type { CommandHost } from "./command-host.js";
import { errorText } from "./errors.js";

// Pi's clipboard readers (utils/clipboard.js, utils/clipboard-image.js) do the OS-specific work
// (wl-paste, xclip, pbpaste, PowerShell, Photon format conversion, ...) but are not part of its
// public API. Loaded from Pi's own package file, like keybindings.ts loads KeybindingsManager;
// test/tui-keys-actions.test.mjs fails if a Pi upgrade moves them.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { readClipboardText } = (await import(pathToFileURL(join(piDist, "utils", "clipboard.js")).href)) as {
  readClipboardText(): Promise<string | null | undefined>;
};
const { readClipboardImage } = (await import(pathToFileURL(join(piDist, "utils", "clipboard-image.js")).href)) as {
  readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null | undefined>;
};

/** `app.editor.external` (Ctrl+G): edit the prompt in `$VISUAL`/`$EDITOR`, as Pi's `handleOpenExternalEditor` does. */
export async function openExternalEditor(host: CommandHost): Promise<void> {
  const command = host.session().settingsManager.getExternalEditorCommand();
  const content = host.getExpandedEditorText();
  // getExpandedEditorText() never inlines image chips (they're sent as attachments, not text --
  // docs/tui-design.md 4.3's 发送 row), so any of them are already excluded from what $EDITOR sees.
  // Counted here, before the editor is replaced below, so there's something to compare against.
  const imageCount = host.getEditorImages().length;
  // Pi's plain stop() copies the whole frame onto the normal screen, where it stays after quitting
  // (dogfood D41); the editor takes over the screen anyway, and start() redraws the TUI in full.
  host.tui.stop({ preserveScreen: true });
  try {
    const result = await runExternalEditor(command, content);
    if (result.status === "complete") {
      host.setEditorText(result.content);
      // Item 6: setEditorText() replaces the whole draft with $EDITOR's plain text, which can't
      // carry image chips -- silently dropping them is the bug; a notice is the fix (recovery isn't
      // possible here, unlike the queue-restore case, since $EDITOR never saw the image at all).
      if (imageCount > 0) {
        host.notice(`External editor dropped ${imageCount} image${imageCount > 1 ? "s" : ""} from the prompt (images aren't sent to $EDITOR).`, "warning");
      }
    } else {
      // Pi ignores this silently; Epi's rule is that failures show, so a bad $EDITOR isn't a mystery.
      host.notice(`External editor (${command}) exited without saving; the prompt is unchanged.`, "error");
    }
  } finally {
    host.tui.start();
    host.tui.requestRender(true);
  }
}

/** Pi's `editInExternalEditor` (modes/interactive/external-editor.js, not exported): write the
 * prompt to a temp file, run the editor command on it, and read back whatever it saved. */
async function runExternalEditor(
  command: string,
  content: string,
): Promise<{ status: "complete"; content: string } | { status: "failed" }> {
  const directory = mkdtempSync(join(tmpdir(), "epi-editor-"));
  const filePath = join(directory, "prompt.md");
  try {
    writeFileSync(filePath, content, "utf8");
    const [editor, ...args] = command.split(" ");
    if (editor === undefined) return { status: "failed" };
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(editor, [...args, filePath], { stdio: "inherit", shell: process.platform === "win32" });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
    if (exitCode !== 0) return { status: "failed" };
    return { status: "complete", content: readFileSync(filePath, "utf8").replace(/^﻿/, "").replace(/\n$/, "") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** `app.clipboard.pasteImage` (Ctrl+V): as Pi's `handleClipboardPaste`, an image wins over text.
 * An image becomes an `[Image #N]` chip directly (docs/tui-design.md 4.3), not a temp-file path
 * for the model to read. Pi ignores clipboard errors silently; Epi's rule is that failures show,
 * so this shows a notice. */
export async function pasteClipboard(host: CommandHost): Promise<void> {
  try {
    const paste = await readClipboardForPaste(readClipboardImage, readClipboardText);
    if (paste.kind === "image") {
      host.insertImage(paste.bytes, paste.mimeType);
      return;
    }
    if (paste.kind === "text") {
      host.pasteText(paste.text);
      return;
    }
    host.notice("Nothing to paste: the clipboard holds no image or text.", "warning");
  } catch (error) {
    host.notice(`Could not read the clipboard: ${errorText(error)}`, "error");
  }
}

/** `app.suspend` (Ctrl+Z, not on Windows): suspend to the shell, restoring the fullscreen UI on SIGCONT. */
export function suspendToShell(host: CommandHost): void {
  if (process.platform === "win32") {
    host.notice("Suspend to background is not supported on Windows.", "warning");
    return;
  }
  // Keep the event loop alive while suspended, or Node can exit with no ref'ed handles before
  // SIGCONT gets a chance to restore the terminal.
  const keepAlive = setInterval(() => {}, 2 ** 30);
  const ignoreSigint = () => {};
  process.on("SIGINT", ignoreSigint);
  process.once("SIGCONT", () => {
    clearInterval(keepAlive);
    process.removeListener("SIGINT", ignoreSigint);
    host.tui.start();
    host.tui.requestRender(true);
  });
  try {
    // As in openExternalEditor: the shell sees its own screen, not a copy of the last frame.
    host.tui.stop({ preserveScreen: true });
    process.kill(0, "SIGTSTP");
  } catch (error) {
    clearInterval(keepAlive);
    process.removeListener("SIGINT", ignoreSigint);
    throw error;
  }
}
