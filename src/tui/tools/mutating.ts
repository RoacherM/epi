// grok-build-style tool renderers for Pi built-in mutating tools: bash, edit, write.
// Renders tool invocations and results according to docs/tui-design.md and docs/tui-theme.md.
import { relative, resolve } from "node:path";

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { isErrorResult, LinesComponent, textContent, truncateOutputLines } from "./common.js";
import type { ToolRenderContext, ToolRenderers } from "./types.js";

function parseBashOutput(rawText: string, isError: boolean): { exitCode: number; lines: string[] } {
  let text = rawText.replace(/\r\n/g, "\n");
  let exitCode = isError ? 1 : 0;

  // Pi's bash tool appends status as the trailing paragraph on failure or termination.
  const statusMatch = text.match(
    /(?:^|\n\n)(Command exited with code (\d+)|Command terminated without an exit code|Command timed out after [^\n]+|Command aborted)$/,
  );

  if (statusMatch && statusMatch.index !== undefined) {
    if (statusMatch[2] !== undefined) {
      exitCode = parseInt(statusMatch[2], 10);
    } else {
      exitCode = 1;
    }
    text = text.slice(0, statusMatch.index);
  }

  if (text === "(no output)") {
    text = "";
  }

  text = text.trimEnd();
  const lines = text.length > 0 ? text.split("\n") : [];
  return { exitCode, lines };
}

function formatCallLine(verb: string, args: any, theme: Theme, context?: ToolRenderContext): string {
  const rawPath = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
  if (!rawPath) {
    return theme.bold(verb);
  }
  const cwd = context?.cwd;
  const relPath = cwd ? relative(cwd, resolve(cwd, rawPath)) : rawPath;
  return `${theme.bold(verb)} ${relPath}`;
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  lineNum: number;
  text: string;
}

interface ParsedDiff {
  lines: DiffLine[];
  additions: number;
  removals: number;
}

function parseDiffString(diffStr: string): ParsedDiff {
  const rawLines = diffStr.replace(/\r\n/g, "\n").split("\n");
  const lines: DiffLine[] = [];
  let additions = 0;
  let removals = 0;

  for (const rawLine of rawLines) {
    if (!rawLine || rawLine.startsWith("---") || rawLine.startsWith("+++")) {
      continue;
    }

    if (/^\s*\.\.\.\s*$/.test(rawLine)) {
      continue;
    }

    // Pi's edit tool (edit-diff.js generateDiffString) only ever emits a numbered line
    // ("+12 text", "-12 text", " 12 text") or the "   ..." skip marker handled above; a plain
    // unified-diff "+text"/"-text" without a line number never occurs, so it is not parsed here.
    const piMatch = rawLine.match(/^([+-\s])(\s*\d+)\s(.*)$/);
    if (!piMatch || piMatch[1] === undefined || piMatch[2] === undefined || piMatch[3] === undefined) {
      continue;
    }
    const prefix = piMatch[1];
    const lineNum = parseInt(piMatch[2].trim(), 10);
    const text = piMatch[3].replace(/\t/g, "   ");

    if (prefix === "+") {
      additions++;
      lines.push({ kind: "add", lineNum, text });
    } else if (prefix === "-") {
      removals++;
      lines.push({ kind: "remove", lineNum, text });
    } else {
      lines.push({ kind: "context", lineNum, text });
    }
  }

  return { lines, additions, removals };
}

