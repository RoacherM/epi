export interface FileArgumentsResult {
    /** `<file name="...">...</file>` blocks, same shape as Pi's processFileArguments: text files
     * inlined in full, image files noted by path only (see imagePaths). */
    text: string;
    /** Image files among the arguments. MMP's TUI has no binary attachment path for its initial
     * message (session.prompt() there only takes text -- see start.ts), so these are reported by
     * absolute path in `text` for the model's read tool, not attached as image data. Documented
     * deviation from Pi, which attaches resized image bytes directly. */
    imagePaths: string[];
}
/** Reads each `@file` argument: text files are inlined, image files are noted by path, a missing
 * file throws (instead of Pi's `console.error` + `process.exit(1)`) so the caller can report it
 * through MMP's normal preflight-error path. An empty file is skipped, matching Pi. */
export declare function processFileArguments(fileArgs: readonly string[], cwd: string): Promise<FileArgumentsResult>;
/**
 * Mirrors Pi's buildInitialMessage (dist/cli/initial-message.js): `@file` text is prepended to the
 * first plain-text message (only the first -- Pi's own semantics), so a lone `@file` with no other
 * message still becomes a usable prompt on its own.
 */
export declare function buildTuiInitialMessages(fileArgs: readonly string[], messages: readonly string[], cwd: string): Promise<string[]>;
//# sourceMappingURL=file-arguments.d.ts.map