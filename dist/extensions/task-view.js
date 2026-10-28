// What a subagent job looks like in the inspector (docs/subagents-design.md §11.5): its status, the
// task it was given, and its conversation so far, read from the job's own session file. Pure text:
// task.ts opens it and refreshes it while the job runs.
import { readFileSync } from "node:fs";
import { singleLine } from "../task-result.js";
/** Characters of one tool result the view keeps; the whole result is in the session file. */
const RESULT_PREVIEW_CHARS = 600;
/** Characters of one tool call's arguments on its line. */
const ARGS_PREVIEW_CHARS = 160;
function parts(content) {
    if (typeof content === "string")
        return [{ type: "text", text: content }];
    return Array.isArray(content) ? content : [];
}
function textOf(content) {
    return parts(content).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
function argsLine(args) {
    if (args === undefined || args === null)
        return "";
    const record = args;
    for (const key of ["command", "path", "pattern", "url", "query", "task"]) {
        if (typeof record[key] === "string")
            return singleLine(record[key], ARGS_PREVIEW_CHARS);
    }
    return singleLine(JSON.stringify(args), ARGS_PREVIEW_CHARS);
}
/** An assistant message part as view lines: its text, a thinking line, or a tool-call line. */
function assistantPartLines(theme, part) {
    if (part.type === "text")
        return part.text?.trim() ? part.text.trim().split("\n") : [];
    if (part.type === "thinking")
        return part.thinking?.trim() ? [theme.fg("dim", `∴ ${singleLine(part.thinking, ARGS_PREVIEW_CHARS)}`)] : [];
    if (part.type === "toolCall")
        return [`${theme.fg("muted", "◆")} ${theme.fg("toolOutput", part.name ?? "tool")} ${theme.fg("muted", argsLine(part.arguments))}`];
    return [];
}
function toolResultLines(theme, message) {
    const text = textOf(message.content).trimEnd();
    const cut = text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text;
    const tone = message.isError === true ? "error" : "dim";
    const lines = cut === "" ? ["(no output)"] : cut.split("\n");
    return [...lines.map((line) => theme.fg(tone, `  ${line}`)), ""];
}
function messageLines(theme, message) {
    if (message.role === "user")
        return [theme.fg("accent", "❯ user"), ...textOf(message.content).split("\n"), ""];
    if (message.role === "toolResult")
        return toolResultLines(theme, message);
    if (message.role !== "assistant")
        return [];
    const out = parts(message.content).flatMap((part) => assistantPartLines(theme, part));
    return out.length === 0 ? [] : [theme.fg("accent", "◇ assistant"), ...out, ""];
}
/** The conversation in a job's session file, or a note saying why there is none yet. Pi writes the
 * file only once the first reply exists, and appends to it after each message. */
function conversationLines(theme, sessionPath) {
    let raw;
    try {
        raw = readFileSync(sessionPath, "utf8");
    }
    catch (error) {
        const code = error.code;
        return [theme.fg("muted", code === "ENOENT" ? "(no conversation yet: the session file appears after the first reply)" : `(cannot read ${sessionPath}: ${String(error)})`)];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue; // The last line can be half written while the child appends.
        }
        if (entry.type === "compaction")
            out.push(theme.fg("warning", `── compacted: ${singleLine(entry.summary ?? "", ARGS_PREVIEW_CHARS)}`), "");
        else if (entry.type === "message" && entry.message !== undefined)
            out.push(...messageLines(theme, entry.message));
    }
    return out;
}
function headerLines(theme, job) {
    const facts = [`turn ${job.turns ?? 0}`, `${job.steps ?? 0} steps`];
    if (job.compactions !== undefined && job.compactions > 0)
        facts.push(`${job.compactions} compactions`);
    const lines = [`${theme.fg("accent", job.agent ?? "task")} ${theme.bold(job.status)} ${theme.fg("muted", facts.join(" · "))}`];
    if (job.currentActivity !== undefined)
        lines.push(theme.fg("muted", `now: ${job.currentActivity}`));
    lines.push(theme.fg("dim", `session: ${job.sessionPath}`), "");
    return lines;
}
function outcomeLines(theme, job) {
    if (job.status === "failed" && job.error !== undefined)
        return [theme.fg("error", `✗ ${job.error}`)];
    if (job.status === "cancelled")
        return [theme.fg("warning", "cancelled")];
    return [];
}
/** The inspector target for `job`, built fresh: call it again to refresh a running job's view. */
export function taskViewTarget(theme, job) {
    const lines = [...headerLines(theme, job), ...conversationLines(theme, job.sessionPath), ...outcomeLines(theme, job)];
    const text = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    return { title: `task ${job.id.slice(0, 8)}`, subtitle: job.status, lines, text, wrap: true };
}
/** One row per job in the jobs list: `◐ 2be97ffa running reader · turn 3 · bash: npm test`. */
export function jobRow(theme, job) {
    const glyph = job.status === "completed" ? theme.fg("success", "✓")
        : job.status === "failed" ? theme.fg("error", "✗")
            : job.status === "running" ? theme.fg("accent", "◐")
                : theme.fg("muted", "·");
    const where = job.status === "running" ? `turn ${job.turns ?? 0}${job.currentActivity === undefined ? "" : ` · ${job.currentActivity}`}` : `${job.turns ?? 0} turns`;
    return `${glyph} ${theme.fg("muted", job.id.slice(0, 8))} ${job.status} ${theme.fg("accent", job.agent ?? "task")} · ${where} · ${singleLine(job.task ?? "", 60)}`;
}
//# sourceMappingURL=task-view.js.map