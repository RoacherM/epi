import { type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
interface MagpieExtensionOptions {
    agentDir: string;
    /** False under --offline / MMP_OFFLINE: no catalog requests at all, only the saved list. */
    online: boolean;
    /** Look the catalog up at startup: Magpie is the selected provider, or the run lists models.
     * "if-unsaved": only when no Magpie list is saved yet (a --model that may name a Magpie model
     * without the magpie/ prefix, which Pi can then find in the list). */
    discover: boolean | "if-unsaved";
    /** Magpie is the selected provider, so a missing gateway is an error worth a warning. */
    required?: boolean;
    apiKey?: string;
}
/** A --model without a provider that names a Magpie model without the magpie/ prefix. */
export declare function mayNameMagpieModel(flags: {
    provider?: string;
    model?: string;
}): boolean;
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