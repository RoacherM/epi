import type { Theme, ToolExecutionOptions } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "./types.js";
import { type FlashState } from "./flash.js";
export type GroupKind = "read" | "grep" | "find" | "ls";
/** Only a built-in read/grep/find/ls tool groups; an extension overriding one of these names (or any
 * other extension tool) never does (docs/tui-design.md 4.2: "Only built-in read-only tools group"). */
export declare function asGroupKind(toolName: string, isBuiltIn: boolean): GroupKind | undefined;
type Status = "running" | "done" | "error";
/**
 * A tool call in a run. `Transcript.tool()` is the only place these get built, alongside the
 * `groupKind`/`status`/`expandedFlag` bookkeeping the render wrapper below reads back out --
 * `ToolExecutionComponent`'s own fields are private, so overriding its mutators is how a subclass
 * observes its own state. `flash` is public: `GroupedMessages` reads each member's own flash state
 * directly to decide whether (and in what color) the group's merged line should flash -- there is no
 * separate group-level flash timer (see `GroupedMessages.renderSummaryLine`).
 */
export declare class ToolEntry extends ToolExecutionComponent {
    private readonly hostUi;
    private readonly theme;
    readonly groupKind: GroupKind | undefined;
    status: Status;
    expandedFlag: boolean;
    readonly flash: FlashState;
    private started;
    constructor(toolName: string, toolCallId: string, args: unknown, renderers: ToolRenderers | undefined, hostUi: TUI, cwd: string, theme: Theme, groupKind: GroupKind | undefined, options?: ToolExecutionOptions);
    markExecutionStarted(): void;
    updateResult(result: {
        content: Array<{
            type: string;
            text?: string;
            data?: string;
            mimeType?: string;
        }>;
        details?: unknown;
        isError: boolean;
    }, isPartial?: boolean): void;
    setExpanded(expanded: boolean): void;
    render(width: number): string[];
    /** Cleared on `Transcript.reset()` so a stale flash timer never fires after this entry is gone. */
    dispose(): void;
}
interface MemberLike {
    groupKind: GroupKind | undefined;
    status: Status;
}
/** Pure text+layout for the collapsed group line, split out from `GroupedMessages` so widths
 * 40/80/120 can be checked without a real `Transcript`/`ToolEntry`. */
export declare function verbGroupLine(members: MemberLike[], theme: Theme, width: number): string;
/**
 * Wraps `Transcript`'s `messages` container: folds consecutive collapsed built-in read-only tool
 * blocks into one line at render time. Swapped in for `this.messages` as `root`'s child; `add()`
 * keeps mutating the real container exactly as before. This class reads `messages.children`
 * directly and never calls `messages.render()`/`messages.handleMouse()` -- so `messages`'s own
 * (inherited) `mouseLayout` cache is never populated and must never be relied on by anything else.
 *
 * "Unfolded" (this class's own per-run state, below) is a different axis from "expanded" (each
 * `ToolEntry`'s own `expandedFlag`, i.e. Pi's normal show-full-output toggle): clicking a folded
 * group line only unfolds it into its individual (still content-collapsed) blocks, it never expands
 * any member's output -- clicking `◈ Read 10 files` must show ten one-line blocks, not print all ten
 * files' contents. `Ctrl+O` (`setToolsExpanded`) is authoritative over folding: it always clears
 * `unfolded`/`revealed`, so the very next render folds every settled run again regardless of any
 * member's `expandedFlag` or any run's prior unfold/reveal state.
 */
export declare class GroupedMessages implements Component {
    private readonly messages;
    private readonly tui;
    private readonly theme;
    private mouseLayout;
    private toolsExpanded;
    private readonly unfolded;
    private readonly revealed;
    constructor(messages: Container, tui: TUI, theme: Theme);
    invalidate(): void;
    /** `Ctrl+O`: always wins over any per-group unfold/reveal state left over from clicks. */
    setToolsExpanded(expanded: boolean): void;
    /** Cleared on `Transcript.reset()`: old runs' first members no longer resolve to anything on screen. */
    dispose(): void;
    render(width: number): string[];
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    /**
     * Individual blocks again. Under `Ctrl+O` every member shows, uncapped (the user asked to see
     * everything). Unfolded by a click instead, only the most recent `MAX_UNFOLDED_MEMBERS` show by
     * default -- the newest, most likely still-running calls, not the oldest -- behind a clickable
     * "N more" that reveals the rest; a "fold" line folds this one run back (Ctrl+O stays the only way
     * to fold *and* unfold everything at once).
     */
    private renderUnfolded;
    /**
     * The merged line has no group-level flash timer of its own: once every member has settled, it
     * paints its rail in whichever tone a still-flashing member is showing (error wins over success),
     * which is exactly the 400ms window each member already tracks on its own `ToolEntry.flash`. This
     * needs no "did a render happen between running and settled" observation -- pi-tui's own render
     * throttle can (and in the real app, does) coalesce a fast run's frames so no such render ever
     * happens, which a wall-clock read of `isFlashing()` doesn't care about.
     */
    private renderSummaryLine;
}
export {};
//# sourceMappingURL=group.d.ts.map