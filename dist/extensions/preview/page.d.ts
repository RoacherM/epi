import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ChangeLedger } from "./ledger.js";
import { type PreviewResult } from "./view.js";
export type PageStart = {
    side: "changes";
} | {
    side: "files";
    dir: string;
    file?: string;
};
export declare class PreviewPage {
    private readonly tui;
    private readonly theme;
    private readonly ledger;
    private readonly cwd;
    private readonly done;
    focused: boolean;
    private side;
    /** The changes side: the list, then whatever was opened from it. */
    private readonly stack;
    private files;
    private readonly stills;
    private readonly unsubscribe;
    constructor(tui: TUI, theme: Theme, ledger: ChangeLedger, cwd: string, done: (result: PreviewResult) => void, start: PageStart);
    /** The browser closes the whole page (Esc at its root, or i). */
    private newBrowser;
    dispose(): void;
    private finish;
    private top;
    handleInput(data: string): void;
    private apply;
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    /** The last line: whether the agent is working, and how many files it changed. */
    private agentLine;
    render(width: number): string[];
    private renderChanges;
    invalidate(): void;
}
//# sourceMappingURL=page.d.ts.map