import { isAbsolute, relative } from "node:path";
import { getLanguageFromPath, highlightCode, } from "@earendil-works/pi-coding-agent";
import { piTui } from "../pi-tui.js";
import { createOrUpdateLines, isErrorResult, textContent } from "./common.js";
function formatRelativePath(filePath, cwd) {
    if (!filePath || filePath === ".")
        return ".";
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
function replaceTabs(text) {
    return text.replace(/\t/g, "   ");
}
function trimTrailingEmptyLines(lines) {
    let end = lines.length;
    // highlightCode wraps even an empty line in color codes (e.g. "\x1B[...m\x1B[39m" for the blank
    // line a trailing "\n" produces), so a plain `=== ""` check misses it; compare visible width.
    while (end > 0 && piTui.visibleWidth(lines[end - 1] ?? "") === 0) {
        end--;
    }
    return lines.slice(0, end);
}
function parseEntryLines(output, emptyMarker) {
    const trimmed = output.replace(/\r/g, "").trim();
    if (!trimmed || trimmed.startsWith(emptyMarker)) {
        return [];
    }
    return trimmed
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !(l.startsWith("[") && l.endsWith("]")));
}
function parseGrepOutput(output) {
    const rawLines = output
        .replace(/\r/g, "")
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0 && !(l.startsWith("[") && l.endsWith("]")));
    if (rawLines.length === 0 || (rawLines.length === 1 && rawLines[0] === "No matches found")) {
        return { lines: [], matchCount: 0, fileCount: 0 };
    }
    const files = new Set();
    let matchCount = 0;
    for (const line of rawLines) {
        const match = line.match(/^([^:\n]+):(\d+):/);
        if (match && match[1]) {
            matchCount++;
            files.add(match[1]);
        }
        else {
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
/**
 * Error result shared by all four tools: the first line collapsed (after `label: ` when given),
 * every line expanded, each painted `error`.
 */
function renderError(context, theme, output, { fallback, expanded, label }) {
    const errorLines = output ? output.split("\n") : [fallback];
    if (!expanded) {
        const first = theme.fg("error", errorLines[0] ?? "error");
        return createOrUpdateLines(context, [label === undefined ? first : `${theme.fg("accent", label)}: ${first}`]);
    }
    return createOrUpdateLines(context, errorLines.map((line) => theme.fg("error", line)));
}
/** Expanded grep/find/ls listing: the first 10 rows, then a count of the rest. */
function firstTen(lines, theme) {
    const display = lines.slice(0, 10).map((line) => theme.fg("toolOutput", line));
    if (lines.length > 10) {
        display.push(theme.fg("muted", `… ${lines.length - 10} more`));
    }
    return display;
}
// -----------------------------------------------------------------------------
// read renderer
// -----------------------------------------------------------------------------
function renderReadCall(args, theme, context) {
    const rawPath = String(args?.path ?? args?.file_path ?? "");
    const relPath = formatRelativePath(rawPath, context.cwd);
    const start = args?.offset ?? 1;
    const end = args?.limit !== undefined ? start + args.limit - 1 : "";
    const hasRange = args?.offset !== undefined || args?.limit !== undefined;
    const rangeStr = hasRange ? `:${start}${end ? `-${end}` : ""}` : "";
    const callText = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", relPath)}${rangeStr ? theme.fg("warning", rangeStr) : ""}`;
    return createOrUpdateLines(context, [callText]);
}
function renderReadResult(result, options, theme, context) {
    const rawPath = String(context.args?.path ?? context.args?.file_path ?? "");
    const relPath = formatRelativePath(rawPath, context.cwd);
    const output = textContent(result).replace(/\r/g, "");
    if (isErrorResult(result, context)) {
        return renderError(context, theme, output, { fallback: "Error reading file", expanded: options.expanded, label: relPath });
    }
    let renderedLines;
    try {
        const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
        renderedLines = highlightCode(replaceTabs(output), lang);
    }
    catch {
        renderedLines = output.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line)));
    }
    const lines = trimTrailingEmptyLines(renderedLines);
    const totalLines = result.details?.truncation?.totalLines ?? lines.length;
    if (!options.expanded) {
        // grok content rule: collapsed always states the line count. The call line already shows
        // any offset/limit range, so repeating it here would just duplicate the call verbatim.
        const suffix = ` ${theme.fg("muted", `(${totalLines} ${totalLines === 1 ? "line" : "lines"})`)}`;
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
export const readRenderers = {
    renderCall: renderReadCall,
    renderResult: renderReadResult,
};
// -----------------------------------------------------------------------------
// grep renderer
// -----------------------------------------------------------------------------
function renderGrepCall(args, theme, context) {
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
function renderGrepResult(result, options, theme, context) {
    const output = textContent(result);
    if (isErrorResult(result, context)) {
        return renderError(context, theme, output, { fallback: "Error executing grep", expanded: options.expanded });
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
    return createOrUpdateLines(context, firstTen(lines, theme));
}
export const grepRenderers = {
    renderCall: renderGrepCall,
    renderResult: renderGrepResult,
};
// -----------------------------------------------------------------------------
// find and ls renderers
// -----------------------------------------------------------------------------
/**
 * find and ls results: collapsed is `<label> (N entries)`, expanded lists the entries, and Pi's
 * empty-result message comes back as the muted `emptyMarker`.
 */
function entryListResult(toolName, emptyMarker, labelOf) {
    return (result, options, theme, context) => {
        const output = textContent(result);
        if (isErrorResult(result, context)) {
            return renderError(context, theme, output, { fallback: `Error executing ${toolName}`, expanded: options.expanded });
        }
        const entries = parseEntryLines(output, emptyMarker);
        const count = entries.length;
        if (!options.expanded) {
            const entryText = `(${count} ${count === 1 ? "entry" : "entries"})`;
            const line = `${theme.fg("accent", labelOf(context))} ${theme.fg("muted", entryText)}`;
            return createOrUpdateLines(context, [line]);
        }
        if (entries.length === 0) {
            return createOrUpdateLines(context, [theme.fg("muted", emptyMarker)]);
        }
        return createOrUpdateLines(context, firstTen(entries, theme));
    };
}
function renderFindCall(args, theme, context) {
    const pattern = args?.pattern ?? "";
    let callText = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
    if (args?.path) {
        callText += ` in ${theme.fg("accent", formatRelativePath(args.path, context.cwd))}`;
    }
    return createOrUpdateLines(context, [callText]);
}
export const findRenderers = {
    renderCall: renderFindCall,
    renderResult: entryListResult("find", "No files found matching pattern", (context) => context.args?.pattern ?? ""),
};
function renderLsCall(args, theme, context) {
    const relPath = formatRelativePath(args?.path ?? ".", context.cwd);
    const callText = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", relPath)}`;
    return createOrUpdateLines(context, [callText]);
}
export const lsRenderers = {
    renderCall: renderLsCall,
    renderResult: entryListResult("ls", "(empty directory)", (context) => formatRelativePath(context.args?.path ?? ".", context.cwd)),
};
// -----------------------------------------------------------------------------
// Combined map keyed by tool name
// -----------------------------------------------------------------------------
export const readOnlyRenderers = {
    read: readRenderers,
    grep: grepRenderers,
    find: findRenderers,
    ls: lsRenderers,
};
//# sourceMappingURL=read-only.js.map