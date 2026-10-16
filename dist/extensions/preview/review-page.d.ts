import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ReviewNote, ReviewNoteStore } from "./notes.js";
import type { ReviewFile, ReviewSourceKind } from "./source.js";
export interface ReviewResult {
    draft: string;
}
export interface ReviewPageOptions {
    tui: TUI;
    theme: Theme;
    cwd: string;
    source: ReviewSourceKind;
    /** Read the comparison. Called on open, on `s`, and on `R`. */
    load: (source: ReviewSourceKind) => ReviewFile[];
    notes: ReviewNoteStore;
    sessionId: string;
    /** The branch/anchor the notes are written against. */
    branchAnchor: string;
    /** Persist one note (custom session entry). */
    persist: (note: ReviewNote) => void;
    done: (result: ReviewResult | undefined) => void;
}
export declare class ReviewPage {
    private readonly options;
    focused: boolean;
    private source;
    private files;
    private cursor;
    private scroll;
    private collapsed;
    private expanded;
    private readFiles;
    private readonly diffs;
    private readonly finder;
    private prompt;
    private pending;
    private message;
    private height;
    private bodyTop;
    /** Files whose diff has been computed this session, in order; grows as the cursor moves. */
    private loadedThrough;
    constructor(options: ReviewPageOptions);
    /** A failed git read is shown as a message, never as "no changes". */
    private loadFiles;
    dispose(): void;
    private key;
    private mark;
    private diffFor;
    private notesByLine;
    /** The flat display rows. A file not loaded yet shows only its header, which is what keeps a large
     * comparison from reading every blob on open. */
    private rows;
    private pushAnnotations;
    private ensureLoaded;
    private cursorFileIndex;
    handleInput(data: string): void;
    private page;
    private move;
    private clamp;
    private activate;
    private jumpFile;
    private jumpChange;
    private annotate;
    private pendingNoteTarget;
    private submit;
    private toggleRead;
    private cycleSource;
    private refresh;
    private bringToDraft;
    private findNext;
    private close;
    private rowTexts;
    private plainRow;
    private numberWidth;
    private fileStats;
    private headerRow;
    private diffRow;
    private gapRow;
    private noteRow;
    private annotationRow;
    render(width: number): string[];
    private statusLine;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    invalidate(): void;
}
//# sourceMappingURL=review-page.d.ts.map