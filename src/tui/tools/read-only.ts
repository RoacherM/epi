import { isAbsolute, relative } from "node:path";

import {
  type AgentToolResult,
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { piTui } from "../pi-tui.js";
import type { ToolRenderContext, ToolRenderers } from "./types.js";

class LinesComponent implements Component {
  private lines: string[];

  constructor(lines: string[]) {
    this.lines = lines.flatMap((line) => line.split("\n"));
  }

  setLines(lines: string[]): void {
    this.lines = lines.flatMap((line) => line.split("\n"));
  }

  getLines(): string[] {
    return this.lines;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.lines.map((line) => piTui.truncateToWidth(line, width));
  }
}

function createOrUpdateLines(context: ToolRenderContext, lines: string[]): Component {
  if (context.lastComponent instanceof LinesComponent) {
    context.lastComponent.setLines(lines);
    return context.lastComponent;
  }
  return new LinesComponent(lines);
}

function formatRelativePath(filePath: string | undefined, cwd: string): string {
  if (!filePath || filePath === ".") return ".";
  const normalized = filePath.replace(/\\/g, "/");
  if (isAbsolute(filePath)) {
    const rel = relative(cwd, filePath).replace(/\\/g, "/");
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return rel || ".";
    }
    return normalized;
  }
  return normalized.replace(/^\.\//, "") || ".";
}

function getTextContent(result: AgentToolResult<any>): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}

function parseEntryLines(output: string, emptyMarkers: string[]): string[] {
  const trimmed = output.replace(/\r/g, "").trim();
  if (!trimmed || emptyMarkers.some((marker) => trimmed.startsWith(marker))) {
    return [];
  }
  return trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !(l.startsWith("[") && l.endsWith("]")));
}

function parseGrepOutput(output: string): {
  lines: string[];
  matchCount: number;
  fileCount: number;
} {
  const rawLines = output
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !(l.startsWith("[") && l.endsWith("]")));

  if (rawLines.length === 0 || (rawLines.length === 1 && rawLines[0] === "No matches found")) {
    return { lines: [], matchCount: 0, fileCount: 0 };
  }

  const files = new Set<string>();
  let matchCount = 0;
  for (const line of rawLines) {
    const match = line.match(/^([^:\n]+):(\d+):/);
    if (match && match[1]) {
      matchCount++;
      files.add(match[1]);
    } else {
      const ctxMatch = line.match(/^([^-\n]+)-(\d+)-/);
      if (ctxMatch && ctxMatch[1]) {
        files.add(ctxMatch[1]);
      }
    }
  }

  if (matchCount === 0 && rawLines.length > 0) {
    matchCount = rawLines.length;
    files.add("1");
  }

  return { lines: rawLines, matchCount, fileCount: files.size };
}

// -----------------------------------------------------------------------------
// read renderer
// -----------------------------------------------------------------------------

function renderReadCall(args: any, theme: Theme, context: ToolRenderContext): Component {
  const rawPath = String(args?.path ?? args?.file_path ?? "");
  const relPath = formatRelativePath(rawPath, context.cwd);
  const start = args?.offset ?? 1;
  const end = args?.limit !== undefined ? start + args.limit - 1 : "";
  const hasRange = args?.offset !== undefined || args?.limit !== undefined;
  const rangeStr = hasRange ? `:${start}${end ? `-${end}` : ""}` : "";
  const callText = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", relPath)}${rangeStr ? theme.fg("warning", rangeStr) : ""}`;
  return createOrUpdateLines(context, [callText]);
}

