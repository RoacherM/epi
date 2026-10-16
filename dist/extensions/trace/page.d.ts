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
    private chromeRows;
    private detailWidth;
    /** The bar column width for a content width; the left part holds the step text. */
    private barWidth;
    /** Keep the cursor's row on screen and the list scroll in range, before anything is drawn. */
    private syncList;
    private visibleSteps;
    /** The time window of the steps currently on screen: the waterfall never compresses the whole
     * session, only what is visible right now. */
    private visibleWindow;
    /** The cells of one row's waterfall bar: a bar for a span, a diamond for a lone instant, else
     * blank. The caller colours them. */
    private barCells;
    private stepTone;
    /** The axis above the list: only the visible window's start and total, aligned to the bar column. */
    private axisLine;
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