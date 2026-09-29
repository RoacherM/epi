// User `!` / `!!` shell commands (docs/tui-design.md 4.2, 7). Behaviour mirrors Pi's
// `handleBashCommand` (interactive-mode.js): emit `user_bash` so extensions can intercept, then
// `session.executeBash`, which already records the result into session history and LLM context
// (excluded when `excludeFromContext`). MMP draws its own grok-style frame instead of reusing Pi's
// exported `BashExecutionComponent` (rail `┃` + `◆`, matching tools/block.ts).
import { keyText } from "@earendil-works/pi-coding-agent";
import { errorText } from "./errors.js";
import { piTui } from "./pi-tui.js";
// Matches tools/block.ts: a rail column, then 2 columns of padding before the `◆` bullet; output
// lines sit two columns further in, under the bullet's text.
const CALL_PREFIX = 3;
const RESULT_PREFIX = CALL_PREFIX + 2;
/** grok truncation rule (4.2): up to 5 lines shown in full, otherwise first 2 + an ellipsis + last 3. */
export function truncateBashOutput(lines) {
    if (lines.length <= 5)
        return lines;
    return [...lines.slice(0, 2), `… +${lines.length - 5} lines`, ...lines.slice(-3)];
}
export class UserBashBlock {
    theme;
    command;
    excludeFromContext;
    outputLines = [];
    status = "running";
    exitCode;
    constructor(theme, command, excludeFromContext) {
        this.theme = theme;
        this.command = command;
        this.excludeFromContext = excludeFromContext;
    }
    /** Replays a finished `bashExecution` session message after /new, /resume or /reload. */
    static fromMessage(theme, message) {
        const block = new UserBashBlock(theme, message.command, message.excludeFromContext ?? false);
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
    setComplete(exitCode, cancelled) {
        this.exitCode = exitCode;
        this.status = cancelled ? "cancelled" : exitCode === undefined || exitCode !== 0 ? "error" : "done";
    }
    render(width) {
        const running = this.status === "running";
        const rail = running ? this.theme.fg("accent", "┃") : " ";
        const bulletTone = running ? "accent" : this.status === "error" ? "error" : "muted";
        const bullet = this.theme.fg(bulletTone, "◆ ");
        const verb = this.excludeFromContext ? "!!" : "$";
        const callLine = `${rail}${" ".repeat(CALL_PREFIX - 1)}${bullet}${this.theme.fg("bashMode", this.theme.bold(`${verb} ${this.command}`))}`;
        // Drop the single trailing newline most commands leave, so it doesn't render as a blank row.
        const text = this.outputLines.join("\n").replace(/\n$/, "");
        const lines = text === "" ? [] : text.split("\n");
        // While running, show the live tail (matches tools/mutating.ts bashRenderers' `isPartial` case);
        // once finished, apply the fixed head/ellipsis/tail rule instead.
        const shown = running ? lines.slice(-3) : truncateBashOutput(lines);
        const bodyPrefix = `${rail}${" ".repeat(RESULT_PREFIX - 1)}`;
        const body = shown.map((entry) => bodyPrefix + this.theme.fg("toolOutput", entry));
        const statusLine = running
            ? `${bodyPrefix}${this.theme.fg("muted", `Running… (${keyText("app.interrupt")} to cancel)`)}`
            : this.status === "cancelled"
                ? `${bodyPrefix}${this.theme.fg("warning", "(cancelled)")}`
                : this.status === "error"
                    ? `${bodyPrefix}${this.theme.fg("error", this.exitCode === undefined ? "failed" : `exit ${this.exitCode}`)}`
                    : `${bodyPrefix}${this.theme.fg("muted", "exit 0")}`;
        return [callLine, ...body, statusLine].map((line) => piTui.truncateToWidth(line, width));
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
    // Let extensions intercept before MMP runs anything locally (docs 4.2, `user_bash`).
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
    const block = new UserBashBlock(host.theme, command, excludeFromContext);
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