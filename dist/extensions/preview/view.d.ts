import { type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { type Entry } from "./files.js";
import { StillCache } from "./media.js";
export type PreviewResult = {
    paths: string[];
} | undefined;
/** Rows the page itself takes around a view's body: the top border, the title row, the key row,
 * the bottom border, and the agent status line under it (page.ts). */
export declare const PAGE_CHROME_ROWS = 5;
export interface ViewFrame {
    title: string;
    body: string[];
    status: string;
}
/** Where each file's view was scrolled to, kept for this MMP process (docs/preview-design.md §3.3). */
export declare const lastScroll: Map<string, number>;
export declare class Viewer {
    private readonly tui;
    private readonly theme;
    readonly entry: Entry;
    private readonly stills;
    readonly mode: "text" | "image" | "video";
    private scroll;
    private wrap;
    private markdown;
    /** `gutters` (line numbers) and `contents` make up `rows`; search looks at the contents only. */
    private rowsCache;
    private readonly finder;
    private prompt;
    private message;
    private info;
    /** The probe has answered (or failed): a video waits for it, to play at the source's frame rate. */
    private probed;
    private pane;
    /** Size of the last rendered body, for the mouse. */
    private width;
    private height;
    constructor(tui: TUI, theme: Theme, entry: Entry, stills: StillCache);
    dispose(): void;
    /** Typing a search or a line number: every key goes to the prompt, not to the view. */
    get busy(): boolean;
    /** `/` and `:` in the text view (docs/preview-design.md §3.3). True when the key was taken. */
    private handleSearchKeys;
    private submitPrompt;
    private findNext;
    /** Returns "back" or "insert" when the browser should act. */
    handleInput(data: string): "back" | "insert" | undefined;
    /** `x`/`y` are relative to the body; `y === height` is the status row. */
    handleMouse(event: TuiMouseEvent, x: number, y: number): void;
    private textRows;
    /** The key row: the prompt while typing, else a message or the key hints, and the position. */
    private statusLine;
    render(width: number, height: number): ViewFrame;
}
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
    private readonly listings;
    private currentListing;
    private readonly stills;
    constructor(tui: TUI, theme: Theme, start: string, done: (result: PreviewResult) => void, 
    /** A file in `start` to show at once; closing its viewer leaves the browser on it. */
    file?: string);
    /** Stops whatever is playing. Called when the overlay closes and when the session shuts down. */
    dispose(): void;
    private finish;
    /** A directory's entries, read again only when the directory changed: render asks for the
     * parent's and the previewed folder's on every frame, which was slow next to large directories. */
    private listing;
    /** Follows the current directory when files appear or go away while the overlay is open. */
    private refresh;
    private load;
    private visible;
    private current;
    private bodyHeight;
    /** No viewer, filter or search is open: Tab may switch the page to the changes. */
    get atRoot(): boolean;
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