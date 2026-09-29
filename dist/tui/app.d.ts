import { type AgentSessionRuntime, type Theme } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
export interface TuiAppOptions {
    runtime: AgentSessionRuntime;
    theme: Theme;
    cwd: string;
    /** MMP's Pi state directory (~/.mmp/pi): keybindings.json is read from here. */
    agentDir: string;
    logDirectory: string;
    terminal?: Terminal;
}
export declare function runTuiApp(options: TuiAppOptions): Promise<number>;
//# sourceMappingURL=app.d.ts.map