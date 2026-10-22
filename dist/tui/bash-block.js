// User `!` / `!!` shell commands (docs/tui-design.md 4.2, 7). Behaviour mirrors Pi's
// `handleBashCommand` (interactive-mode.js): emit `user_bash` so extensions can intercept, then
// `session.executeBash`, which already records the result into session history and LLM context
// (excluded when `excludeFromContext`). Epi draws its own frame instead of reusing Pi's exported
// `BashExecutionComponent`, laid out like the model's bash call (tools/block.ts, tools/mutating.ts).
import { keyText } from "@earendil-works/pi-coding-agent";
import { displayNow, drawAt } from "./clock.js";
import { errorText } from "./errors.js";
import { GLYPHS, paintMarker, renderThroughLanding, takePhase } from "./glyphs.js";
import { TURN_COLUMNS } from "./measure.js";
import { piTui } from "./pi-tui.js";
import { durationBar, failureRow, fitCallRow, formatToolDuration, shortenCommand, truncateOutputLines } from "./tools/common.js";
// Matches tools/block.ts: a rail column, then 2 columns of padding before the marker (the rotating x
// while it runs, then `$` or `!!`); output lines sit two columns further in, under the marker's text.
const CALL_PREFIX = 3;
const RESULT_PREFIX = CALL_PREFIX + 2;
/**
 * grok truncation rule (4.2) with a plain ellipsis row; `render` then paints every row, the ellipsis
 * included, `toolOutput` (the model's bash block paints it `muted`; both kept, 8.4).
 */
