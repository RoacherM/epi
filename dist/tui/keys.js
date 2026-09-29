import { errorText } from "./errors.js";
import { runModel } from "./commands.js";
import { openExternalEditor, pasteClipboard, suspendToShell } from "./key-handlers.js";
import { runCopy } from "./session-commands.js";
const DOUBLE_PRESS_MS = 1000;
export function createKeyActions() {
    let lastCtrlC = 0;
    return [
        {
            // Pi's order (interactive-mode.js onEscape, plus its compaction_start/auto_retry_start
            // onEscape overrides): a running turn takes priority, then compaction, then bash. abort()
            // already cancels retry/branch-summary internally, so isStreaming covers those too.
            id: "app.interrupt",
            when: (host) => !host.session().isIdle || host.session().isBashRunning,
            run: (host) => {
                const session = host.session();
                if (session.isStreaming) {
                    host.restoreQueuedMessagesToEditor();
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
            id: "app.model.select",
            run: (host) => runModel(host, ""),
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
                host.setEditorText("");
                try {
                    await host.session().prompt(text, { images, streamingBehavior: "steer" });
                }
                catch (error) {
                    host.notice(errorText(error), "error");
                    if (host.getEditorText() === "")
                        host.setEditorText(text);
                }
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
            run: (host) => runCopy(host),
        },
    ];
}
//# sourceMappingURL=keys.js.map