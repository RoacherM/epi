// `@file` arguments (docs/cli-design.md §2), mirroring Pi's processFileArguments/buildInitialMessage
// (dist/cli/file-processor.js, dist/cli/initial-message.js -- neither is exported). Used by MMP's
// TUI to build its initial message (src/tui/start.ts) and by print/json (src/noninteractive.ts).
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";

import { MmpArgumentError } from "./errors.js";

/**
 * Mirrors Pi's resolveReadPath (dist/core/tools/path-utils.js, not exported): `~` expansion, then
 * resolved against cwd. Pi also retries a few macOS screenshot filename quirks (NFD normalization,
 * curly quotes, a narrow no-break space before AM/PM) when the plain path doesn't exist; MMP skips
 * those and reports a plain not-found error instead (documented deviation).
 */
function resolveFileArgument(fileArg: string, cwd: string): string {
  const expanded = fileArg === "~" || fileArg.startsWith("~/") ? join(homedir(), fileArg.slice(1)) : fileArg;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

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
export async function processFileArguments(fileArgs: readonly string[], cwd: string): Promise<FileArgumentsResult> {
  let text = "";
  const imagePaths: string[] = [];
  const images: ImageContent[] = [];
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
export async function buildTuiInitialMessages(
  fileArgs: readonly string[],
  messages: readonly string[],
  cwd: string,
): Promise<TuiInitialMessages> {
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
