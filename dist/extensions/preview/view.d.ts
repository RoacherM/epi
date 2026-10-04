import { type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
export type PreviewResult = {
    paths: string[];
} | undefined;
export declare class FileBrowser {
    private readonly tui;
    private readonly theme;
    private readonly done;
    focused: boolean;
    private cwd;
    private entries;
    private cursor;
    private scroll;
    private previewScroll;
    private previewFor;
    private previewTotal;
    private showHidden;
    private filter;
    private filtering;
    private marked;
    /** Remembers the cursor per directory so going back lands where you were. */
    private lastCursor;
    private message;
    private viewer;
    private layout;
    private parentEntries;
    private readonly stills;
    constructor(tui: TUI, theme: Theme, start: string, done: (result: PreviewResult) => void, 
    /** A file in `start` to show at once; closing its viewer leaves the browser on it. */
    file?: string);
    private finish;
    private load;
    private visible;
    private current;
    private bodyHeight;
    private move;
    private cd;
    private open;
    private leave;
    private insert;
    handleInput(data: string): void;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    private entryLine;
    /** A file list; the active one keeps `this.scroll` in view and gets a scrollbar. Returns the first shown index too. */
    private listColumn;
    private previewColumn;
    render(width: number): string[];
    invalidate(): void;
    /** Paths for the editor: relative to the session root when inside it, absolute otherwise. */
    static display(root: string, path: string): string;
}
//# sourceMappingURL=view.d.ts.map