import { type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, TUI } from "@earendil-works/pi-tui";
/** What the extension host may do to the screen; implemented by the app. */
export interface HostSurface {
    readonly tui: TUI;
    readonly theme: Theme;
    /** Put a component where the editor is and focus it; returns a function restoring the editor. */
    takeEditorSlot(component: Component): () => void;
    setHeader(component: Component | undefined): void;
    setFooter(component: Component | undefined): void;
    setWidget(key: string, component: Component | undefined, placement: "aboveEditor" | "belowEditor"): void;
    setStatus(key: string, text: string | undefined): void;
    setWorking(options: {
        message?: string | undefined;
        visible?: boolean | undefined;
    }): void;
    setTitle(title: string): void;
    getEditorText(): string;
    setEditorText(text: string): void;
    setAutocompleteProvider(provider: AutocompleteProvider): void;
    getAutocompleteProvider(): AutocompleteProvider;
    getToolsExpanded(): boolean;
    setToolsExpanded(expanded: boolean): void;
    notify(message: string, tone: "info" | "warning" | "error"): void;
}
export declare function createExtensionUIContext(surface: HostSurface): ExtensionUIContext;
//# sourceMappingURL=ext-host.d.ts.map