function renderReadResult(
  result: AgentToolResult<any>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const rawPath = String(context.args?.path ?? context.args?.file_path ?? "");
  const relPath = formatRelativePath(rawPath, context.cwd);
  const isError = Boolean(context.isError || (result as { isError?: boolean }).isError);
  const output = getTextContent(result).replace(/\r/g, "");

  if (isError) {
    const errorLines = output ? output.split("\n") : ["Error reading file"];
    if (!options.expanded) {
      const summary = `${theme.fg("accent", relPath)}: ${theme.fg("error", errorLines[0] ?? "error")}`;
      return createOrUpdateLines(context, [summary]);
    }
    return createOrUpdateLines(
      context,
      errorLines.map((line) => theme.fg("error", line)),
    );
  }

  const offset = context.args?.offset;
  const limit = context.args?.limit;
  const hasRange = offset !== undefined || limit !== undefined;
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : "";
  const rangeStr = hasRange ? `:${start}${end ? `-${end}` : ""}` : "";

  let renderedLines: string[];
  try {
    const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
    renderedLines = highlightCode(replaceTabs(output), lang);
  } catch {
    renderedLines = output.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line)));
  }
  const lines = trimTrailingEmptyLines(renderedLines);
  const totalLines = result.details?.truncation?.totalLines ?? lines.length;

  if (!options.expanded) {
    const suffix = hasRange
      ? theme.fg("warning", rangeStr)
      : ` ${theme.fg("muted", `(${totalLines} ${totalLines === 1 ? "line" : "lines"})`)}`;
    const line = `${theme.fg("accent", relPath)}${suffix}`;
    return createOrUpdateLines(context, [line]);
  }

  if (lines.length <= 8) {
    return createOrUpdateLines(context, lines);
  }

  const head = lines.slice(0, 5);
  const tail = lines.slice(-3);
  const omitted = lines.length - 8;
  const omittedLine = theme.fg("muted", `… ${omitted} more lines`);
  return createOrUpdateLines(context, [...head, omittedLine, ...tail]);
}

export const readRenderers: ToolRenderers = {
  renderCall: renderReadCall,
  renderResult: renderReadResult,
};

// -----------------------------------------------------------------------------
// grep renderer
// -----------------------------------------------------------------------------

function renderGrepCall(args: any, theme: Theme, context: ToolRenderContext): Component {
  const pattern = args?.pattern ? `/${args.pattern}/` : "[missing pattern]";
  let callText = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", pattern)}`;
  if (args?.path) {
    callText += ` in ${theme.fg("accent", formatRelativePath(args.path, context.cwd))}`;
  }
  if (args?.glob) {
    callText += ` ${theme.fg("muted", `(${args.glob})`)}`;
  }
  return createOrUpdateLines(context, [callText]);
}

