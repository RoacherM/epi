import { runCopy } from "./session-commands.js";
const DOUBLE_PRESS_MS = 1000;
export function createKeyActions() {
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
                }
                else if (host.session().isStreaming) {
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
            id: "app.message.copy",
            run: (host) => runCopy(host),
        },
    ];
}
//# sourceMappingURL=keys.js.map