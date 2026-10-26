// grok-build-style tool renderers for Pi built-in mutating tools: bash, edit, write.
// Renders tool invocations and results according to docs/tui-design.md and docs/tui-theme.md.
import { relative, resolve } from "node:path";
import { CallLine, failureRow, isErrorResult, LinesComponent, RUNNING_SLICE_ROWS, setCallSummary, shortenCommand, textContent, truncateOutputLines } from "./common.js";
/** Bash output without Pi's trailing status paragraph, and that status as a short label (`exit 2`,
 * `timed out after 30 seconds`); `failure` is undefined for a command that succeeded. */
function parseBashOutput(rawText, isError) {
    let text = rawText.replace(/\r\n/g, "\n");
    let failure = isError ? "failed" : undefined;
    // Pi's bash tool appends status as the trailing paragraph on failure or termination.
    const statusMatch = text.match(/(?:^|\n\n)(Command exited with code (\d+)|Command terminated without an exit code|Command timed out after [^\n]+|Command aborted)$/);
    if (statusMatch && statusMatch.index !== undefined && statusMatch[1] !== undefined) {
        failure = statusMatch[2] !== undefined ? `exit ${statusMatch[2]}` : statusMatch[1].replace(/^Command /, "");
        text = text.slice(0, statusMatch.index);
    }
    if (text === "(no output)") {
        text = "";
    }
    text = text.trimEnd();
    const lines = text.length > 0 ? text.split("\n") : [];
    return { failure, exitLabel: failure ?? "exit 0", lines };
}
/** `✗ exit 1 · <last output line>`: the status and the line most likely to say why. */
function bashFailureRow(theme, failure, lines) {
    const last = lines.findLast((line) => line.trim() !== "")?.trim();
    return failureRow(theme, last === undefined ? failure : `${failure} · ${last}`);
}
/** The file an edit/write call targets, relative to the cwd; "" when the call names none. */
function callPath(args, context) {
    const rawPath = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
    if (!rawPath)
        return "";
    const cwd = context?.cwd;
    return cwd ? relative(cwd, resolve(cwd, rawPath)) : rawPath;
}
function callLine(verb, args, theme, context, extra = "") {
    const relPath = callPath(args, context);
    const body = theme.fg("toolOutput", relPath ? `${verb} ${relPath}` : verb);
    return new CallLine("◆", theme, body, context, extra);
}
/** The inspector's title for an edit/write block: the call line, unstyled. */
function inspectTitle(verb, context) {
    const relPath = callPath(context.args, context);
    return relPath ? `${verb} ${relPath}` : verb;
}
/** Exported for test/pi-internals.test.mjs's `edit-diff-format` check (docs/pi-internals.md). */
export function parseDiffString(diffStr) {
    const rawLines = diffStr.replace(/\r\n/g, "\n").split("\n");
    const lines = [];
    let additions = 0;
    let removals = 0;
    let afterSkip = false;
    for (const rawLine of rawLines) {
        if (!rawLine || rawLine.startsWith("---") || rawLine.startsWith("+++")) {
            continue;
        }
        if (/^\s*\.\.\.\s*$/.test(rawLine)) {
            afterSkip = true;
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
            lines.push({ kind: "add", lineNum, text, afterSkip });
        }
        else if (prefix === "-") {
            removals++;
            lines.push({ kind: "remove", lineNum, text, afterSkip });
        }
        else {
            lines.push({ kind: "context", lineNum, text, afterSkip });
        }
        afterSkip = false;
    }
    return { lines, additions, removals, trailingSkipped: afterSkip };
}
function formatDiffSummary(additions, removals, theme) {
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
function lineItems(lines) {
    return lines.map((diffLine) => ({ kind: "line", diffLine }));
}
function findHunks(diffLines) {
    const hunks = [];
    diffLines.forEach((line, idx) => {
        if (line.kind === "context")
            return;
        const last = hunks[hunks.length - 1];
        if (last && last.endIdx === idx - 1) {
            last.endIdx = idx;
            last.lastLineNum = line.lineNum;
        }
        else {
            hunks.push({ startIdx: idx, endIdx: idx, firstLineNum: line.lineNum, lastLineNum: line.lineNum });
        }
    });
    return hunks;
}
/** Up to 3 context rows before the first hunk, after a count of every file line above them. */
function leadingContext(diffLines, firstHunk) {
    const kept = diffLines.slice(0, firstHunk.startIdx).slice(-3);
    const firstShown = kept[0]?.lineNum ?? firstHunk.firstLineNum;
    const skipped = firstShown - 1;
    return [...(skipped > 0 ? [{ kind: "collapsed", count: skipped }] : []), ...lineItems(kept)];
}
/**
 * Context between two hunks: all of it when it is short (≤6) and Pi sent it whole, otherwise 3 rows
 * after the earlier hunk, a count of the rest, and 3 rows before the later one.
 * Pi sent it whole exactly when no "..." marker splits it. Hunk line numbers can't tell: "+" rows carry
 * new-file numbers and the rest old-file numbers, which drift apart once a hunk changes the line count.
 */
function contextBetween(diffLines, hunk, next) {
    const between = diffLines.slice(hunk.endIdx + 1, next.startIdx);
    const skipIdx = between.findIndex((line) => line.afterSkip);
    const consecutive = skipIdx === -1;
    if (between.length <= 6 && consecutive)
        return lineItems(between);
    // Keep each side of the marker apart, so rows from before it never repeat after it.
    const keptAfter = (consecutive ? between : between.slice(0, skipIdx)).slice(0, 3);
    const keptBefore = (consecutive ? between : between.slice(skipIdx)).slice(-3);
    const lastKept = keptAfter[keptAfter.length - 1]?.lineNum ?? hunk.lastLineNum;
    const firstNext = keptBefore[0]?.lineNum ?? next.firstLineNum;
    const collapsed = firstNext - lastKept - 1;
    return [
        ...lineItems(keptAfter),
        ...(collapsed > 0 ? [{ kind: "collapsed", count: collapsed }] : []),
        ...lineItems(keptBefore),
    ];
}
/** Pi omits the file length, so a trailing skip marker means the hidden count is unknown. */
function trailingContext(diffLines, lastHunk, trailingSkipped) {
    const trailing = diffLines.slice(lastHunk.endIdx + 1);
    const gap = trailingSkipped
        ? [{ kind: "collapsed" }]
        : trailing.length > 3 ? [{ kind: "collapsed", count: trailing.length - 3 }] : [];
    return [...lineItems(trailing.slice(0, 3)), ...gap];
}
function collapseDiffContext(diffLines, trailingSkipped) {
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
        if (next !== undefined)
            items.push(...contextBetween(diffLines, hunk, next));
    });
    items.push(...trailingContext(diffLines, lastHunk, trailingSkipped));
    return items;
}
function renderDiffExpanded(items, theme) {
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
            return theme.fg("muted", `${indent} …${item.count === undefined ? "" : ` ${item.count} unchanged lines`}`);
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
/** edit and write errors: `✗` and the first line collapsed, the whole text expanded. */
function renderError(result, expanded, theme) {
    const errorText = textContent(result) || "Error";
    const [firstLine = "Error", ...rest] = errorText.split("\n");
    if (!expanded)
        return new LinesComponent([failureRow(theme, firstLine)], undefined, [0]);
    return new LinesComponent([failureRow(theme, firstLine), ...rest.map((line) => theme.fg("error", line))], undefined, [0]);
}
function renderUnifiedDiffResult(result, options, theme, context) {
    if (isErrorResult(result, context)) {
        return renderError(result, options.expanded, theme);
    }
    const details = result.details;
    const diffStr = details?.diff ?? "";
    const parsed = parseDiffString(diffStr);
    // The `+3 −1` sits on the call line; collapsed, a successful edit takes no row of its own.
    setCallSummary(context, formatDiffSummary(parsed.additions, parsed.removals, theme));
    if (!options.expanded)
        return new LinesComponent([]);
    const items = collapseDiffContext(parsed.lines, parsed.trailingSkipped);
    const lines = renderDiffExpanded(items, theme);
    // Each `… N unchanged lines` row opens the whole diff Pi returned, uncollapsed.
    const rows = items.flatMap((item, index) => (item.kind === "collapsed" ? [index] : []));
    if (rows.length === 0)
        return new LinesComponent(lines);
    const target = {
        title: inspectTitle("edit", context),
        subtitle: `+${parsed.additions} −${parsed.removals}`,
        lines: renderDiffExpanded(lineItems(parsed.lines), theme),
        text: diffStr,
    };
    return new LinesComponent(lines, { rows, target });
}
function renderWriteNewFileResult(contentStr, options, theme, title) {
    const lines = writtenLines(contentStr);
    const clean = lines.join("\n");
    const lineCount = lines.length;
    // The line count sits on the call line (writeRenderers.renderCall).
    if (!options.expanded)
        return new LinesComponent([]);
    const displayLines = lines.slice(0, 10);
    const gutterWidth = Math.max(String(displayLines.length).length, 2);
    const rendered = displayLines.map((line, idx) => {
        const gutter = String(idx + 1).padStart(gutterWidth, " ");
        return theme.fg("toolDiffAdded", `${gutter} ${line}`);
    });
    if (lines.length <= displayLines.length)
        return new LinesComponent(rendered);
    // The rest of the file opens in the inspector from this row.
    rendered.push(theme.fg("muted", `… ${lines.length - displayLines.length} more lines`));
    const target = {
        title,
        subtitle: `${lineCount} lines`,
        lines: lines.map((line) => theme.fg("toolDiffAdded", line.replace(/\t/g, "   "))),
        firstLineNumber: 1,
        text: clean,
    };
    return new LinesComponent(rendered, { rows: [displayLines.length], target });
}
/** The file's lines as written, without the final newline most files end with. */
function writtenLines(content) {
    const clean = content.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return clean.length > 0 ? clean.split("\n") : [];
}
export const bashRenderers = {
    renderCall(args, theme, context) {
        const fullCommand = typeof args?.command === "string" ? args.command : "";
        const { text, extraLines } = shortenCommand(fullCommand, context.cwd);
        const extra = extraLines > 0 ? theme.fg("dim", `+${extraLines} lines`) : "";
        return new CallLine("$", theme, theme.fg("toolOutput", text), context, extra);
    },
    renderResult(result, options, theme, context) {
        const { failure, exitLabel, lines } = parseBashOutput(textContent(result), isErrorResult(result, context));
        // The running slice: the newest lines while it runs (all of them when opened); it folds away as
        // soon as the result lands.
        if (options.isPartial)
            return new LinesComponent((options.expanded ? lines : lines.slice(-RUNNING_SLICE_ROWS)).map((l) => theme.fg("toolOutput", l)));
        // Success is the normal case and takes no row (docs/tui-transcript-layout-design.md R4): the
        // call line's run time says it finished. Only a failure gets a row, collapsed or not.
        const failureRows = failure === undefined ? [] : [bashFailureRow(theme, failure, lines)];
        if (!options.expanded)
            return new LinesComponent(failureRows, undefined, failureRows.map((_, row) => row));
        const painted = lines.map((l) => theme.fg("toolOutput", l));
        const shown = truncateOutputLines(painted, (text) => theme.fg("muted", text));
        const failureAt = failureRows.map((_, row) => shown.length + row);
        if (shown.length === painted.length)
            return new LinesComponent([...shown, ...failureRows], undefined, failureAt);
        // truncateOutputLines's ellipsis row (index 2) opens every line of the output.
        const command = typeof context.args?.command === "string" ? context.args.command : "";
        const target = {
            title: `$ ${command.split("\n")[0] ?? ""}`,
            subtitle: `${lines.length} lines · ${exitLabel}`,
            lines: painted,
            firstLineNumber: 1,
            text: lines.join("\n"),
        };
        return new LinesComponent([...shown, ...failureRows], { rows: [2], target }, failureAt);
    },
};
export const editRenderers = {
    renderCall(args, theme, context) {
        return callLine("edit", args, theme, context);
    },
    renderResult(result, options, theme, context) {
        return renderUnifiedDiffResult(result, options, theme, context);
    },
};
export const writeRenderers = {
    renderCall(args, theme, context) {
        const count = typeof args?.content === "string" ? writtenLines(args.content).length : undefined;
        const extra = count === undefined ? "" : theme.fg("dim", `${count} ${count === 1 ? "line" : "lines"}`);
        return callLine("write", args, theme, context, extra);
    },
    renderResult(result, options, theme, context) {
        if (isErrorResult(result, context)) {
            return renderError(result, options.expanded, theme);
        }
        // Pi's write tool always returns `details: undefined` (write.js): it has no prior file
        // content to diff against, so there is no diff branch here, only the new-file line dump.
        const content = typeof context.args?.content === "string" ? context.args.content : "";
        return renderWriteNewFileResult(content, options, theme, inspectTitle("write", context));
    },
};
export const mutatingRenderers = {
    bash: bashRenderers,
    edit: editRenderers,
    write: writeRenderers,
};
//# sourceMappingURL=mutating.js.map