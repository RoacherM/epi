// A line diff with line numbers and in-line emphasis, from Pi's own `diff` package (pi-internals
// row `pi-diff-package`: a dependency of pi-coding-agent, not of MMP, resolved from Pi's install).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { printable } from "./files.js";
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { structuredPatch, diffWordsWithSpace } = (await import(pathToFileURL(createRequire(piEntry).resolve("diff")).href));
/** Lines of context around each change. */
const CONTEXT = 3;
/** Above this many edits the diff is not computed: a full rewrite of a large file would block the
 * screen for seconds. The full file can still be shown. */
const MAX_EDIT_LENGTH = 5000;
/** Word emphasis is skipped for a pair of lines longer than this together: the word diff has no
 * limit of its own and grows with the square of the length (a 50 KB minified line took 3 s). */
const MAX_EMPHASIS_CHARS = 2000;
/** Text as it is drawn: one form for both sides, so the diff matches what the viewer shows. */
export function displayLines(text) {
    if (text === "")
        return []; // an empty or absent file has no lines, not one empty line
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => printable(line.replace(/\t/g, "    ")));
    if (lines.length > 1 && lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
/** Changed parts of a removed line and the added line paired with it; none when the lines have
 * too little in common for the emphasis to help. */
function emphasize(removed, added) {
    if (removed.text.length + added.text.length > MAX_EMPHASIS_CHARS)
        return;
    const parts = diffWordsWithSpace(removed.text, added.text);
    const common = parts.filter((part) => !part.added && !part.removed).reduce((sum, part) => sum + part.value.length, 0);
    if (common * 3 < Math.max(removed.text.length, added.text.length))
        return;
    const oldRanges = [];
    const newRanges = [];
    let oldAt = 0;
    let newAt = 0;
    for (const part of parts) {
        if (part.removed)
            oldRanges.push([oldAt, (oldAt += part.value.length)]);
        else if (part.added)
            newRanges.push([newAt, (newAt += part.value.length)]);
        else {
            oldAt += part.value.length;
            newAt += part.value.length;
        }
    }
    removed.emphasis = oldRanges;
    added.emphasis = newRanges;
}
/** Pairs each run of removed lines with the run of added lines right after it, line by line. */
function emphasizeRuns(rows, from) {
    for (let at = from; at < rows.length;) {
        if (rows[at].kind !== "remove") {
            at += 1;
            continue;
        }
        const removedStart = at;
        while (at < rows.length && rows[at].kind === "remove")
            at += 1;
        const addedStart = at;
        while (at < rows.length && rows[at].kind === "add")
            at += 1;
        const pairs = Math.min(addedStart - removedStart, at - addedStart);
        for (let pair = 0; pair < pairs; pair += 1)
            emphasize(rows[removedStart + pair], rows[addedStart + pair]);
    }
}
/** The diff from `before` to `after`, or undefined when there are too many changes to compute. */
export function diffTexts(before, after) {
    const oldLines = displayLines(before);
    const newLines = displayLines(after);
    const asText = (lines) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    const patch = structuredPatch("", "", asText(oldLines), asText(newLines), "", "", {
        context: CONTEXT,
        maxEditLength: MAX_EDIT_LENGTH,
    });
    if (patch === undefined)
        return undefined;
    const diff = { rows: [], added: 0, removed: 0, changeStarts: [] };
    let previousOldEnd = 1;
    for (const hunk of patch.hunks) {
        const skipped = hunk.oldStart - previousOldEnd;
        if (skipped > 0)
            diff.rows.push({ kind: "gap", text: String(skipped) });
        const hunkStart = diff.rows.length;
        let oldNo = hunk.oldStart;
        let newNo = hunk.newStart;
        let inChange = false;
        for (const line of hunk.lines) {
            const sign = line[0];
            const text = line.slice(1);
            if (sign === "\\")
                continue; // "\ No newline at end of file"
            if (sign === " ") {
                diff.rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
                inChange = false;
                continue;
            }
            if (!inChange)
                diff.changeStarts.push(diff.rows.length);
            inChange = true;
            if (sign === "-") {
                diff.rows.push({ kind: "remove", oldNo: oldNo++, text });
                diff.removed += 1;
            }
            else {
                diff.rows.push({ kind: "add", newNo: newNo++, text });
                diff.added += 1;
            }
        }
        previousOldEnd = oldNo;
        emphasizeRuns(diff.rows, hunkStart);
    }
    const tail = oldLines.length + 1 - previousOldEnd;
    if (patch.hunks.length > 0 && tail > 0)
        diff.rows.push({ kind: "gap", text: String(tail) });
    return diff;
}
//# sourceMappingURL=diff.js.map