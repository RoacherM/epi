import type { ImageContent } from "@earendil-works/pi-ai";
export interface FileArgumentsResult {
    /** `<file name="...">...</file>` blocks, same shape as Pi's processFileArguments: text files
     * inlined in full, image files noted by path (see images) without their content repeated. */
    text: string;
    /** Absolute paths of image files among the arguments, in order (kept for callers that only
     * need the paths, and for test/file-arguments.test.mjs's existing assertions). */
    imagePaths: string[];
    /** The same image files, read and base64-encoded, paired 1:1 with `imagePaths` -- attached to
     * `session.prompt`'s `images` option by the TUI's initial-message flow (start.ts), matching how
     * Pi's own buildInitialMessage/prepareInitialMessage pairs `fileImages` with `initialMessage`. */
    images: ImageContent[];
}
/** Reads each `@file` argument: text files are inlined, image files are noted by path and read as
 * an attachment, a missing file throws (instead of Pi's `console.error` + `process.exit(1)`) so
 * the caller can report it through MMP's normal preflight-error path. An empty file is skipped,
 * matching Pi. Raw bytes are kept as-is; AgentSession resizes for the model at send time
 * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
export declare function processFileArguments(fileArgs: readonly string[], cwd: string): Promise<FileArgumentsResult>;
export interface TuiInitialMessages {
    messages: string[];
    /** Paired with `messages[0]` only, mirroring Pi's own buildInitialMessage (one `initialImages`
     * array for the whole CLI invocation, attached to whichever text it produces). */
    images: ImageContent[];
}
/**
 * Mirrors Pi's buildInitialMessage (dist/cli/initial-message.js): `@file` text is prepended to the
 * first plain-text message (only the first -- Pi's own semantics), so a lone `@file` with no other
 * message still becomes a usable prompt on its own.
 */
export declare function buildTuiInitialMessages(fileArgs: readonly string[], messages: readonly string[], cwd: string): Promise<TuiInitialMessages>;
//# sourceMappingURL=file-arguments.d.ts.map