function formatDiffSummary(additions: number, removals: number, theme: Theme): string {
  if (additions > 0 && removals > 0) {
    return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `−${removals}`)}`;
  }
  if (additions > 0) {
    return theme.fg("toolDiffAdded", `+${additions}`);
  }
  if (removals > 0) {
    return theme.fg("toolDiffRemoved", `−${removals}`);
  }
  return theme.fg("muted", "+0 −0");
}

type FormattedItem =
  | { kind: "line"; diffLine: DiffLine }
  | { kind: "collapsed"; count: number };

/** A run of consecutive add/remove rows, by index into the diff and by its first/last line number. */
interface Hunk {
  startIdx: number;
  endIdx: number;
  firstLineNum: number;
  lastLineNum: number;
}

function lineItems(lines: DiffLine[]): FormattedItem[] {
  return lines.map((diffLine) => ({ kind: "line", diffLine }));
}

function findHunks(diffLines: DiffLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  diffLines.forEach((line, idx) => {
    if (line.kind === "context") return;
    const last = hunks[hunks.length - 1];
    if (last && last.endIdx === idx - 1) {
      last.endIdx = idx;
      last.lastLineNum = line.lineNum;
    } else {
      hunks.push({ startIdx: idx, endIdx: idx, firstLineNum: line.lineNum, lastLineNum: line.lineNum });
    }
  });
  return hunks;
}

/** Up to 3 context rows before the first hunk, after a count of every file line above them. */
function leadingContext(diffLines: DiffLine[], firstHunk: Hunk): FormattedItem[] {
  const kept = diffLines.slice(0, firstHunk.startIdx).slice(-3);
  const firstShown = kept[0]?.lineNum ?? firstHunk.firstLineNum;
  const skipped = firstShown - 1;
  return [...(skipped > 0 ? [{ kind: "collapsed", count: skipped } as const] : []), ...lineItems(kept)];
}

/**
 * Context between two hunks: all of it when it is short (≤6) and Pi sent it whole, otherwise 3 rows
 * after the earlier hunk, a count of the rest, and 3 rows before the later one.
 */
function contextBetween(diffLines: DiffLine[], hunk: Hunk, next: Hunk): FormattedItem[] {
  const between = diffLines.slice(hunk.endIdx + 1, next.startIdx);
  const consecutive = next.firstLineNum - hunk.lastLineNum - 1 === between.length;
  if (between.length <= 6 && consecutive) return lineItems(between);

  const keptAfter = between.slice(0, 3);
  const keptBefore = between.slice(-3);
  const lastKept = keptAfter[keptAfter.length - 1]?.lineNum ?? hunk.lastLineNum;
  const firstNext = keptBefore[0]?.lineNum ?? next.firstLineNum;
  const collapsed = firstNext - lastKept - 1;
  return [
    ...lineItems(keptAfter),
    ...(collapsed > 0 ? [{ kind: "collapsed", count: collapsed } as const] : []),
    ...lineItems(keptBefore),
  ];
}

/** Up to 3 context rows after the last hunk, then a count of the remaining context rows Pi sent. */
function trailingContext(diffLines: DiffLine[], lastHunk: Hunk): FormattedItem[] {
  const trailing = diffLines.slice(lastHunk.endIdx + 1);
  return [
    ...lineItems(trailing.slice(0, 3)),
    ...(trailing.length > 3 ? [{ kind: "collapsed", count: trailing.length - 3 } as const] : []),
  ];
}

function collapseDiffContext(diffLines: DiffLine[]): FormattedItem[] {
  const hunks = findHunks(diffLines);
  const firstHunk = hunks[0];
  const lastHunk = hunks[hunks.length - 1];
  if (firstHunk === undefined || lastHunk === undefined) {
    return diffLines.length <= 3 ? lineItems(diffLines) : [{ kind: "collapsed", count: diffLines.length }];
  }

  const items = leadingContext(diffLines, firstHunk);
  hunks.forEach((hunk, h) => {
    items.push(...lineItems(diffLines.slice(hunk.startIdx, hunk.endIdx + 1)));
    const next = hunks[h + 1];
    if (next !== undefined) items.push(...contextBetween(diffLines, hunk, next));
  });
  items.push(...trailingContext(diffLines, lastHunk));
  return items;
}

function renderDiffExpanded(items: FormattedItem[], theme: Theme): string[] {
  let maxLineNum = 1;
  for (const item of items) {
    if (item.kind === "line" && item.diffLine.lineNum > maxLineNum) {
      maxLineNum = item.diffLine.lineNum;
    }
  }
  const gutterWidth = Math.max(String(maxLineNum).length, 2);

  return items.map((item) => {
    if (item.kind === "collapsed") {
      const indent = " ".repeat(gutterWidth);
      return theme.fg("muted", `${indent} … ${item.count} unchanged lines`);
    }
    const { kind, lineNum, text } = item.diffLine;
    const gutter = String(lineNum).padStart(gutterWidth, " ");
    const content = `${gutter} ${text}`;
    if (kind === "add") {
      return theme.fg("toolDiffAdded", content);
    }
    if (kind === "remove") {
      return theme.fg("toolDiffRemoved", content);
    }
    return theme.fg("toolDiffContext", content);
  });
}

/** edit and write errors: the first line collapsed, the whole text expanded, painted once as `error`. */
function renderError(result: AgentToolResult<any>, expanded: boolean, theme: Theme): Component {
  const errorText = textContent(result) || "Error";
  const firstLine = errorText.split("\n")[0] ?? "Error";
  return new LinesComponent(expanded ? theme.fg("error", errorText) : theme.fg("error", firstLine));
}

function renderUnifiedDiffResult(
  result: AgentToolResult<any>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ToolRenderContext,
): Component {
  if (isErrorResult(result, context)) {
    return renderError(result, options.expanded, theme);
  }

  const details = result.details as { diff?: string } | undefined;
  const diffStr = details?.diff ?? "";
  const parsed = parseDiffString(diffStr);

  if (!options.expanded) {
    const summary = formatDiffSummary(parsed.additions, parsed.removals, theme);
    return new LinesComponent(summary);
  }

  const items = collapseDiffContext(parsed.lines);
  const lines = renderDiffExpanded(items, theme);
  return new LinesComponent(lines);
}

function renderWriteNewFileResult(
  contentStr: string,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const clean = contentStr.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = clean.length > 0 ? clean.split("\n") : [];
  const lineCount = lines.length;

  if (!options.expanded) {
    const label = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
    return new LinesComponent(theme.fg("muted", label));
  }

  const displayLines = lines.slice(0, 10);
  const gutterWidth = Math.max(String(displayLines.length).length, 2);
  const rendered = displayLines.map((line, idx) => {
    const gutter = String(idx + 1).padStart(gutterWidth, " ");
    return theme.fg("toolDiffAdded", `${gutter} ${line}`);
  });
  return new LinesComponent(rendered);
}

export const bashRenderers: ToolRenderers = {
  renderCall(args, theme) {
    const fullCommand = typeof args?.command === "string" ? args.command : "";
    const firstLine = fullCommand.split("\n")[0] ?? "";
    return new LinesComponent(`$ ${theme.fg("bashMode", firstLine)}`);
  },
  renderResult(result, options, theme, context) {
    const { exitCode, lines } = parseBashOutput(textContent(result), isErrorResult(result, context));

    if (options.isPartial) {
      const partialLines = lines.length <= 3 ? lines : lines.slice(-3);
      return new LinesComponent(partialLines.map((l) => theme.fg("toolOutput", l)));
    }

    if (!options.expanded) {
      const statusText = exitCode === 0
        ? theme.fg("muted", "exit 0")
        : theme.fg("error", `exit ${exitCode}`);
      return new LinesComponent(statusText);
    }

    const painted = lines.map((l) => theme.fg("toolOutput", l));
    return new LinesComponent(truncateOutputLines(painted, (text) => theme.fg("muted", text)));
  },
};

export const editRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return new LinesComponent(formatCallLine("edit", args, theme, context));
  },
  renderResult(result, options, theme, context) {
    return renderUnifiedDiffResult(result, options, theme, context);
  },
};

export const writeRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    return new LinesComponent(formatCallLine("write", args, theme, context));
  },
  renderResult(result, options, theme, context) {
    if (isErrorResult(result, context)) {
      return renderError(result, options.expanded, theme);
    }

    // Pi's write tool always returns `details: undefined` (write.js): it has no prior file
    // content to diff against, so there is no diff branch here, only the new-file line dump.
    const content = typeof context.args?.content === "string" ? context.args.content : "";
    return renderWriteNewFileResult(content, options, theme);
  },
};

export const mutatingRenderers: Record<string, ToolRenderers> = {
  bash: bashRenderers,
  edit: editRenderers,
  write: writeRenderers,
};
