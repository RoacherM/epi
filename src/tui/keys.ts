// App-level key actions of MMP TUI v2 (docs/tui-design.md 4.7). Keys are Pi's keybinding ids, so
// Pi's defaults and the user's ~/.mmp/pi/keybindings.json both apply. The first matching action
// whose `when` holds consumes the key; otherwise it goes to the focused component (editor, dialog).
import type { CommandHost } from "./command-host.js";

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
      id: "app.interrupt",
      when: (host) => host.session().isStreaming,
      run: (host) => host.session().abort(),
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
  ];
}
