import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { TraceRecorder } from "./record.js";
export interface TracePageOptions {
    tui: TUI;
    theme: Theme;
    /** The read-only slice of SessionManager the page needs. Structural, so it does not depend on the
     * (unexported) ReadonlySessionManager type name. */
    session: TraceSession;
    recorder: TraceRecorder;
    cwd: string;
    /** The current git branch, shown in the title (may be undefined). */
    branch: () => string | undefined;
    /** Close the page. */
    done: (result: undefined) => void;
}
/** What the page reads from the session. */
export interface TraceSession {
    getLeafId(): string | null;
    getBranch(fromId?: string): SessionEntry[];
}
/** A frame with the list and, at ≥120 columns, the inspector side by side. */
export declare class TracePage {
    private readonly options;
    focused: boolean;
    private cursor;
    private listScroll;
    private detailOpen;
    private focus;
    private section;
    private detailScroll;
    private follow;
    private readonly finder;
    private prompt;
    private message;
    private cache;
    private readonly unsubscribe;
    /** Body geometry from the last render, for the mouse. */
    private geometry;
    constructor(options: TracePageOptions);
    dispose(): void;
    /** Recompute the projection only when the branch actually changed. */
    private summary;
    private currentStep;
    handleInput(data: string): void;
    private close;
    private moveCursor;
    private listKeys;
    private openDetail;
    private detailKeys;
    private submit;
    private findNext;
    private bodyHeight;
    /** Rows the grid timeline takes above the body: two lanes, each `laneRows` tall, plus the axis. */
    private laneRows;
    private chromeRows;
    private detailWidth;
    /** Cell width, gap and column count for the grid at this terminal width. */
    private gridGeometry;
    private gridTone;
    /** The selected step's column range, so its cells stand out in the grid. */
    private selectedHighlight;
    /** The GitHub-like grid: one block per active time bucket, stacked rows for concurrency. */
    private timelineLines;
    private headerLine;
    private listRow;
    private listLines;
    private field;
    private block;
    private detailLines;
    private summarySection;
    private payloadSection;
    private resultSection;
    private schemaSection;
    private timingSection;
    private detailRows;
    private renderDetailLine;
    render(width: number): string[];
    private hints;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    invalidate(): void;
}
//# sourceMappingURL=page.d.ts.map