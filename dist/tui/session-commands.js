// /compact, /resume, /thinking, /copy (and the app.message.copy key), /reload
// (docs/tui-design.md 4.6); registered in builtins.ts and keys.ts.
// The flows follow Pi's interactive mode, built from the components Pi exports.
import { copyToClipboard, SessionManager, SessionSelectorComponent, ThinkingSelectorComponent, } from "@earendil-works/pi-coding-agent";
import { crossProjectRefusal } from "./project-guard.js";
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Pi's handleCompactCommand ignores the throw: compact() already emitted a `compaction_end`
 * event with the failure reason, which transcript.ts turns into a notice. Pi does not refuse
 * this command while a turn is running either; `session.compact` aborts it first. */
export async function runCompact(host, customInstructions) {
    const trimmed = customInstructions.trim();
    try {
        await host.session().compact(trimmed === "" ? undefined : trimmed);
    }
    catch {
        // Ignore: already reported via the compaction_end event.
    }
}
/** `/resume`: session selector for the current cwd (Tab switches to "all", like Pi's). Picking a
 * session hands off to `runtime.switchSession`, whose rebind callback (app.ts's `bind`) replays
 * the transcript. Sessions only ever come from the session manager's own directory, which MMP
 * points at `~/.mmp/pi/sessions` (never Pi's `~/.pi/agent`); see services.ts and paths.ts. */
export async function runResume(host) {
    const sessionManager = host.session().sessionManager;
    await new Promise((resolve) => {
        let restore = () => { };
        const selector = new SessionSelectorComponent((onProgress, signal) => SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir(), onProgress, signal), (onProgress, signal) => sessionManager.usesDefaultSessionDir()
            ? SessionManager.listAll(onProgress, signal)
            : SessionManager.listAll(sessionManager.getSessionDir(), onProgress, signal), (sessionPath) => {
            restore();
            void resumeSession(host, sessionPath).then(resolve);
        }, () => {
            restore();
            resolve();
        }, () => {
            restore();
            resolve();
            void host.exit(0);
        }, () => host.tui.requestRender(), undefined, sessionManager.getSessionFile());
        restore = host.takeEditorSlot(selector);
    });
}
async function resumeSession(host, sessionPath) {
    try {
        // Check before the runtime tears down the current session (docs/tui-design.md §15): a refused
        // switch must leave the running session exactly as it was.
        const refusal = crossProjectRefusal(sessionPath, host.projectIdentity);
        if (refusal !== undefined) {
            host.notice(refusal, "warning");
            return;
        }
        const result = await host.runtime.switchSession(sessionPath);
        if (!result.cancelled)
            host.notice("Resumed session.");
    }
    catch (error) {
        host.notice(`Could not resume session: ${errorText(error)}`, "error");
    }
}
/** `/thinking [level]`: set directly when the level is valid for the current model, otherwise
 * open the selector (also reachable with no argument). */
export async function runThinking(host, levelArg) {
    const session = host.session();
    const trimmed = levelArg.trim().toLowerCase();
    if (trimmed !== "") {
        const available = session.getAvailableThinkingLevels();
        const level = available.find((candidate) => candidate.toLowerCase() === trimmed);
        if (level === undefined) {
            host.notice(`Unknown thinking level "${levelArg.trim()}". Available levels: ${available.join(", ")}.`, "error");
            return;
        }
        selectThinkingLevel(host, level, false);
        return;
    }
    await new Promise((resolve) => {
        let restore = () => { };
        const selectLevel = (level, persist) => {
            restore();
            selectThinkingLevel(host, level, persist);
            resolve();
        };
        const selector = new ThinkingSelectorComponent(session.thinkingLevel, session.getAvailableThinkingLevels(), (level) => selectLevel(level, false), () => {
            restore();
            resolve();
        }, (level) => selectLevel(level, true), session.settingsManager.getDefaultThinkingLevel());
        restore = host.takeEditorSlot(selector);
    });
}
function selectThinkingLevel(host, level, persist) {
    try {
        host.session().setThinkingLevel(level, { persist });
        host.notice(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
    }
    catch (error) {
        host.notice(errorText(error), "error");
    }
}
/** `/copy` and the `app.message.copy` key: copy the last assistant reply to the clipboard.
 * Pi also prefers a live mouse-selection when the key triggers it from `TuiAltScreen`; MMP has no
 * such selection state wired into CommandHost yet, so this always copies the last assistant text. */
export async function runCopy(host) {
    const text = host.session().getLastAssistantText();
    if (text === undefined) {
        host.notice("No agent messages to copy yet.", "warning");
        return;
    }
    try {
        await copyToClipboard(text);
        host.notice("Copied last agent message to clipboard.");
    }
    catch (error) {
        host.notice(errorText(error), "error");
    }
}
/** `/reload`: like Pi, refuse while a turn or compaction is running, then `session.reload()` and
 * rebuild the host state it doesn't cover (docs/tui-design.md 6.3) via `host.reloadSession`. */
export async function runReload(host) {
    const session = host.session();
    if (session.isStreaming) {
        host.notice("Wait for the current response to finish before reloading.", "warning");
        return;
    }
    if (session.isCompacting) {
        host.notice("Wait for compaction to finish before reloading.", "warning");
        return;
    }
    try {
        await host.reloadSession();
        host.notice("Reloaded keybindings, extensions, skills, prompts, themes, and context files.");
    }
    catch (error) {
        host.notice(`Reload failed: ${errorText(error)}`, "error");
    }
}
//# sourceMappingURL=session-commands.js.map