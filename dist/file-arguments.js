// `@file` arguments (docs/cli-design.md §2), mirroring Pi's processFileArguments/buildInitialMessage
// (dist/cli/file-processor.js, dist/cli/initial-message.js -- neither is exported). Used by MMP's
// TUI to build its initial message (src/tui/start.ts) and by print/json (src/noninteractive.ts).
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { MmpArgumentError } from "./errors.js";
/**
 * Mirrors Pi's resolveReadPath (dist/core/tools/path-utils.js, not exported): `~` expansion, then
 * resolved against cwd. Pi also retries a few macOS screenshot filename quirks (NFD normalization,
 * curly quotes, a narrow no-break space before AM/PM) when the plain path doesn't exist; MMP skips
 * those and reports a plain not-found error instead (documented deviation).
 */
function resolveFileArgument(fileArg, cwd) {
    const expanded = fileArg === "~" || fileArg.startsWith("~/") ? join(homedir(), fileArg.slice(1)) : fileArg;
    return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}
/** Reads each `@file` argument: text files are inlined, image files are noted by path and read as
 * an attachment, a missing file throws (instead of Pi's `console.error` + `process.exit(1)`) so
 * the caller can report it through MMP's normal preflight-error path. An empty file is skipped,
 * matching Pi. Raw bytes are kept as-is; AgentSession resizes for the model at send time
 * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
export async function processFileArguments(fileArgs, cwd) {
    let text = "";
    const imagePaths = [];
    const images = [];
    for (const fileArg of fileArgs) {
        const absolutePath = resolveFileArgument(fileArg, cwd);
        if (!existsSync(absolutePath)) {
            throw new MmpArgumentError(`File not found: ${absolutePath}`);
        }
        if (statSync(absolutePath).size === 0) {
            continue;
        }
        const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
        if (mimeType) {
            imagePaths.push(absolutePath);
            images.push({ type: "image", mimeType, data: readFileSync(absolutePath).toString("base64") });
            text += `<file name="${absolutePath}">image file</file>\n`;
            continue;
        }
        const content = readFileSync(absolutePath, "utf8").replace(/^﻿/, "");
        text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
    }
    return { text, imagePaths, images };
}
/**
 * Mirrors Pi's buildInitialMessage (dist/cli/initial-message.js): `@file` text is prepended to the
 * first plain-text message (only the first -- Pi's own semantics), so a lone `@file` with no other
 * message still becomes a usable prompt on its own.
 */
export async function buildTuiInitialMessages(fileArgs, messages, cwd) {
    if (fileArgs.length === 0) {
        return { messages: [...messages], images: [] };
    }
    const { text, images } = await processFileArguments(fileArgs, cwd);
    if (text.length === 0) {
        // Every @file argument was empty and skipped (matches Pi: an empty fileText never gets pushed).
        return { messages: [...messages], images: [] };
    }
    const [first, ...rest] = messages;
    return { messages: [`${text}${first ?? ""}`, ...rest], images };
}
//# sourceMappingURL=file-arguments.js.map