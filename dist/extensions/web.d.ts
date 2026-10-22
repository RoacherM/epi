import type { InlineExtension } from "@earendil-works/pi-coding-agent";
/** The extension's own version, apart from Epi's (docs/architecture.md §3.6). */
export declare const WEB_VERSION = "0.1.0";
interface WebExtensionOptions {
    epiHome: string;
}
export declare function createWebInlineExtension(options: WebExtensionOptions): InlineExtension;
export {};
//# sourceMappingURL=web.d.ts.map