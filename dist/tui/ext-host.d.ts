import { type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, TUI } from "@earendil-works/pi-tui";
import type { StatusLineFormatter } from "./chrome.js";
/** What the extension host may do to the screen; implemented by the app. */
export interface HostSurface {
    readonly tui: TUI;
    readonly theme: Theme;
    /** Put a component where the editor is and focus it (or `focus`, for a component whose own
     * keyboard handling lives on a child); returns a function restoring the editor. */
    takeEditorSlot(component: Component, focus?: Component): () => void;
    setHeader(component: Component | undefined): void;
    setFooter(component: Component | undefined): void;
    setWidget(key: string, component: Component | undefined, placement: "aboveEditor" | "belowEditor"): void;
    setStatus(key: string, text: string | undefined): void;
    /** Replace the prompt frame's bottom-right label formatter; undefined restores the built-in. */
    setStatusLine(formatter: StatusLineFormatter | undefined): void;
    setWorking(options: {
        message?: string | undefined;
        visible?: boolean | undefined;
    }): void;
    setTitle(title: string): void;
    getEditorText(): string;
    setEditorText(text: string): void;
    /** Pi's addAutocompleteProvider: keep the wrapper and re-apply it on every autocomplete rebuild. */
    addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void;
    getToolsExpanded(): boolean;
    setToolsExpanded(expanded: boolean): void;
    notify(message: string, tone: "info" | "warning" | "error"): void;
}
/** Epi's addition on top of Pi's ExtensionUIContext (docs/statusbar-design.md §3): the prompt
 * frame's bottom-right label is a slot any extension can reformat; `setStatusLine(undefined)`
 * restores the built-in default. */
export interface EpiExtensionUIContext extends ExtensionUIContext {
    setStatusLine(format: StatusLineFormatter | undefined): void;
}
export declare function createExtensionUIContext(surface: HostSurface): EpiExtensionUIContext;
//# sourceMappingURL=ext-host.d.ts.map