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
    /** `waterfall`: bar positioned on the visible time axis; `duration`: bar length by duration. */
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
    private chromeRows;
    private detailWidth;
    /** Pixel geometry: 2-wide cells with a 1-column gap. */
    private gridGeometry;
    /** Keep the cursor's row on screen and the list scroll in range, before anything is drawn. */
    private syncList;
    private visibleSteps;
    private durationOf;
    /** The time window of the steps currently on screen: the grid never compresses the whole
     * session, only what is visible right now. */
    private visibleWindow;
    /** One flag set per pixel column: which lane was active, and whether it errored or is running.
     * Both lanes share one row, so an overlap draws as a two-tone cell. */
    private gridCells;
    /** The single dot-matrix row: only lit cells are drawn, the rest is blank. A cell where both
     * lanes were active is a two-tone half block. */
    private gridMatrix;
    /** The axis under the matrix: just the window's start and total. */
    private gridAxis;
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