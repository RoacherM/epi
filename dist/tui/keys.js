import { runModel } from "./commands.js";
import { openExternalEditor, pasteClipboard, suspendToShell } from "./key-handlers.js";
import { runCopy } from "./session-commands.js";
import { runFork, runTree } from "./session-tree-commands.js";
const DOUBLE_PRESS_MS = 1000;
/** Pi's double-escape window (interactive-mode.js setupKeyHandlers, `now - this.lastEscapeTime < 500`). */
const DOUBLE_ESCAPE_MS = 500;
/** Pi's interactive-mode.js cycleModel (~L3608): session.cycleModel steps through the scoped models
 * (or every available one without a scope). Pi's showStatus lines are a flash here, like Ctrl+T's;
 * a thrown error reaches the transcript through the key listener in app.ts. */
async function cycleModel(host, direction) {
    const session = host.session();
    const result = await session.cycleModel(direction);
    if (result === undefined) {
        host.flash(session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available");
        return;
    }
    const thinking = result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
    host.flash(`Switched to ${result.model.name || result.model.id}${thinking}`);
}
export function createKeyActions() {
    let lastCtrlC = 0;
    let lastEscape = 0;
    return [
        {
            // Pi's order (interactive-mode.js onEscape, plus its compaction_start/auto_retry_start
            // onEscape overrides): a running turn takes priority, then compaction, then bash. abort()
            // already cancels retry/branch-summary internally, so isStreaming covers those too.
            id: "app.interrupt",
            // host.isWorking(): a turn status still showing with nothing running under it (dogfood D15)
            // must not make Esc a silent no-op.
            when: (host) => !host.session().isIdle || host.session().isBashRunning || host.isWorking(),
            run: (host) => {
                const session = host.session();
                if (session.isStreaming) {
                    host.restoreQueuedMessagesToEditor();
                    host.markRunStopped();
                    void session.abort();
                }
                else if (session.isCompacting) {
                    // Pi's isCompacting also covers /tree branch summaries, which have their own controller.
                    session.abortCompaction();
                    session.abortBranchSummary();
                }
                else if (session.isBashRunning) {
                    session.abortBash();
                }
                else if (host.isWorking()) {
                    host.clearTurnStatus();
                    host.notice("Nothing was running; cleared a stale turn status.", "warning");
                }
            },
        },
        {
            // Pi's onEscape with nothing running and an empty editor (setupKeyHandlers, dogfood D30): a
            // second Esc within 500ms opens /tree or /fork per double-escape-action (default "tree").
            // After the action above, so a running turn always takes Esc first. With "none", or while the
            // autocomplete list is open (Pi's editor closes it before calling onEscape), Esc stays the
            // editor's.
            id: "app.interrupt",
            when: (host) => host.getEditorText().trim() === "" && !host.isShowingAutocomplete() &&
                host.session().settingsManager.getDoubleEscapeAction() !== "none",
            run: async (host) => {
                const now = Date.now();
                if (now - lastEscape >= DOUBLE_ESCAPE_MS) {
                    lastEscape = now;
                    return;
                }
                lastEscape = 0;
                if (host.session().settingsManager.getDoubleEscapeAction() === "tree")
                    await runTree(host);
                else
                    await runFork(host);
            },
        },
        {
            // Pi: clear the editor. MMP also aborts a running turn and quits on a second press (4.7).
            id: "app.clear",
            run: (host) => {
                if (host.getEditorText() !== "") {
                    host.setEditorText("");
                }
                else if (host.session().isStreaming) {
                    host.restoreQueuedMessagesToEditor();
                    host.markRunStopped();
                    void host.session().abort();
                }
                else if (Date.now() - lastCtrlC < DOUBLE_PRESS_MS) {
                    void host.exit(0);
                }
                else {
                    lastCtrlC = Date.now();
                    host.notice("Press Ctrl+C again to quit.");
                }
            },
        },
        {
            id: "app.exit",
            when: (host) => host.getEditorText() === "",
            run: (host) => host.exit(0),
        },
        {
            id: "app.thinking.cycle",
            when: (host) => !host.isWorking(),
            run: (host) => void host.session().cycleThinkingLevel(),
        },
        {
            id: "app.tools.expand",
            run: (host) => host.toggleToolsExpanded(),
        },
        {
            id: "app.thinking.toggle",
            run: (host) => host.toggleThinkingExpanded(),
        },
        {
            id: "app.model.select",
            run: (host) => runModel(host, ""),
        },
        {
            // Unbound by default in MMP (keybindings.ts MMP_DEFAULT_KEYS, decision K1).
            id: "app.model.cycleForward",
            run: (host) => cycleModel(host, "forward"),
        },
        {
            id: "app.model.cycleBackward",
            run: (host) => cycleModel(host, "backward"),
        },
        {
            // K1: MMP swaps Pi's Enter/Alt+Enter semantics while a turn runs. Enter already queues a
            // follow-up (submit() in app.ts); Alt+Enter steers it into the current turn instead.
            id: "app.message.followUp",
            when: (host) => host.session().isStreaming,
            run: async (host) => {
                const text = host.getExpandedEditorText();
                const images = host.getEditorImages();
                if (text.trim() === "" && images.length === 0)
                    return;
                host.addToHistory(text);
                await host.steer(text, images);
            },
        },
        {
            // Idle: Alt+Enter submits like plain Enter (Pi's handleFollowUp does the same).
            id: "app.message.followUp",
            when: (host) => !host.session().isStreaming,
            run: (host) => host.submit(host.getExpandedEditorText(), host.getEditorImages()),
        },
        {
            id: "app.message.dequeue",
            run: (host) => {
                const count = host.restoreQueuedMessagesToEditor();
                if (count === 0)
                    host.notice("No queued messages to restore.");
                else
                    host.notice(`Restored ${count} queued message${count > 1 ? "s" : ""} to editor.`);
            },
        },
        {
            id: "app.editor.external",
            run: (host) => openExternalEditor(host),
        },
        {
            id: "app.clipboard.pasteImage",
            run: (host) => pasteClipboard(host),
        },
        {
            id: "app.suspend",
            run: (host) => suspendToShell(host),
        },
        {
            id: "app.message.copy",
            run: (host) => runCopy(host, { fromKey: true }),
        },
    ];
}
//# sourceMappingURL=keys.js.map