export function truncateBashOutput(lines) {
    return truncateOutputLines(lines, (text) => text);
}
export class UserBashBlock {
    theme;
    command;
    excludeFromContext;
    onInspect;
    requestRender;
    spineRole = "bash";
    clockLive = true;
    // The time this block last showed with a live clock (spine.ts ClockGated).
    shownAt;
    outputLines = [];
    status = "running";
    exitCode;
    /** Live runs only: a replayed `bashExecution` message has no duration, so it shows none. */
    startedAt = Date.now();
    durationMs;
    /** When a run drawn while it ran ended: its marker shakes then (glyphs.ts). */
    endedAt;
    shownRunning = false;
    phase = takePhase();
    constructor(theme, command, excludeFromContext, 
    // Opens the full output from the `… +N lines` row of a finished, truncated block.
    onInspect, 
    // Draws the landing shake when nothing else redraws (a `!cmd` alone has no turn status ticking).
    requestRender) {
        this.theme = theme;
        this.command = command;
        this.excludeFromContext = excludeFromContext;
        this.onInspect = onInspect;
        this.requestRender = requestRender;
    }
    /** Replays a finished `bashExecution` session message after /new, /resume or /reload. */
    static fromMessage(theme, message, onInspect) {
        const block = new UserBashBlock(theme, message.command, message.excludeFromContext ?? false, onInspect);
        block.startedAt = undefined;
        if (message.output)
            block.appendOutput(message.output);
        block.setComplete(message.exitCode, message.cancelled);
        return block;
    }
    appendOutput(chunk) {
        const clean = piTui.stripTerminalSequences(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const parts = clean.split("\n");
        if (this.outputLines.length === 0)
            this.outputLines.push("");
        // Append to the last (possibly incomplete) line, same as Pi's BashExecutionComponent.
        this.outputLines[this.outputLines.length - 1] += parts[0] ?? "";
        this.outputLines.push(...parts.slice(1));
    }
    get spineRunning() {
        return this.status === "running";
    }
    setComplete(exitCode, cancelled) {
        this.exitCode = exitCode;
        this.status = cancelled ? "cancelled" : exitCode === undefined || exitCode !== 0 ? "error" : "done";
        if (this.startedAt === undefined)
            return;
        this.durationMs = Date.now() - this.startedAt;
        if (!this.shownRunning)
            return;
        this.endedAt = Date.now();
        if (this.requestRender !== undefined)
            renderThroughLanding(this.requestRender);
    }
    /** The output as lines, without the single trailing newline most commands leave. */
    lines() {
        const text = this.outputLines.join("\n").replace(/\n$/, "");
        return text === "" ? [] : text.split("\n");
    }
    /** Same layout as a model's bash call (tools/mutating.ts): the marker, the shortened command and
     * a tail that is never cut; output rows under it; a status row only while running, when
     * cancelled, or when the command failed. */
    render(width) {
        const running = this.status === "running";
        if (this.clockLive) {
            this.shownAt = Date.now();
            return this.draw(width, running);
        }
        return drawAt(this.shownAt, () => this.draw(width, running));
    }
    draw(width, running) {
        if (running)
            this.shownRunning = true;
        const glyph = this.excludeFromContext ? "!!" : GLYPHS.shell;
        const marker = paintMarker(this.theme, {
            state: running ? "running" : this.status === "error" ? "error" : "done",
            glyph,
            color: "bashMode",
            endedAt: this.endedAt,
            phase: this.phase,
            lead: this.excludeFromContext ? "!" : "",
        });
        const { text, extraLines } = shortenCommand(this.command, undefined);
        const extra = extraLines > 0 ? this.theme.fg("dim", ` · +${extraLines} lines`) : "";
        // The same column and bar as a model's call row (docs/tui-one-column-design.md §2.2): the time so
        // far while it runs, the final time once done; a failure or a cancel draws none.
        const ms = this.status === "done" ? this.durationMs : running && this.startedAt !== undefined ? Math.max(0, displayNow() - this.startedAt) : undefined;
        const bar = ms === undefined ? "" : durationBar(this.theme, ms);
        const fallback = this.status === "done" && ms !== undefined ? `  ${this.theme.fg("dim", formatToolDuration(ms))}` : "";
        const callPrefix = `${" ".repeat(CALL_PREFIX)}${marker} `;
        const body = fitCallRow({ body: this.theme.fg("toolOutput", text), tail: extra, bar, fallbackTime: fallback }, Math.max(1, width - piTui.visibleWidth(callPrefix)), this.theme.fg("dim", "…"));
        const callLine = callPrefix + body;
        const lines = this.lines();
        // While running, show the live tail (matches tools/mutating.ts bashRenderers' `isPartial` case);
        // once finished, apply the fixed head/ellipsis/tail rule instead.
        const shown = running ? lines.slice(-3) : truncateBashOutput(lines);
        const bodyPrefix = " ".repeat(RESULT_PREFIX);
        const rows = shown.map((entry) => bodyPrefix + this.theme.fg("toolOutput", entry));
        const status = this.statusText();
        // The failure row ends at the column's edge, like a model's (tools/block.ts).
        if (status !== undefined)
            rows.push(bodyPrefix + piTui.truncateToWidth(status, Math.max(1, Math.min(width, TURN_COLUMNS) - RESULT_PREFIX), "…"));
        return [callLine, ...rows].map((line) => piTui.truncateToWidth(line, width));
    }
    statusText() {
        if (this.status === "running")
            return this.theme.fg("muted", `Running… (${keyText("app.interrupt")} to cancel)`);
        if (this.status === "cancelled")
            return this.theme.fg("warning", "(cancelled)");
        if (this.status === "error")
            return failureRow(this.theme, this.exitCode === undefined ? "failed" : `exit ${this.exitCode}`);
        return undefined;
    }
    /** The `… +N lines` row (the call line, then two output rows above it) opens the full output. */
    handleMouse(event) {
        if (event.type !== "click" || event.button !== "left" || this.onInspect === undefined)
            return undefined;
        if (this.status === "running" || event.y !== 3)
            return undefined;
        const lines = this.lines();
        if (truncateBashOutput(lines).length === lines.length)
            return undefined;
        const exit = this.status === "cancelled" ? "cancelled" : this.exitCode === undefined ? "failed" : `exit ${this.exitCode}`;
        this.onInspect({
            title: `${this.excludeFromContext ? "!!" : "$"} ${this.command}`,
            subtitle: `${lines.length} lines · ${exit}`,
            lines: lines.map((line) => this.theme.fg("toolOutput", line)),
            firstLineNumber: 1,
            text: lines.join("\n"),
        });
        return { handled: true };
    }
    invalidate() { }
}
/**
 * Handles a submitted `!cmd` / `!!cmd`. Returns false for anything else, so the caller falls
 * through to a normal prompt submit (an empty `!` with no command included, same as Pi).
 */
export async function runUserBash(host, text) {
    if (!text.startsWith("!"))
        return false;
    const excludeFromContext = text.startsWith("!!");
    const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim();
    if (command === "")
        return false;
    const session = host.session();
    if (session.isBashRunning) {
        host.notice("A bash command is already running. Press Esc to cancel it first.", "warning");
        host.setEditorText(text);
        return true;
    }
    // Let extensions intercept before Epi runs anything locally (docs 4.2, `user_bash`).
    let eventResult;
    try {
        eventResult = await session.extensionRunner.emitUserBash({
            type: "user_bash",
            command,
            excludeFromContext,
            cwd: session.sessionManager.getCwd(),
        });
    }
    catch {
        // The extension runner already reported the error; no local fallback (matches Pi).
        return true;
    }
    const block = new UserBashBlock(host.theme, command, excludeFromContext, (target) => host.inspect(target), () => host.tui.requestRender());
    host.addBlock(block);
    if (eventResult?.result) {
        const result = eventResult.result;
        if (result.output)
            block.appendOutput(result.output);
        block.setComplete(result.exitCode, result.cancelled);
        session.recordBashResult(command, result, { excludeFromContext });
        host.tui.requestRender();
        return true;
    }
    try {
        const result = await session.executeBash(command, (chunk) => {
            block.appendOutput(chunk);
            host.tui.requestRender();
        }, eventResult?.operations === undefined
            ? { excludeFromContext }
            : { excludeFromContext, operations: eventResult.operations });
        block.setComplete(result.exitCode, result.cancelled);
    }
    catch (error) {
        block.setComplete(undefined, false);
        host.notice(`Bash command failed: ${errorText(error)}`, "error");
    }
    host.tui.requestRender();
    return true;
}
//# sourceMappingURL=bash-block.js.map