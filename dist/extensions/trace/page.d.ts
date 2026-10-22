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
    private readonly listMotions;
    private readonly detailMotions;
    private message;
    private cache;
    private readonly unsubscribe;
    /** Turns a running step's icon while one is in view; stops when none is. */
    private spinner;
    /** Body geometry from the last render, for the mouse. */
    private geometry;
    constructor(options: TracePageOptions);
    dispose(): void;
    private spin;
    /** Recompute the projection only when the branch actually changed. */
    private summary;
    private currentStep;
    handleInput(data: string): void;
    private close;
    private moveCursor;
    /** The shared motion keys on the step list: `gg` stops following, `G` follows the latest. */
    private moveList;
    private listKeys;
    private openDetail;
    private detailKeys;
    /** The shared motion keys on the detail pane: they scroll it. */
    private moveDetail;
    private submit;
    private findNext;
    private bodyHeight;
    /** A fixed slice of the list shown as the dot matrix above it, never growing with the session. */
    private topRows;
    private detailWidth;
    /** Pixel geometry: two glyphs per cell with a 1-column gap, matching the agreed mockup. */
    private gridGeometry;
    /** Keep the cursor's row on screen and the list scroll in range, before anything is drawn. */
    private syncList;
    private durationOf;
    /** The time window of the steps currently on screen: the grid never compresses the whole
     * session, only what is visible right now. */
    private visibleWindow;
    /** The visible model/tool activity as time intervals, for the folding map. */
    private timelineMap;
    /** One step's dot-matrix row: its span as blocks, an instant as one cell, empty when untimed.
     * User and event steps show a single marker so every step on screen has its own row. */
    private stepBar;
    /** The axis above the step rows: the window's start and total, with a dot pair where a long idle
     * gap was folded. */
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