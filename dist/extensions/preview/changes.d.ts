import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Change, ChangeLedger, Scope } from "./ledger.js";
import { type ViewFrame } from "./view.js";
/** What a view asks the page to do after a key. */
export type ViewAction = {
    kind: "back";
} | {
    kind: "insert";
    paths: string[];
} | {
    kind: "open";
    view: PageView;
} | {
    kind: "file";
    path: string;
} | undefined;
export interface PageView {
    render(width: number, height: number): ViewFrame;
    handleInput(data: string): ViewAction;
    /** Typing into a prompt: Tab and Esc belong to the view, not the page. */
    readonly busy?: boolean;
    dispose?(): void;
}
/** The files that differ from before in the scope. A failed edit, or a write of the same text, is
 * recorded before the tool runs but changed nothing: it is not listed. */
export declare function changedFiles(ledger: ChangeLedger, scope: Scope): Change[];
export declare class ChangesList implements PageView {
    private readonly ledger;
    private readonly theme;
    private readonly cwd;
    private scope;
    private cursor;
    private scroll;
    constructor(ledger: ChangeLedger, theme: Theme, cwd: string);
    private selected;
    handleInput(data: string): ViewAction;
    render(width: number, height: number): ViewFrame;
}
export declare class DiffView implements PageView {
    private readonly ledger;
    private readonly theme;
    readonly path: string;
    private readonly scope;
    private readonly cwd;
    private scroll;
    private wrap;
    private readonly finder;
    private prompt;
    /** "]" or "[" typed, waiting for the "c" of ]c / [c. */
    private pending;
    private message;
    private cache;
    private height;
    constructor(ledger: ChangeLedger, theme: Theme, path: string, scope: Scope, cwd: string);
    get busy(): boolean;
    dispose(): void;
    /** What the file was before, in this view's scope; the session's when the turn no longer has it. */
    private before;
    handleInput(data: string): ViewAction;
    private submit;
    private findNext;
    private jumpToChange;
    private styleRow;
    private layout;
    render(width: number, height: number): ViewFrame;
    private statusLine;
}
//# sourceMappingURL=changes.d.ts.map