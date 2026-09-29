import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Editor } from "@earendil-works/pi-tui";
/** grok: `~` for home, middle components shortened to their first letter, last two kept full. */
export declare function shortenPath(path: string, home?: string): string;
export declare function formatTokens(count: number): string;
export interface HeaderState {
    branch: string | undefined;
    cwd: string;
    contextTokens: number | undefined;
    contextWindow: number | undefined;
}
export declare function headerBar(theme: Theme, state: () => HeaderState): Component;
/** Full-width `userMessageBg` block with one row of padding, `❯ text` and the time on the right. */
export declare class UserMessageBlock implements Component {
    private readonly theme;
    private readonly text;
    private readonly time;
    constructor(theme: Theme, text: string, time: Date);
    render(width: number): string[];
    invalidate(): void;
}
export interface TurnState {
    startedAt: number;
    phaseStartedAt: number;
    activity: string;
    outputTokens: number;
    estimated: boolean;
}
/** `⠧ Waiting for response… 2.4s ····· 2.4s ⇣2.3k [stop]`; zero rows when idle. */
export declare class TurnStatus implements Component {
    private readonly theme;
    private readonly state;
    private readonly requestRender;
    private timer;
    constructor(theme: Theme, state: () => TurnState | undefined, requestRender: () => void);
    render(width: number): string[];
    stop(): void;
    invalidate(): void;
}
/**
 * Wraps pi-tui's Editor in a rounded frame with `model (level)` on the bottom border. The editor
 * draws its own top and bottom rules (possibly with a `↑ N more` label); those rows are replaced,
 * content rows get side rails, and anything below the bottom rule (autocomplete) stays outside.
 */
export declare class PromptFrame implements Component {
    private readonly theme;
    readonly editor: Editor;
    private readonly label;
    private readonly borderColor;
    constructor(theme: Theme, editor: Editor, label: () => string, borderColor: () => (text: string) => string);
    get focused(): boolean;
    set focused(value: boolean);
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
}
export interface Shortcut {
    key: string;
    label: string;
}
/** `Key:label  │  Key:label` on the left; extension statuses and notices on the right. */
export declare function shortcutsBar(theme: Theme, state: () => {
    shortcuts: Shortcut[];
    right: string;
}): Component;
//# sourceMappingURL=chrome.d.ts.map