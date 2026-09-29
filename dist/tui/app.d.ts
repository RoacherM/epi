import { type AgentSessionRuntime, type Theme } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
export interface TuiAppOptions {
    runtime: AgentSessionRuntime;
    theme: Theme;
    cwd: string;
    logDirectory: string;
    terminal?: Terminal;
}
export declare function runTuiApp(options: TuiAppOptions): Promise<number>;
//# sourceMappingURL=app.d.ts.map