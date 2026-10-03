import { type InlineExtension } from "@earendil-works/pi-coding-agent";
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
/** A bundled provider registration, not a Manifest extension or a new default-on capability. */
export declare function createMagpieInlineExtension(options: MagpieExtensionOptions): InlineExtension;
export {};
//# sourceMappingURL=magpie-extension.d.ts.map