import type { CommandHost } from "./command-host.js";
/** `app.editor.external` (Ctrl+G): edit the prompt in `$VISUAL`/`$EDITOR`, as Pi's `handleOpenExternalEditor` does. */
export declare function openExternalEditor(host: CommandHost): Promise<void>;
/** `app.clipboard.pasteImage` (Ctrl+V): as Pi's `handleClipboardPaste`, an image wins over text.
 * An image becomes an `[Image #N]` chip directly (docs/tui-design.md 4.3), not a temp-file path
 * for the model to read. Pi ignores clipboard errors silently; Epi's rule is that failures show,
 * so this shows a notice. */
export declare function pasteClipboard(host: CommandHost): Promise<void>;
/** A single-line bracketed paste resolved to a file path that could not be opened due to EPERM/EACCES
 * (e.g. Cmd+V in macOS terminal after copying an image in WeChat, which puts both its sandboxed
 * container file URL and the image bitmap on NSPasteboard): prefer the clipboard image if present,
 * otherwise insert the pasted text and surface the permission error. */
export declare function pasteUnreadableImagePath(host: CommandHost, path: string, rawText: string, error: unknown): Promise<void>;
/** `app.suspend` (Ctrl+Z, not on Windows): suspend to the shell, restoring the fullscreen UI on SIGCONT. */
export declare function suspendToShell(host: CommandHost): void;
//# sourceMappingURL=key-handlers.d.ts.map