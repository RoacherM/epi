import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorComponent, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
/** Shared with assistant-block.ts (the assistant-message timestamp reuses this row layout). */
export declare function fit(text: string, width: number): string;
/** Left and right segments on one row; the left side is truncated first. */
/** Columns kept free for a message's time on every row ("12:00 PM"), so text wraps at the same place
 * whatever the time reads; a longer locale string widens it. */
export declare function clockColumns(clock: string): number;
export declare function spread(left: string, right: string, width: number): string;
/** grok: `~` for home, middle components shortened to their first letter, last two kept full. */
export declare function shortenPath(path: string, home?: string): string;
export declare function formatTokens(count: number): string;
/** Shared with transcript.ts (turn footer) and assistant-block.ts (thinking duration). */
export declare function formatDuration(ms: number): string;
export interface HeaderState {
    branch: string | undefined;
    cwd: string;
    contextTokens: number | undefined;
    contextWindow: number | undefined;
}
export declare function headerBar(theme: Theme, state: () => HeaderState): Component;
/** Full-width `userMessageBg` block with one row of padding, `❯ text` and the time on the right.
 * Collapses past `COLLAPSED_LINES` *logical* lines (not wrapped rows) to `…` -- observed in grok
 * 1.0.44 (docs/tui-design.md 4.2/4.3): a sent 12-line paste renders as its first 3 lines then `…`.
 * Counting logical lines, not wrapped rows, means a single long line never collapses just because a
 * narrow terminal wraps it into more than 3 screen rows. Expanded back with Ctrl+O -- the same
 * toggle that expands tool output (item 5). */
export declare class UserMessageBlock implements Component {
    private readonly theme;
    private readonly time;
    private readonly text;
    private expanded;
    constructor(theme: Theme, content: unknown, time: Date);
    setExpanded(expanded: boolean): void;
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
/** Columns before the editor's own content starts inside the frame: `│` + space + the 2-column
 * `❯ `/`  ` prompt. Shared by render() and handleMouse() so a click lands on the same character
 * it's drawn on; exported so tests can compute click coordinates without duplicating it. */
export declare const PROMPT_COLUMNS = 4;
export declare class PromptFrame implements Component {
    private readonly theme;
    readonly editor: EditorComponent;
    private readonly label;
    private readonly borderColor;
    private readonly maxContentRows;
    constructor(theme: Theme, editor: EditorComponent, label: () => string, borderColor: () => (text: string) => string, maxContentRows?: () => number | undefined);
    get focused(): boolean;
    set focused(value: boolean);
    /** Finds the editor's own top/bottom border rows within its rendered output at `inner` width,
     * so render() and handleMouse() agree on which rows are content. */
    private contentBounds;
    render(width: number): string[];
    handleInput(data: string): void;
    /** Forwards a click/double-click inside the content rows to the editor, translated into its own
     * coordinate space (docs/tui-design.md 4.3: double-click on a chip expands it). Clicks on the
     * border or the autocomplete dropdown below it are left unhandled, matching prior behavior. At the
     * ≤12-row cap (`maxContentRows`), a click's `y` is shifted by the same crop-window offset
     * `render()` used, so a double-click on a chip on a row *within the drawn window* still lands on
     * the right line of the editor's own (uncropped) content -- a click on a screen position outside
     * the drawn window can't occur in practice (nothing else is drawn there) but is also harmless: it
     * maps past the editor's real content and simply falls through unhandled below. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
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
export interface QueuedMessagesState {
    steering: readonly string[];
    followUp: readonly string[];
}
/**
 * Messages queued while a turn runs (4.1 排队区), between the turn status row and the prompt.
 * At most 3 lines: Pi's `Steering:` / `Follow-up:` lines, plus an Alt+Up hint if there is room.
 */
export declare function queuedMessagesBar(theme: Theme, state: () => QueuedMessagesState): Component;
//# sourceMappingURL=chrome.d.ts.map