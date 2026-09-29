import { type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
export interface CommandHost {
    readonly tui: TUI;
    session(): AgentSession;
    /** Show a component where the editor is; the returned function puts the editor back. */
    takeEditorSlot(component: Component): () => void;
    notice(text: string, tone?: "info" | "warning" | "error"): void;
}
/** Like Pi: first the method (account or API key), then the providers offering it. */
export declare function runLogin(host: CommandHost, providerRef: string): Promise<void>;
export declare function runLogout(host: CommandHost): Promise<void>;
/** `/model [query]`: switch directly on an exact match, otherwise open the selector. */
export declare function runModel(host: CommandHost, query: string, options?: {
    persist?: boolean;
    title?: string;
}): Promise<void>;
//# sourceMappingURL=commands.d.ts.map