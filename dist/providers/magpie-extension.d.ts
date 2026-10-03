import { type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
interface MagpieExtensionOptions {
    agentDir: string;
    /** False under --offline / MMP_OFFLINE: no catalog requests at all, only the saved list. */
    online: boolean;
    /** Look the catalog up at startup: Magpie is the selected provider, or the run lists models. */
    discover: boolean;
    /** Magpie is the selected provider, so a missing gateway is an error worth a warning. */
    required?: boolean;
    apiKey?: string;
}
/** Whether a run selects Magpie, so startup waits for its catalog. Like Pi: providers match
 * case-insensitively, and without model flags the model comes from the saved default or the
 * scoped models (`--models`, settings `enabledModels`), whose Magpie patterns need the catalog. */
export declare function selectsMagpie(flags: {
    provider?: string;
    model?: string;
    models?: string[];
}, settings: SettingsManager): boolean;
/** A bundled provider registration, not a Manifest extension or a new default-on capability. */
export declare function createMagpieInlineExtension(options: MagpieExtensionOptions): InlineExtension;
export {};
//# sourceMappingURL=magpie-extension.d.ts.map