function renderGrepResult(
  result: AgentToolResult<any>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const isError = Boolean(context.isError || (result as { isError?: boolean }).isError);
  const output = getTextContent(result);

  if (isError) {
    const errorLines = output ? output.split("\n") : ["Error executing grep"];
    if (!options.expanded) {
      return createOrUpdateLines(context, [theme.fg("error", errorLines[0] ?? "error")]);
    }
    return createOrUpdateLines(
      context,
      errorLines.map((line) => theme.fg("error", line)),
    );
  }

  const pattern = context.args?.pattern ? `/${context.args.pattern}/` : "[missing pattern]";
  const { lines, matchCount, fileCount } = parseGrepOutput(output);

  if (!options.expanded) {
    const matchText = `${matchCount} ${matchCount === 1 ? "match" : "matches"} in ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
    const line = `${theme.fg("accent", pattern)} ${theme.fg("muted", matchText)}`;
    return createOrUpdateLines(context, [line]);
  }

  if (lines.length === 0) {
    return createOrUpdateLines(context, [theme.fg("muted", "No matches found")]);
  }

  const display = lines.slice(0, 10).map((l) => theme.fg("toolOutput", l));
  if (lines.length > 10) {
    display.push(theme.fg("muted", `… ${lines.length - 10} more`));
  }
  return createOrUpdateLines(context, display);
}

export const grepRenderers: ToolRenderers = {
  renderCall: renderGrepCall,
  renderResult: renderGrepResult,
};

// -----------------------------------------------------------------------------
// find renderer
// -----------------------------------------------------------------------------

function renderFindCall(args: any, theme: Theme, context: ToolRenderContext): Component {
  const pattern = args?.pattern ?? "";
  let callText = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
  if (args?.path) {
    callText += ` in ${theme.fg("accent", formatRelativePath(args.path, context.cwd))}`;
  }
  return createOrUpdateLines(context, [callText]);
}

function renderFindResult(
  result: AgentToolResult<any>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const isError = Boolean(context.isError || (result as { isError?: boolean }).isError);
  const output = getTextContent(result);

  if (isError) {
    const errorLines = output ? output.split("\n") : ["Error executing find"];
    if (!options.expanded) {
      return createOrUpdateLines(context, [theme.fg("error", errorLines[0] ?? "error")]);
    }
    return createOrUpdateLines(
      context,
      errorLines.map((line) => theme.fg("error", line)),
    );
  }

  const pattern = context.args?.pattern ?? "";
  const entries = parseEntryLines(output, ["No files found matching pattern"]);
  const count = entries.length;

  if (!options.expanded) {
    const entryText = `(${count} ${count === 1 ? "entry" : "entries"})`;
    const line = `${theme.fg("accent", pattern)} ${theme.fg("muted", entryText)}`;
    return createOrUpdateLines(context, [line]);
  }

  if (entries.length === 0) {
    return createOrUpdateLines(context, [theme.fg("muted", "No files found matching pattern")]);
  }

  const display = entries.slice(0, 10).map((e) => theme.fg("toolOutput", e));
  if (entries.length > 10) {
    display.push(theme.fg("muted", `… ${entries.length - 10} more`));
  }
  return createOrUpdateLines(context, display);
}

export const findRenderers: ToolRenderers = {
  renderCall: renderFindCall,
  renderResult: renderFindResult,
};

// -----------------------------------------------------------------------------
// ls renderer
// -----------------------------------------------------------------------------

function renderLsCall(args: any, theme: Theme, context: ToolRenderContext): Component {
  const relPath = formatRelativePath(args?.path ?? ".", context.cwd);
  const callText = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", relPath)}`;
  return createOrUpdateLines(context, [callText]);
}

function renderLsResult(
  result: AgentToolResult<any>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const isError = Boolean(context.isError || (result as { isError?: boolean }).isError);
  const output = getTextContent(result);

  if (isError) {
    const errorLines = output ? output.split("\n") : ["Error executing ls"];
    if (!options.expanded) {
      return createOrUpdateLines(context, [theme.fg("error", errorLines[0] ?? "error")]);
    }
    return createOrUpdateLines(
      context,
      errorLines.map((line) => theme.fg("error", line)),
    );
  }

  const relPath = formatRelativePath(context.args?.path ?? ".", context.cwd);
  const entries = parseEntryLines(output, ["(empty directory)"]);
  const count = entries.length;

  if (!options.expanded) {
    const entryText = `(${count} ${count === 1 ? "entry" : "entries"})`;
    const line = `${theme.fg("accent", relPath)} ${theme.fg("muted", entryText)}`;
    return createOrUpdateLines(context, [line]);
  }

  if (entries.length === 0) {
    return createOrUpdateLines(context, [theme.fg("muted", "(empty directory)")]);
  }

  const display = entries.slice(0, 10).map((e) => theme.fg("toolOutput", e));
  if (entries.length > 10) {
    display.push(theme.fg("muted", `… ${entries.length - 10} more`));
  }
  return createOrUpdateLines(context, display);
}

export const lsRenderers: ToolRenderers = {
  renderCall: renderLsCall,
  renderResult: renderLsResult,
};

// -----------------------------------------------------------------------------
// Combined map keyed by tool name
// -----------------------------------------------------------------------------

export const readOnlyRenderers: Record<string, ToolRenderers> = {
  read: readRenderers,
  grep: grepRenderers,
  find: findRenderers,
  ls: lsRenderers,
};

