import type { Component, TUI } from "@earendil-works/pi-tui";
/** The part of HostSurface / CommandHost a dialog needs. */
interface EditorSlotHost {
    readonly tui: TUI;
    /** Shows `component` in the editor slot; the returned function gives the editor back, focus included. */
    takeEditorSlot(component: Component): () => void;
}
export type DialogOptions = {
    signal?: AbortSignal;
    timeout?: number;
} | undefined;
/** Show a dialog in the editor slot; resolves with `fallback` on cancel, abort, or timeout. `done`
 * restores the editor before resolving, so code running after it in a component callback already
 * sees the editor back. */
export declare function dialog<T>(host: EditorSlotHost, build: (done: (value: T) => void) => Component, fallback: T, options?: DialogOptions): Promise<T>;
/** Pick one of `labels`; undefined on cancel. */
export declare function selectInEditorSlot(host: EditorSlotHost, title: string, labels: string[], options?: DialogOptions): Promise<string | undefined>;
/** Yes/No; false on cancel. */
export declare function confirmInEditorSlot(host: EditorSlotHost, title: string, message: string, options?: DialogOptions): Promise<boolean>;
/** Multi-line text; undefined on cancel. */
export declare function editInEditorSlot(host: EditorSlotHost, title: string, prefill: string | undefined): Promise<string | undefined>;
export {};
//# sourceMappingURL=dialogs.d.ts.map