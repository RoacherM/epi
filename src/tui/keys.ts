// App-level key actions of MMP TUI v2 (docs/tui-design.md 4.7). Keys are Pi's keybinding ids, so
// Pi's defaults and the user's ~/.mmp/pi/keybindings.json both apply. The first matching action
// whose `when` holds consumes the key; otherwise it goes to the focused component (editor, dialog).
import type { CommandHost } from "./command-host.js";
import { runModel } from "./commands.js";
import { openExternalEditor, pasteClipboard, suspendToShell } from "./key-handlers.js";

export interface KeyAction {
  /** Pi keybinding id, e.g. "app.model.select". */
  id: string;
  when?: (host: CommandHost) => boolean;
  run: (host: CommandHost) => void | Promise<void>;
}

const DOUBLE_PRESS_MS = 1000;

export function createKeyActions(): KeyAction[] {
  let lastCtrlC = 0;
  return [
    {
      // Pi's order (interactive-mode.js onEscape): a running turn takes priority over a running
      // user bash command.
      id: "app.interrupt",
      when: (host) => host.session().isStreaming || host.session().isBashRunning,
      run: (host) => (host.session().isStreaming ? host.session().abort() : host.session().abortBash()),
    },
    {
      // Pi: clear the editor. MMP also aborts a running turn and quits on a second press (4.7).
      id: "app.clear",
      run: (host) => {
        if (host.getEditorText() !== "") {
          host.setEditorText("");
        } else if (host.session().isStreaming) {
          void host.session().abort();
        } else if (Date.now() - lastCtrlC < DOUBLE_PRESS_MS) {
          void host.exit(0);
        } else {
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
        if (text.trim() === "") return;
        host.addToHistory(text);
        host.setEditorText("");
        try {
          await host.session().prompt(text, { streamingBehavior: "steer" });
        } catch (error) {
          host.notice(error instanceof Error ? error.message : String(error), "error");
          if (host.getEditorText() === "") host.setEditorText(text);
        }
      },
    },
    {
      // Idle: Alt+Enter submits like plain Enter (Pi's handleFollowUp does the same).
      id: "app.message.followUp",
      when: (host) => !host.session().isStreaming,
      run: (host) => host.submit(host.getExpandedEditorText()),
    },
    {
      id: "app.message.dequeue",
      run: (host) => {
        const { steering, followUp } = host.session().clearQueue();
        const queued = [...steering, ...followUp];
        if (queued.length === 0) {
          host.notice("No queued messages to restore.");
          return;
        }
        const queuedText = queued.join("\n\n");
        const current = host.getEditorText();
        host.setEditorText([queuedText, current].filter((text) => text.trim() !== "").join("\n\n"));
        host.notice(`Restored ${queued.length} queued message${queued.length > 1 ? "s" : ""} to editor.`);
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
  ];
}
