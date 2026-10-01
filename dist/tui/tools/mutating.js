// grok-build-style tool renderers for Pi built-in mutating tools: bash, edit, write.
// Renders tool invocations and results according to docs/tui-design.md and docs/tui-theme.md.
import { relative, resolve } from "node:path";
import { piTui } from "../pi-tui.js";
/** Component that renders lines truncated to the given viewport width. */
class TruncatedLinesComponent {
    lines;
    constructor(lines) {
        if (typeof lines === "string") {
            this.lines = lines ? lines.split("\n") : [];
        }
        else {
            this.lines = lines.flatMap((l) => l.split("\n"));
        }
    }
    render(width) {
        return this.lines.map((line) => piTui.truncateToWidth(line, width));
    }
    invalidate() { }
}
function extractText(result) {
    if (!result || !Array.isArray(result.content))
        return "";
    return result.content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
}
function parseBashOutput(rawText, isError) {
    let text = rawText.replace(/\r\n/g, "\n");
    let exitCode = isError ? 1 : 0;
    // Pi's bash tool appends status as the trailing paragraph on failure or termination.
    const statusMatch = text.match(/(?:^|\n\n)(Command exited with code (\d+)|Command terminated without an exit code|Command timed out after [^\n]+|Command aborted)$/);
    if (statusMatch && statusMatch.index !== undefined) {
        if (statusMatch[2] !== undefined) {
            exitCode = parseInt(statusMatch[2], 10);
        }
        else {
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
function formatCallLine(verb, args, theme, context) {
    const rawPath = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
    if (!rawPath) {
        return theme.bold(verb);
    }
    const cwd = context?.cwd;
    const relPath = cwd ? relative(cwd, resolve(cwd, rawPath)) : rawPath;
    return `${theme.bold(verb)} ${relPath}`;
}
function parseDiffString(diffStr) {
    const rawLines = diffStr.replace(/\r\n/g, "\n").split("\n");
    const lines = [];
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
        }
        else if (prefix === "-") {
            removals++;
            lines.push({ kind: "remove", lineNum, text });
        }
        else {
            lines.push({ kind: "context", lineNum, text });
        }
    }
    return { lines, additions, removals };
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
function collapseDiffContext(diffLines) {
    if (diffLines.length === 0)
        return [];
    const changeIndices = [];
    for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i];
        if (line && (line.kind === "add" || line.kind === "remove")) {
            changeIndices.push(i);
        }
    }
    if (changeIndices.length === 0) {
        if (diffLines.length <= 3) {
            return diffLines.map((diffLine) => ({ kind: "line", diffLine }));
        }
        return [{ kind: "collapsed", count: diffLines.length }];
    }
    const hunks = [];
    let hunkStart = changeIndices[0];
    let hunkEnd = hunkStart;
    for (let i = 1; i < changeIndices.length; i++) {
        const idx = changeIndices[i];
        if (idx === hunkEnd + 1) {
            hunkEnd = idx;
        }
        else {
            const firstLine = diffLines[hunkStart];
            const lastLine = diffLines[hunkEnd];
            hunks.push({
                startIdx: hunkStart,
                endIdx: hunkEnd,
                firstLineNum: firstLine.lineNum,
                lastLineNum: lastLine.lineNum,
            });
            hunkStart = idx;
            hunkEnd = idx;
        }
    }
    const firstLine = diffLines[hunkStart];
    const lastLine = diffLines[hunkEnd];
    hunks.push({
        startIdx: hunkStart,
        endIdx: hunkEnd,
        firstLineNum: firstLine.lineNum,
        lastLineNum: lastLine.lineNum,
    });
    const result = [];
    // Leading context: up to 3 context lines before first change hunk
    const firstHunk = hunks[0];
    const leading = diffLines.slice(0, firstHunk.startIdx);
    const leadingKept = leading.slice(-3);
    if (leadingKept.length > 0) {
        const skipped = leadingKept[0].lineNum - 1;
        if (skipped > 0) {
            result.push({ kind: "collapsed", count: skipped });
        }
        for (const line of leadingKept) {
            result.push({ kind: "line", diffLine: line });
        }
    }
    else if (firstHunk.firstLineNum > 1) {
        result.push({ kind: "collapsed", count: firstHunk.firstLineNum - 1 });
    }
    // Hunks and in-between context
    for (let h = 0; h < hunks.length; h++) {
        const curHunk = hunks[h];
        for (let i = curHunk.startIdx; i <= curHunk.endIdx; i++) {
            const line = diffLines[i];
            result.push({ kind: "line", diffLine: line });
        }
        if (h < hunks.length - 1) {
            const nextHunk = hunks[h + 1];
            const between = diffLines.slice(curHunk.endIdx + 1, nextHunk.startIdx);
            const consecutive = nextHunk.firstLineNum - curHunk.lastLineNum - 1 === between.length;
            if (between.length <= 6 && consecutive) {
                for (const line of between) {
                    result.push({ kind: "line", diffLine: line });
                }
            }
            else {
                const keptAfter = between.slice(0, 3);
                const keptBefore = between.slice(-3);
                for (const line of keptAfter) {
                    result.push({ kind: "line", diffLine: line });
                }
                const lastKept = keptAfter[keptAfter.length - 1]?.lineNum ?? curHunk.lastLineNum;
                const firstNext = keptBefore[0]?.lineNum ?? nextHunk.firstLineNum;
                const collapsed = firstNext - lastKept - 1;
                if (collapsed > 0) {
                    result.push({ kind: "collapsed", count: collapsed });
                }
                for (const line of keptBefore) {
                    result.push({ kind: "line", diffLine: line });
                }
            }
        }
    }
    // Trailing context: up to 3 context lines after last change hunk
    const lastHunk = hunks[hunks.length - 1];
    const trailing = diffLines.slice(lastHunk.endIdx + 1);
    const trailingKept = trailing.slice(0, 3);
    for (const line of trailingKept) {
        result.push({ kind: "line", diffLine: line });
    }
    if (trailing.length > 3) {
        result.push({ kind: "collapsed", count: trailing.length - 3 });
    }
    return result;
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
function renderUnifiedDiffResult(result, options, theme, context) {
    const isError = Boolean(context?.isError || result?.isError);
    if (isError) {
        const errorText = extractText(result) || "Error";
        const firstLine = errorText.split("\n")[0] ?? "Error";
        return new TruncatedLinesComponent(options.expanded ? theme.fg("error", errorText) : theme.fg("error", firstLine));
    }
    const details = result.details;
    const diffStr = details?.diff ?? "";
    const parsed = parseDiffString(diffStr);
    if (!options.expanded) {
        const summary = formatDiffSummary(parsed.additions, parsed.removals, theme);
        return new TruncatedLinesComponent(summary);
    }
    const items = collapseDiffContext(parsed.lines);
    const lines = renderDiffExpanded(items, theme);
    return new TruncatedLinesComponent(lines);
}
function renderWriteNewFileResult(contentStr, options, theme) {
    const clean = contentStr.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const lines = clean.length > 0 ? clean.split("\n") : [];
    const lineCount = lines.length;
    if (!options.expanded) {
        const label = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
        return new TruncatedLinesComponent(theme.fg("muted", label));
    }
    const displayLines = lines.slice(0, 10);
    const gutterWidth = Math.max(String(displayLines.length).length, 2);
    const rendered = displayLines.map((line, idx) => {
        const gutter = String(idx + 1).padStart(gutterWidth, " ");
        return theme.fg("toolDiffAdded", `${gutter} ${line}`);
    });
    return new TruncatedLinesComponent(rendered);
}
export const bashRenderers = {
    renderCall(args, theme) {
        const fullCommand = typeof args?.command === "string" ? args.command : "";
        const firstLine = fullCommand.split("\n")[0] ?? "";
        return new TruncatedLinesComponent(`$ ${theme.fg("bashMode", firstLine)}`);
    },
    renderResult(result, options, theme, context) {
        const isError = Boolean(context?.isError || result?.isError);
        const raw = extractText(result);
        const { exitCode, lines } = parseBashOutput(raw, isError);
        if (options.isPartial) {
            const partialLines = lines.length <= 3 ? lines : lines.slice(-3);
            return new TruncatedLinesComponent(partialLines.map((l) => theme.fg("toolOutput", l)));
        }
        if (!options.expanded) {
            const statusText = exitCode === 0
                ? theme.fg("muted", "exit 0")
                : theme.fg("error", `exit ${exitCode}`);
            return new TruncatedLinesComponent(statusText);
        }
        if (lines.length <= 5) {
            return new TruncatedLinesComponent(lines.map((l) => theme.fg("toolOutput", l)));
        }
        const skipped = lines.length - 5;
        const firstTwo = lines.slice(0, 2).map((l) => theme.fg("toolOutput", l));
        const ellipsisLine = theme.fg("muted", `… +${skipped} lines`);
        const lastThree = lines.slice(-3).map((l) => theme.fg("toolOutput", l));
        return new TruncatedLinesComponent([...firstTwo, ellipsisLine, ...lastThree]);
    },
};
export const editRenderers = {
    renderCall(args, theme, context) {
        return new TruncatedLinesComponent(formatCallLine("edit", args, theme, context));
    },
    renderResult(result, options, theme, context) {
        return renderUnifiedDiffResult(result, options, theme, context);
    },
};
export const writeRenderers = {
    renderCall(args, theme, context) {
        return new TruncatedLinesComponent(formatCallLine("write", args, theme, context));
    },
    renderResult(result, options, theme, context) {
        const isError = Boolean(context?.isError || result?.isError);
        if (isError) {
            const errorText = extractText(result) || "Error";
            const firstLine = errorText.split("\n")[0] ?? "Error";
            return new TruncatedLinesComponent(options.expanded ? theme.fg("error", errorText) : theme.fg("error", firstLine));
        }
        // Pi's write tool always returns `details: undefined` (write.js): it has no prior file
        // content to diff against, so there is no diff branch here, only the new-file line dump.
        const content = typeof context.args?.content === "string" ? context.args.content : "";
        return renderWriteNewFileResult(content, options, theme);
    },
};
export const mutatingRenderers = {
    bash: bashRenderers,
    edit: editRenderers,
    write: writeRenderers,
};
//# sourceMappingURL=mutating.js.map