import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
interface WebPanelOptions {
    epiHome: string;
    /** The configuration changed: the tools are registered or taken away to match. */
    onChange: () => void;
}
export declare function runWebPanel(ctx: ExtensionCommandContext | ExtensionContext, options: WebPanelOptions): Promise<void>;
export {};
//# sourceMappingURL=web-panel.d.ts.map