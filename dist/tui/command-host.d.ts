import type { AgentSession, AgentSessionRuntime, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
export type NoticeTone = "info" | "warning" | "error";
export interface CommandHost {
    readonly tui: TUI;
    readonly theme: Theme;
    readonly cwd: string;
    readonly runtime: AgentSessionRuntime;
    /** The current session; it changes after /new, /resume, /reload and forks. */
    session(): AgentSession;
    /** Show a component where the editor is; the returned function puts the editor back. */
    takeEditorSlot(component: Component): () => void;
    notice(text: string, tone?: NoticeTone): void;
    /** Append a block to the transcript (command output, info panels). */
    addBlock(component: Component): void;
    getEditorText(): string;
    setEditorText(text: string): void;
    /** Editor text with large-paste markers (`[paste #1 +N lines]`) expanded to their full content;
     * use this, not `getEditorText`, for anything actually sent (submit, steer, external editor). */
    getExpandedEditorText(): string;
    /** Insert text at the editor's cursor, e.g. a pasted clipboard image's file path. */
    insertEditorText(text: string): void;
    /** Record text in the editor's up-arrow history without submitting it. */
    addToHistory(text: string): void;
    /** Run the submit pipeline (built-ins, `!`, `session.prompt`) as if Enter were pressed. */
    submit(text: string): Promise<void>;
    /** True while an agent turn is running. */
    isWorking(): boolean;
    toggleToolsExpanded(): void;
    exit(code?: number): Promise<void>;
    /** `session.reload()` rebuilds resources and the extension runtime in place; it does not go
     * through AgentSessionRuntime, so it skips setBeforeSessionInvalidate/setRebindSession. This
     * redoes the host-owned parts of docs/tui-design.md 6.3 (widgets, autocomplete, keybindings). */
    reloadSession(): Promise<void>;
}
//# sourceMappingURL=command-host.d.ts.map