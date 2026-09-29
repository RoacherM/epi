import type { ImageContent } from "@earendil-works/pi-ai";
import { type AgentSessionRuntime, type Theme } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { type ProjectIdentity } from "./project-guard.js";
export interface TuiAppOptions {
    runtime: AgentSessionRuntime;
    theme: Theme;
    cwd: string;
    /** MMP's Pi state directory (~/.mmp/pi): keybindings.json is read from here. */
    agentDir: string;
    logDirectory: string;
    /** The project this process assembled its manifest from; used to refuse a cross-project switch. */
    projectIdentity: ProjectIdentity;
    /** Pi CLI positional messages (docs/tui-design.md §15): sent as prompts, in order, once the app
     * is up. Mirrors Pi's own interactive mode sequencing them after startup diagnostics. */
    initialMessages?: string[];
    /** Paired with `initialMessages[0]` only (file-arguments.ts's TuiInitialMessages). */
    initialImages?: ImageContent[];
    /** `--resume`: open the same session selector `/resume` uses, once, right after startup and
     * before any initial message, mirroring Pi's own `--resume` (start.ts's `startupOptionsFromPiArgs`). */
    resumeOnStart?: boolean;
    terminal?: Terminal;
}
export declare function runTuiApp(options: TuiAppOptions): Promise<number>;
//# sourceMappingURL=app.d.ts.map