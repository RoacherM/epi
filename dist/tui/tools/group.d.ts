import type { Theme, ToolExecutionOptions } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "./types.js";
export type GroupKind = "read" | "grep" | "find" | "ls";
/** Only a built-in read/grep/find/ls tool groups; an extension overriding one of these names (or any
 * other extension tool) never does (docs/tui-design.md 4.2: "Only built-in read-only tools group"). */
export declare function asGroupKind(toolName: string, isBuiltIn: boolean): GroupKind | undefined;
type Status = "running" | "done" | "error";
/**
 * A tool call in a run. `Transcript.tool()` is the only place these get built, alongside the
 * `groupKind`/`status`/`expandedFlag` bookkeeping the render wrapper below reads back out --
 * `ToolExecutionComponent`'s own fields are private, so overriding its mutators is how a subclass
 * observes its own state.
 */
export declare class ToolEntry extends ToolExecutionComponent {
    private readonly hostUi;
    private readonly theme;
    readonly groupKind: GroupKind | undefined;
    readonly id: string;
    status: Status;
    expandedFlag: boolean;
    private started;
    private readonly flash;
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
 */
export declare class GroupedMessages implements Component {
    private readonly messages;
    private readonly tui;
    private readonly theme;
    private mouseLayout;
    private readonly runFlashes;
    constructor(messages: Container, tui: TUI, theme: Theme);
    invalidate(): void;
    /** Cleared on `Transcript.reset()`: old runs' keys no longer resolve to anything on screen. */
    dispose(): void;
    render(width: number): string[];
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    /** Clicking the merged line expands every member, same as Ctrl+O would for just this run. */
    private runClickTarget;
    private renderSummaryLine;
}
export {};
//# sourceMappingURL=group.d.ts.map