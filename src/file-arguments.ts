// `@file` arguments (docs/cli-design.md §2), mirroring Pi's processFileArguments/buildInitialMessage
// (dist/cli/file-processor.js, dist/cli/initial-message.js -- neither is exported). Used by MMP's
// TUI to build its initial message (src/tui/start.ts); the non-interactive path (-p/--mode) never
// needs this module at all, since piMain still gets `@file` tokens verbatim in its passthrough
// argv and does its own, real @file handling internally.
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
function resolveFileArgument(fileArg: string, cwd: string): string {
  const expanded = fileArg === "~" || fileArg.startsWith("~/") ? join(homedir(), fileArg.slice(1)) : fileArg;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

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
export async function processFileArguments(fileArgs: readonly string[], cwd: string): Promise<FileArgumentsResult> {
  let text = "";
  const imagePaths: string[] = [];
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
      text += `<file name="${absolutePath}">image file (not attached as image data by MMP's TUI; read it by path)</file>\n`;
      continue;
    }
    const content = readFileSync(absolutePath, "utf8").replace(/^﻿/, "");
    text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
  }
  return { text, imagePaths };
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
): Promise<string[]> {
  if (fileArgs.length === 0) {
    return [...messages];
  }
  const { text } = await processFileArguments(fileArgs, cwd);
  if (text.length === 0) {
    // Every @file argument was empty and skipped (matches Pi: an empty fileText never gets pushed).
    return [...messages];
  }
  const [first, ...rest] = messages;
  return [`${text}${first ?? ""}`, ...rest];
}
